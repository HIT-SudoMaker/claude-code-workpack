import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { parse } from 'smol-toml';

import { knownTitle } from './titles.js';
import { errorCode, isObject, READ_COMMAND_TIMEOUT_MS, succeeded } from './machine.js';
import { cancelled, removeFields, sequence } from './model.js';
import type { Action, Context, Inspection, Item, Prepared, Selection } from './model.js';
import { npmInstallArgs, npmUninstallArgs, resolveNpmView } from './npm-registry.js';
import type { NpmRegistry } from './npm-registry.js';
import { freezeNpmScope, npmVersion, samePath } from './program-channels.js';

interface Observation {
  readonly version: string | null;
  readonly binary: string | null;
  readonly appearance: string | null;
  readonly fields: Record<string, unknown>;
  readonly hasCompanionPlugin: boolean;
  readonly npmProblem: string | null;
}

const PACKAGE = '@cometix/ccline';
const ASSET = fileURLToPath(new URL('../assets/ccline/config.toml', import.meta.url));
const FIELDS = ['statusLine', 'subagentStatusLine'];

/** 准备 CCometixLine 变更；计划消费与执行互斥由调用方 CCW 统一管理 */
export function createCcline(options: Context) {
  const { machine } = options;
  const binaryFile = path.join(
    options.home,
    '.claude',
    'ccline',
    options.platform === 'win32' ? 'ccline.exe' : 'ccline',
  );
  const settingsFile = options.settingsFile;
  // 保留重装中断后的接入模板，供重新准备恢复用户设置
  let resumeTemplates: Record<string, unknown> | undefined;

  function cclineDirectory(fields: Record<string, unknown>) {
    const configured = fields.cclineHome;
    const directory = typeof configured === 'string' && configured.trim() !== '' ? configured : options.cclineRoot;
    if (!path.isAbsolute(directory)) throw new Error('config-root-relative');
    return directory;
  }

  function isCcline(value: unknown) {
    if (!isObject(value) || value.type !== 'command' || typeof value.command !== 'string') return false;
    const command = value.command.trim().replaceAll('\\', '/');
    return [
      'ccline',
      'ccline.exe',
      binaryFile.replaceAll('\\', '/'),
      `"${binaryFile.replaceAll('\\', '/')}"`,
      '~/.claude/ccline/ccline',
      '~/.claude/ccline/ccline.exe',
    ].includes(command);
  }

  const packageVersion = (root?: string) => npmVersion(options, PACKAGE, root, { needsNpm: true });

  async function observe(shouldIncludeNpm: boolean, shouldIncludeFiles = shouldIncludeNpm): Promise<Observation> {
    const text = await machine.read(settingsFile);
    const settings: unknown = text === null ? {} : JSON.parse(text);
    if (!isObject(settings)) throw new Error('invalid-settings');
    const fields = {
      ...Object.fromEntries(FIELDS.map(field => [field, settings[field]])),
      cclineHome: isObject(settings.env) ? settings.env.CCLINE_HOME : undefined,
    };
    let version: string | null = null;
    let npmProblem: string | null = null;
    if (shouldIncludeNpm) {
      try {
        version = await packageVersion();
      } catch (error) {
        npmProblem = errorCode(error);
      }
    }
    return {
      version,
      npmProblem,
      binary: shouldIncludeFiles ? await machine.fingerprint(binaryFile) : null,
      appearance: shouldIncludeFiles ? await machine.read(path.join(cclineDirectory(fields), 'config.toml')) : null,
      fields,
      hasCompanionPlugin: isObject(settings.enabledPlugins) && settings.enabledPlugins['cometix@ccline'] === true,
    };
  }

  function noDowngrade(version: string | null, release: string) {
    if (version === null) return;
    const numbers = version.split('.').map(part => Number.parseInt(part, 10));
    const target = release.split('.').map(Number);
    for (let index = 0; index < 3; index++) {
      const difference = (numbers[index] ?? 0) - (target[index] ?? 0);
      if (difference > 0) throw new Error('newer-version-preserved');
      if (difference < 0) return;
    }
  }

  function validateAppearance(text: string) {
    let config: unknown;
    try {
      config = parse(text);
    } catch (error) {
      throw new Error('invalid-appearance', { cause: error });
    }
    if (!isObject(config) || config.version !== 2) throw new Error('appearance-migration-required');
  }

  function connectionChange(observed: Observation, shouldConnect: boolean, templates?: Record<string, unknown>) {
    const selected = shouldConnect
      ? ['statusLine', ...(isCcline(templates?.subagentStatusLine) ? ['subagentStatusLine'] : [])]
      : FIELDS.filter(field => isCcline(observed.fields[field]));
    const before = Object.fromEntries(selected.map(field => [field, observed.fields[field]]));
    const cclineHome = observed.fields.cclineHome;
    const appearanceRoot = shouldConnect ? cclineDirectory(observed.fields) : undefined;
    const shouldConfigureHome =
      appearanceRoot !== undefined && appearanceRoot !== path.join(options.home, '.claude', 'ccline');
    const values = Object.fromEntries(
      selected.map(field => {
        const template = templates?.[field];
        const previous = isObject(template) ? template : isObject(before[field]) ? before[field] : {};
        return [
          field,
          shouldConnect
            ? {
                ...previous,
                type: 'command',
                command: 'ccline',
                padding: typeof previous.padding === 'number' ? previous.padding : 0,
              }
            : undefined,
        ];
      }),
    );
    let isWritten = false;
    const verify = async () => {
      if (!selected.length) return;
      const after = await machine.read(settingsFile);
      const value: unknown = after === null ? {} : JSON.parse(after);
      if (
        !isObject(value) ||
        selected.some(field =>
          shouldConnect ? !isDeepStrictEqual(value[field], values[field]) : isCcline(value[field]),
        )
      )
        throw new Error('connection-not-applied');
      if (
        shouldConnect &&
        !isDeepStrictEqual(
          isObject(value.env) ? value.env.CCLINE_HOME : undefined,
          shouldConfigureHome ? appearanceRoot : cclineHome,
        )
      )
        throw new Error('connection-changed');
    };
    return {
      get isWritten() {
        return isWritten;
      },
      verify,
      async run(written: (hasChanged: boolean) => void) {
        if (!isWritten) {
          if (selected.length)
            await machine.editJson(settingsFile, settings => {
              if (shouldConnect) {
                const environment = settings.env === undefined ? {} : settings.env;
                if (!isObject(environment)) throw new Error('invalid-settings');
                if (!isDeepStrictEqual(environment.CCLINE_HOME, cclineHome)) throw new Error('connection-changed');
                if (shouldConfigureHome) settings.env = { ...environment, CCLINE_HOME: appearanceRoot };
              }
              for (const field of selected) {
                if (!isDeepStrictEqual(settings[field], before[field])) throw new Error('connection-changed');
                if (shouldConnect) settings[field] = values[field];
                else delete settings[field];
              }
            });
          isWritten = true;
          written(selected.length > 0);
        }
        await verify();
      },
    };
  }

  async function binaryAtHome() {
    const canonical = await machine.realpath(binaryFile);
    return canonical !== null && samePath(options, canonical, binaryFile);
  }

  async function recognizedBinary(stamp: string | null) {
    if (stamp === null || !(await binaryAtHome())) return false;
    try {
      const result = await machine.execute(binaryFile, ['--version'], { timeoutMs: READ_COMMAND_TIMEOUT_MS });
      return (
        succeeded(result) && /^(?:ccline|ccometixline) \d+\.\d+\.\d+(?:[-+][\w.-]+)?\s*$/i.test(result.stdout.trim())
      );
    } catch {
      return false;
    }
  }

  async function prepareUninstall(): Promise<Prepared> {
    let observed: Observation;
    let programProblem: string | null;
    let hasFileObservation = true;
    try {
      observed = await observe(true);
      programProblem = observed.npmProblem;
    } catch (error) {
      observed = await observe(false, false);
      programProblem = errorCode(error);
      hasFileObservation = false;
    }
    const shouldRemoveBinary = await recognizedBinary(observed.binary);
    if (observed.version === null && !shouldRemoveBinary && !FIELDS.some(field => isCcline(observed.fields[field])))
      throw new Error(
        programProblem ?? (observed.binary === null ? 'program-not-installed' : 'manual-program-preserved'),
      );
    const npmScope = observed.version === null ? null : await freezeNpmScope(options);
    const disconnection = connectionChange(observed, false);
    let isDetached = false;
    // 尝试证据与删除进度是正交事实：npm 命令可能连带删除二进制，包确认删除后因果证据仍被消费
    let hasAttemptedPackageRemoval = false;
    let isPackageRemoved = observed.version === null;
    let hasAttemptedBinaryRemoval = false;
    let isBinaryRemoved = !shouldRemoveBinary;
    let isComplete = false;
    const changes = () => [
      ...(!isDetached && FIELDS.some(field => isCcline(observed.fields[field]))
        ? [{ code: 'ccline-disconnect-before-uninstall', detail: settingsFile }]
        : []),
      ...(!isPackageRemoved ? [{ code: 'program-uninstall', detail: `CCometixLine · npm · ${observed.version}` }] : []),
      ...(!isBinaryRemoved
        ? [{ code: 'program-uninstall', detail: binaryFile }]
        : !shouldRemoveBinary && observed.binary !== null
          ? [{ code: 'unrecognized-program-kept', detail: binaryFile }]
          : []),
      ...(programProblem !== null
        ? [
            {
              code: programProblem === 'npm-not-found' ? 'npm-not-found' : 'program-removal-unconfirmed',
              detail: programProblem,
            },
          ]
        : observed.version === null && !shouldRemoveBinary
          ? [{ code: 'program-not-installed' }]
          : []),
      { code: 'keep-user-data' },
      { code: 'appearance-kept' },
      ...(observed.hasCompanionPlugin ? [{ code: 'ccline-companion-kept', detail: 'cometix@ccline' }] : []),
    ];
    async function verifyPackage(expected: string | null) {
      await npmScope?.verify();
      if ((await packageVersion(npmScope?.npmRoot)) !== expected) throw new Error('program-changed');
    }
    async function verifyConnection() {
      const current = await observe(false, false);
      for (const field of FIELDS) {
        if (
          isDetached
            ? isCcline(current.fields[field])
            : isCcline(observed.fields[field])
              ? !isDeepStrictEqual(current.fields[field], observed.fields[field])
              : isCcline(current.fields[field])
        )
          throw new Error('connection-changed');
      }
    }
    async function verifyRemoved() {
      await verifyConnection();
      if (observed.version !== null) await verifyPackage(null);
      if (shouldRemoveBinary && (await machine.fingerprint(binaryFile)) !== null) throw new Error('program-changed');
    }
    const operation: Prepared = {
      get changes() {
        return changes();
      },
      async run(report, signal) {
        cancelled(signal);
        await verifyConnection();
        if (hasAttemptedPackageRemoval && !isPackageRemoved) {
          await npmScope?.verify();
          const current = await packageVersion(npmScope?.npmRoot);
          if (current === null) {
            isPackageRemoved = true;
            report({ state: 'done', code: 'package-removed', detail: PACKAGE });
          } else if (current !== observed.version) throw new Error('program-changed');
        }
        if (!isPackageRemoved) await verifyPackage(observed.version);
        else if (observed.version !== null) await verifyPackage(null);
        if (hasFileObservation) {
          const current = await machine.fingerprint(binaryFile);
          if (
            (hasAttemptedPackageRemoval || hasAttemptedBinaryRemoval) &&
            shouldRemoveBinary &&
            !isBinaryRemoved &&
            current === null
          ) {
            isBinaryRemoved = true;
            report({ state: 'done', code: 'program-removed', detail: binaryFile });
          } else if (current !== (isBinaryRemoved && shouldRemoveBinary ? null : observed.binary))
            throw new Error('program-changed');
          if (shouldRemoveBinary && !isBinaryRemoved && !(await binaryAtHome())) throw new Error('program-changed');
        }
        if (!isDetached) {
          await disconnection.run(hasChanged => {
            isDetached = true;
            resumeTemplates = undefined;
            report({ state: hasChanged ? 'done' : 'kept', code: hasChanged ? 'disconnected' : 'no-connection' });
          });
        }
        cancelled(signal);
        if (!isPackageRemoved) {
          await verifyConnection();
          if (
            (await machine.fingerprint(binaryFile)) !== observed.binary ||
            (shouldRemoveBinary && !(await binaryAtHome()))
          )
            throw new Error('program-changed');
          hasAttemptedPackageRemoval = true;
          const result = await machine.npm(
            npmUninstallArgs(['uninstall', '-g', ...(npmScope?.args ?? []), '--ignore-scripts', PACKAGE]),
          );
          let after: string | null;
          try {
            await npmScope?.verify();
            after = await packageVersion(npmScope?.npmRoot);
          } catch (error) {
            throw new Error('program-removal-unconfirmed', { cause: error });
          }
          if (after !== null) throw new Error(succeeded(result) ? 'program-still-installed' : 'npm-uninstall-failed');
          isPackageRemoved = true;
          report({ state: 'done', code: 'package-removed', detail: PACKAGE });
          if (shouldRemoveBinary && (await machine.fingerprint(binaryFile)) === null) {
            isBinaryRemoved = true;
            report({ state: 'done', code: 'program-removed', detail: binaryFile });
          }
        }
        cancelled(signal);
        if (!isBinaryRemoved) {
          await verifyConnection();
          if (observed.binary === null) throw new Error('program-changed');
          hasAttemptedBinaryRemoval = true;
          try {
            await machine.remove(binaryFile, observed.binary);
          } catch (error) {
            if ((await machine.fingerprint(binaryFile)) !== null) throw error;
          }
          if ((await machine.fingerprint(binaryFile)) !== null) throw new Error('program-removal-unconfirmed');
          isBinaryRemoved = true;
          report({ state: 'done', code: 'program-removed', detail: binaryFile });
        }
        cancelled(signal);
        await verifyRemoved();
        if (programProblem === 'npm-not-found') report({ state: 'kept', code: 'npm-not-found' });
        else if (
          programProblem === null &&
          observed.version === null &&
          !shouldRemoveBinary &&
          observed.binary === null
        )
          report({ state: 'kept', code: 'program-not-installed' });
        if (observed.binary !== null && !shouldRemoveBinary)
          report({ state: 'kept', code: 'unrecognized-program-kept', detail: binaryFile });
        const copies = [];
        for (const file of await machine.locate('ccline'))
          if ((await machine.realpath(file)) !== null) copies.push(file);
        if (copies.length) report({ state: 'kept', code: 'program-other-copies-kept', detail: copies.join('\n') });
        report({ state: 'kept', code: 'appearance-kept' });
        report({ state: 'kept', code: 'keep-user-data' });
        isComplete = true;
        if (programProblem !== null && programProblem !== 'npm-not-found') {
          report({ state: 'failed', code: 'program-removal-unconfirmed', detail: programProblem });
          throw new Error('program-removal-unconfirmed');
        }
      },
      remaining: () => (isComplete ? undefined : operation),
      verify: verifyRemoved,
    };
    return operation;
  }

  async function inspectItem(): Promise<Item> {
    let observed: Observation | null = null;
    try {
      observed = await observe(false, false);
      observed = await observe(true);
      const isConnected = FIELDS.some(field => isCcline(observed?.fields[field]));
      let problem: string | undefined = observed.npmProblem ?? undefined;
      if (observed.appearance !== null) {
        try {
          validateAppearance(observed.appearance);
        } catch (error) {
          problem = errorCode(error);
        }
      }
      const actions: Action[] = observed.binary !== null ? ['connect'] : ['install'];
      if (observed.binary !== null && observed.npmProblem === null) actions.push('update', 'reinstall');
      if (isConnected) actions.push('detach');
      if (observed.version !== null || (await recognizedBinary(observed.binary))) actions.push('uninstall');
      return {
        id: 'ccline',
        title: knownTitle('ccline'),
        kind: 'ccline',
        canInstall: true,
        ...(problem ? { problem } : {}),
        facts: [
          {
            code:
              observed.binary !== null
                ? 'program-exists'
                : observed.npmProblem !== null
                  ? 'program-inspection-warning'
                  : 'not-installed',
            ...(observed.version ? { detail: observed.version } : {}),
          },
          { code: isConnected ? 'connected' : 'not-connected' },
          { code: observed.appearance !== null ? 'appearance-kept' : 'appearance-missing' },
        ],
        actions,
      };
    } catch (error) {
      return {
        id: 'ccline',
        title: knownTitle('ccline'),
        kind: 'ccline',
        canInstall: true,
        facts: [],
        actions: ['install', ...(FIELDS.some(field => isCcline(observed?.fields[field])) ? (['detach'] as const) : [])],
        problem: errorCode(error),
      };
    }
  }

  return {
    async inspect(): Promise<Inspection> {
      return { items: [await inspectItem()], problems: [] };
    },
    async prepare(selection: Selection): Promise<Prepared> {
      if (selection.id !== 'ccline') throw new Error('unknown-selection');
      let action = selection.action;
      if (action === 'uninstall') return prepareUninstall();
      if (action === 'install' && (await machine.fingerprint(binaryFile)) !== null) action = 'connect';
      if (
        action !== 'install' &&
        action !== 'connect' &&
        action !== 'update' &&
        action !== 'reinstall' &&
        action !== 'detach'
      )
        throw new Error('action-unavailable');
      let release = '2.0.1';
      let releaseRegistry: NpmRegistry = null;
      const observed = await observe(action !== 'detach' && action !== 'connect', action !== 'detach');
      if (observed.npmProblem !== null) throw new Error(observed.npmProblem);
      if (action === 'detach' && !FIELDS.some(field => isCcline(observed.fields[field])))
        throw new Error('no-connection');
      if (action === 'detach') {
        resumeTemplates = undefined;
        return removeFields(
          options,
          settingsFile,
          Object.fromEntries(
            FIELDS.filter(field => isCcline(observed.fields[field])).map(field => [field, observed.fields[field]]),
          ),
          [{ code: 'ccline-detach', detail: settingsFile }, { code: 'appearance-kept' }],
          { state: 'done', code: 'disconnected' },
        );
      }
      const npmScope = action === 'connect' ? null : await freezeNpmScope(options);
      if (npmScope !== null && (await packageVersion(npmScope.npmRoot)) !== observed.version)
        throw new Error('program-changed');
      if (action !== 'connect') {
        const resolved = await resolveNpmView(machine, `${PACKAGE}@latest`, 'version', value =>
          typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value : null,
        );
        if (resolved === null) throw new Error('source-unavailable');
        release = resolved.value;
        if (!/^2\.\d+\.\d+$/.test(release)) throw new Error('unsupported-ccline-release');
        releaseRegistry = resolved.registry;
        noDowngrade(observed.version, release);
      }
      if (observed.appearance !== null) validateAppearance(observed.appearance);
      if (action === 'update' && observed.version === null) throw new Error('npm-package-missing');
      if ((action === 'install' || action === 'reinstall') && observed.binary !== null && observed.version === null)
        throw new Error('manual-program-preserved');
      if (action === 'connect' && observed.binary === null) throw new Error('program-not-ready');
      const shouldRestoreSubagent =
        isCcline(resumeTemplates?.subagentStatusLine) ||
        (action === 'reinstall' && isCcline(observed.fields.subagentStatusLine));
      const connectionTemplates = {
        ...resumeTemplates,
        ...Object.fromEntries(Object.entries(observed.fields).filter(([, value]) => value !== undefined)),
      };
      const disconnection = action === 'reinstall' ? connectionChange(observed, false) : undefined;
      let isCommandCompleted = false;
      let commandStamp: string | null | undefined;
      let programStamp = observed.binary;
      const program: Prepared = {
        get changes() {
          return [
            action === 'connect'
              ? { code: 'ccline-program-kept', detail: binaryFile }
              : isCommandCompleted
                ? { code: 'program-installation-confirm', detail: binaryFile }
                : { code: action === 'update' ? 'ccline-program-update' : 'ccline-program-prepare', detail: release },
            ...(disconnection && !disconnection.isWritten
              ? [{ code: 'ccline-reinstall-connection', detail: settingsFile }]
              : []),
          ];
        },
        async run(report, signal) {
          cancelled(signal);
          await npmScope?.verify();
          if (isCommandCompleted) {
            if (commandStamp === undefined) throw new Error('program-installation-unconfirmed');
            if ((await machine.fingerprint(binaryFile)) !== commandStamp) throw new Error('program-changed');
          } else if (
            (action !== 'connect' && (await packageVersion(npmScope?.npmRoot)) !== observed.version) ||
            (await machine.fingerprint(binaryFile)) !== observed.binary
          )
            throw new Error('program-changed');
          if (!isCommandCompleted && disconnection)
            await disconnection.run(hasChanged => {
              resumeTemplates = connectionTemplates;
              for (const field of FIELDS) if (isCcline(observed.fields[field])) observed.fields[field] = undefined;
              report({ state: hasChanged ? 'done' : 'kept', code: hasChanged ? 'disconnected' : 'no-connection' });
            });
          cancelled(signal);
          if (
            !isCommandCompleted &&
            action !== 'connect' &&
            (action === 'reinstall' || action === 'update' || observed.version !== release || observed.binary === null)
          ) {
            const args = npmInstallArgs(
              [
                'install',
                '-g',
                ...(npmScope?.args ?? []),
                ...(action === 'reinstall' ? ['--force'] : []),
                '--ignore-scripts=false',
                `${PACKAGE}@${release}`,
              ],
              releaseRegistry,
            );
            const installed = await machine.npm(args);
            if (!succeeded(installed)) throw new Error('npm-install-failed');
            isCommandCompleted = true;
            report({ state: 'done', code: 'package-command-completed' });
            try {
              commandStamp = await machine.fingerprint(binaryFile);
            } catch (error) {
              throw new Error('program-installation-unconfirmed', { cause: error });
            }
          }
          await npmScope?.verify();
          if (
            (action !== 'connect' && (await packageVersion(npmScope?.npmRoot)) !== release) ||
            (await machine.fingerprint(binaryFile)) === null
          )
            throw new Error('program-not-ready');
          const versionSignal = signal?.aborted ? undefined : signal;
          const version = await machine.execute(binaryFile, ['--version'], {
            timeoutMs: READ_COMMAND_TIMEOUT_MS,
            ...(versionSignal ? { signal: versionSignal } : {}),
          });
          if (versionSignal?.aborted) cancelled(signal);
          const binaryVersion = /^(?:ccline|ccometixline) (2\.\d+\.\d+)\s*$/i.exec(version.stdout.trim())?.[1];
          if (!succeeded(version) || binaryVersion === undefined || (action !== 'connect' && binaryVersion !== release))
            throw new Error('binary-version-mismatch');
          programStamp = await machine.fingerprint(binaryFile);
          report({ state: 'done', code: 'program-ready' });
        },
        async verify() {
          await npmScope?.verify();
          if ((await machine.fingerprint(binaryFile)) !== programStamp) throw new Error('program-changed');
        },
      };
      const operations: Prepared[] = [program];
      if (action === 'update')
        operations.push({
          changes: [{ code: 'ccline-settings-kept' }],
          run: report => Promise.resolve(report({ state: 'kept', code: 'appearance-kept' })),
        });
      else {
        const styleFile = path.join(cclineDirectory(observed.fields), 'config.toml');
        let appearanceText = observed.appearance;
        let isAppearanceWritten = false;
        const verifyAppearance = async () => {
          if ((await machine.read(styleFile)) !== appearanceText) throw new Error('appearance-changed');
        };
        operations.push({
          changes: [
            observed.appearance === null ? { code: 'appearance-copy', detail: styleFile } : { code: 'appearance-kept' },
          ],
          async run(report) {
            const existing = await machine.read(styleFile);
            if (existing !== (isAppearanceWritten ? appearanceText : observed.appearance))
              throw new Error('appearance-changed');
            if (existing === null) {
              const asset = await machine.read(ASSET);
              if (asset === null) throw new Error('asset-missing');
              validateAppearance(asset);
              if (!(await machine.initialize(styleFile, asset))) throw new Error('appearance-changed');
              isAppearanceWritten = true;
              appearanceText = asset;
              report({ state: 'done', code: 'appearance-copied' });
            } else if (!isAppearanceWritten) report({ state: 'kept', code: 'appearance-kept' });
            await verifyAppearance();
          },
          verify: verifyAppearance,
        });
        let connection: ReturnType<typeof connectionChange> | undefined;
        operations.push({
          changes: [
            ...(shouldRestoreSubagent ? [{ code: 'ccline-subagent-restore', detail: settingsFile }] : []),
            {
              code:
                observed.fields.statusLine !== undefined && !isCcline(observed.fields.statusLine)
                  ? 'ccline-statusline-replace'
                  : 'ccline-connect',
              detail: settingsFile,
            },
            ...(cclineDirectory(observed.fields) !== path.join(options.home, '.claude', 'ccline')
              ? [{ code: 'ccline-root-configure', detail: cclineDirectory(observed.fields) }]
              : []),
          ],
          async run(report) {
            connection ??= connectionChange(observed, true, connectionTemplates);
            await connection.run(() => report({ state: 'done', code: 'connected' }));
            resumeTemplates = undefined;
          },
          async verify() {
            await connection?.verify();
          },
        });
      }
      const steps = sequence(operations);
      const operation: Prepared = {
        ...steps,
        get changes() {
          return steps.changes;
        },
        remaining: () =>
          isCommandCompleted && commandStamp === undefined ? undefined : steps.remaining?.() ? operation : undefined,
      };
      return operation;
    },
  };
}
