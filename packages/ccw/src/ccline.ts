import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';

import { knownTitle } from './titles.js';
import { applyFrozenJson, assessFrozenJson } from './frozen-json.js';
import { ENABLED_PLUGINS_KEY } from './claude-config.js';
import { errorCode, isObject, READ_COMMAND_TIMEOUT_MS, succeeded } from './machine.js';
import { cancelled, commandReceipt, json } from './model.js';
import type {
  Action,
  Change,
  Context,
  Domain,
  Inspection,
  Item,
  Prepared,
  Selection,
  JsonObject,
  Json,
  OperationDefinition,
  OperationFact,
  OperationHandler,
} from './model.js';
import {
  isExactVersion,
  NPM_ENABLE_SCRIPTS,
  npmInstallArgs,
  npmUninstallArgs,
  resolveNpmView,
} from './npm-registry.js';
import type { NpmRegistry } from './npm-registry.js';
import { compareVersions } from './programs.js';
import { freezeNpmScope, npmVersion, samePath, verifyNpmScope } from './program-channels.js';
import type { FrozenNpmScope } from './program-channels.js';

interface Observation {
  readonly version: string | null;
  readonly binary: string | null;
  readonly appearance: string | null;
  readonly fields: Record<string, unknown>;
  readonly hasCompanionPlugin: boolean;
  readonly npmProblem: string | null;
}
interface ConnectionPayload {
  readonly selected: readonly string[];
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
  readonly homeBefore: unknown;
  readonly homeAfter: unknown;
  readonly configureHome: boolean;
  readonly shouldConnect: boolean;
  readonly successor: string | null;
}
interface PackagePayload {
  readonly scope: FrozenNpmScope | null;
  readonly before: string | null;
  readonly target: string | null;
  readonly binary: string | null;
  readonly action: string;
  readonly registry: NpmRegistry;
  readonly mutate: boolean;
  readonly removed: boolean;
}
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const strings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(entry => typeof entry === 'string');
function isScope(value: unknown): value is FrozenNpmScope {
  return (
    isObject(value) &&
    typeof value.npmRoot === 'string' &&
    typeof value.canonical === 'string' &&
    strings(value.args) &&
    isObject(value.identity) &&
    typeof value.identity.entry === 'string' &&
    typeof value.identity.binary === 'string' &&
    typeof value.identity.stamp === 'string'
  );
}
function scopeOf(definition: OperationDefinition): FrozenNpmScope | null {
  const value = definition.payload.scope;
  if (value === null || isScope(value)) return value;
  throw new Error('operation-record-invalid');
}
function connectionPayload(definition: OperationDefinition): ConnectionPayload {
  const value = definition.payload;
  const valid = (value: unknown): value is ConnectionPayload =>
    isObject(value) &&
    strings(value.selected) &&
    isObject(value.before) &&
    isObject(value.after) &&
    typeof value.configureHome === 'boolean' &&
    typeof value.shouldConnect === 'boolean' &&
    nullableString(value.successor) &&
    Object.hasOwn(value, 'homeBefore') &&
    Object.hasOwn(value, 'homeAfter');
  if (!valid(value)) throw new Error('operation-record-invalid');
  return value;
}
function packagePayload(definition: OperationDefinition): PackagePayload {
  const value = definition.payload;
  const valid = (value: unknown): value is PackagePayload =>
    isObject(value) &&
    (value.scope === null || isScope(value.scope)) &&
    nullableString(value.before) &&
    nullableString(value.target) &&
    nullableString(value.binary) &&
    typeof value.action === 'string' &&
    nullableString(value.registry) &&
    typeof value.mutate === 'boolean' &&
    typeof value.removed === 'boolean';
  if (!valid(value)) throw new Error('operation-record-invalid');
  return value;
}
function textField(payload: JsonObject, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string') throw new Error('operation-record-invalid');
  return value;
}
function jsonValue(value: unknown): Json {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]));
  throw new Error('operation-record-invalid');
}
function serial(value: unknown): JsonObject {
  const encoded: unknown = JSON.parse(JSON.stringify(value));
  if (!isObject(encoded)) throw new Error('operation-record-invalid');
  return Object.fromEntries(Object.entries(encoded).map(([key, child]) => [key, jsonValue(child)]));
}

const PACKAGE = '@cometix/ccline';
const ASSET = fileURLToPath(new URL('../assets/ccline/config.toml', import.meta.url));
const FIELDS = ['statusLine', 'subagentStatusLine'];
const COMPANION_PLUGIN = 'cometix@ccline';
/** ccline --version 输出形状：身份探测允许预发布后缀，执行确认要求精确 2.x.y */
const CCLINE_IDENTITY = /^(?:ccline|ccometixline) \d+\.\d+\.\d+(?:[-+][\w.-]+)?\s*$/i;
const CCLINE_BINARY_VERSION = /^(?:ccline|ccometixline) (2\.\d+\.\d+)\s*$/i;

/** 准备 CCometixLine 变更；计划消费与执行互斥由调用方 CCW 统一管理 */
export function createCcline(options: Context): Domain {
  const { machine, effects } = options;
  /** ccline 固定落点：不受 CCLINE_HOME 影响 */
  const defaultCclineDirectory = path.join(options.home, '.claude', 'ccline');
  const binaryFile = path.join(defaultCclineDirectory, options.platform === 'win32' ? 'ccline.exe' : 'ccline');
  const settingsFile = options.settingsFile;

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
    const settings = await json(machine, settingsFile);
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
      hasCompanionPlugin:
        isObject(settings[ENABLED_PLUGINS_KEY]) && settings[ENABLED_PLUGINS_KEY][COMPANION_PLUGIN] === true,
    };
  }

  function noDowngrade(version: string | null, release: string) {
    if (version === null) return;
    if (compareVersions(version, release) > 0) throw new Error('newer-version-preserved');
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

  async function binaryAtHome() {
    const canonical = await machine.realpath(binaryFile);
    return canonical !== null && samePath(options, canonical, binaryFile);
  }

  async function recognizedBinary(stamp: string | null) {
    if (stamp === null || !(await binaryAtHome())) return false;
    try {
      const result = await machine.execute(binaryFile, ['--version'], { timeoutMs: READ_COMMAND_TIMEOUT_MS });
      return succeeded(result) && CCLINE_IDENTITY.test(result.stdout.trim());
    } catch {
      return false;
    }
  }

  const define = (
    suffix: string,
    handler: string,
    payload: JsonObject,
    changes: readonly Change[] = [],
    dependsOn: readonly string[] = [],
  ): OperationDefinition => ({
    id: 'ccline/' + suffix,
    itemId: 'ccline',
    handler,
    payload,
    changes,
    dependsOn,
    writes:
      handler === 'ccline.connection'
        ? [settingsFile]
        : typeof payload.file === 'string'
          ? [payload.file]
          : [binaryFile],
  });
  const fieldsAt = async () => (await observe(false, false)).fields;
  function connectionDefinition(
    observed: Observation,
    shouldConnect: boolean,
    templates: Record<string, unknown>,
    suffix: string,
    dependsOn: readonly string[],
    successor: string | null = null,
    changes: readonly Change[] = [],
  ) {
    const selected = shouldConnect
      ? ['statusLine', ...(isCcline(templates.subagentStatusLine) ? ['subagentStatusLine'] : [])]
      : FIELDS.filter(field => isCcline(observed.fields[field]));
    const before = Object.fromEntries(
      selected.filter(field => observed.fields[field] !== undefined).map(field => [field, observed.fields[field]]),
    );
    const after = shouldConnect
      ? Object.fromEntries(
          selected.map(field => {
            const previous = isObject(templates[field]) ? templates[field] : {};
            return [
              field,
              {
                ...previous,
                type: 'command',
                command: 'ccline',
                padding: typeof previous.padding === 'number' ? previous.padding : 0,
              },
            ];
          }),
        )
      : {};
    const homeBefore = observed.fields.cclineHome ?? null;
    const configureHome = shouldConnect && !samePath(options, cclineDirectory(templates), defaultCclineDirectory);
    const homeAfter = configureHome ? cclineDirectory(templates) : homeBefore;
    return define(
      suffix,
      'ccline.connection',
      serial({
        selected,
        before,
        after,
        homeBefore,
        homeAfter,
        configureHome,
        shouldConnect,
        successor,
      }),
      changes,
      dependsOn,
    );
  }
  const knownFailure = (fact: OperationFact) => fact.receipt?.kind === 'returned' && fact.receipt.failure !== null;
  const pendingOrFailed = (fact: OperationFact) => !fact.attemptId || knownFailure(fact);
  const handlers: Readonly<Record<string, OperationHandler>> = {
    'ccline.connection': {
      async assess(definition, fact, facts) {
        const p = connectionPayload(definition);
        const current = await fieldsAt();
        if (!p.shouldConnect && p.successor && fact.confirmed && facts[p.successor]?.attemptId)
          return { state: 'complete', evidence: { superseded: true } };
        const fields = p.selected.map(field => ({
          path: [field],
          before: { oneOf: [p.before[field]] },
          after: {
            oneOf: [
              p.after[field],
              ...(!p.shouldConnect && fact.confirmed && !isCcline(current[field]) ? [current[field]] : []),
            ],
          },
        }));
        if (p.shouldConnect)
          fields.push({ path: ['cclineHome'], before: { oneOf: [p.homeBefore] }, after: { oneOf: [p.homeAfter] } });
        const assessment = assessFrozenJson(
          { ...current, cclineHome: current.cclineHome ?? null },
          fields,
          fact,
          'connection-changed',
        );
        return assessment.state === 'complete'
          ? {
              ...assessment,
              effects: [
                {
                  state: p.selected.length ? 'done' : 'kept',
                  code: p.shouldConnect ? 'connected' : p.selected.length ? 'disconnected' : 'no-connection',
                },
              ],
            }
          : assessment;
      },
      async execute(definition) {
        const p = connectionPayload(definition);
        await effects.editJson(settingsFile, settings => {
          if (p.shouldConnect) {
            const env = settings.env === undefined ? {} : settings.env;
            if (!isObject(env)) throw new Error('invalid-settings');
            if (!isDeepStrictEqual(env.CCLINE_HOME ?? null, p.homeBefore)) throw new Error('connection-changed');
            if (p.configureHome) settings.env = { ...env, CCLINE_HOME: p.homeAfter };
          }
          applyFrozenJson(
            settings,
            p.selected.map(field => ({
              path: [field],
              before: { oneOf: [p.before[field]] },
              value: p.after[field],
            })),
            'connection-changed',
          );
        });
        return { receipt: { kind: 'returned', failure: null } };
      },
    },
    'ccline.package': {
      async assess(definition, fact) {
        const p = packagePayload(definition);
        if (p.scope) await verifyNpmScope(options, p.scope);
        let version: string | null;
        let binary: string | null;
        try {
          version = await packageVersion(p.scope?.npmRoot);
          binary = await machine.fingerprint(binaryFile);
        } catch (error) {
          throw new Error(p.removed ? 'program-removal-unconfirmed' : 'program-installation-unconfirmed', {
            cause: error,
          });
        }
        if (p.removed && version === null)
          return {
            state: 'complete',
            evidence: { absent: true },
            effects: [{ state: 'done', code: 'package-removed', detail: PACKAGE }],
          };
        if (!p.removed && !p.mutate) {
          if (version !== p.target || binary !== p.binary) throw new Error('program-changed');
          return { state: 'complete', evidence: { binary, reused: true } };
        }
        if (!p.removed && fact.receipt?.kind === 'returned' && fact.receipt.failure === null) {
          if (fact.evidence?.binary === undefined)
            return { state: 'unknown', problem: 'program-installation-unconfirmed' };
          if (binary !== fact.evidence.binary) throw new Error('program-changed');
          if (version !== p.target || binary === null) throw new Error('program-not-ready');
          return {
            state: 'complete',
            evidence: { binary },
            effects: [{ state: 'done', code: 'package-command-completed' }],
          };
        }
        if (fact.confirmed) return { state: 'unknown', problem: 'program-changed' };
        if (version !== p.before || binary !== p.binary)
          return { state: 'unknown', problem: p.removed ? 'program-changed' : 'program-installation-unconfirmed' };
        if (!pendingOrFailed(fact))
          return {
            state: 'unknown',
            problem: p.removed ? 'program-removal-unconfirmed' : 'program-installation-unconfirmed',
          };
        return { state: 'ready', dispatch: { binary, version } };
      },
      async execute(definition, _fact, _inputs, signal) {
        const p = packagePayload(definition);
        cancelled(signal);
        if (p.scope) await verifyNpmScope(options, p.scope);
        if (
          (await packageVersion(p.scope?.npmRoot)) !== p.before ||
          (await machine.fingerprint(binaryFile)) !== p.binary
        )
          throw new Error('program-changed');
        const args = p.removed
          ? npmUninstallArgs(['uninstall', '-g', ...(p.scope?.args ?? []), '--ignore-scripts', PACKAGE])
          : npmInstallArgs(
              [
                'install',
                '-g',
                ...(p.scope?.args ?? []),
                ...(p.action === 'reinstall' ? ['--force'] : []),
                ...NPM_ENABLE_SCRIPTS,
                PACKAGE + '@' + p.target,
              ],
              p.registry,
            );
        const result = await effects.npm(args);
        const failure = p.removed ? 'npm-uninstall-failed' : 'npm-install-failed';
        const receipt = commandReceipt(result, failure);
        const completed =
          !p.removed && succeeded(result) ? [{ state: 'done' as const, code: 'package-command-completed' }] : [];
        try {
          return { receipt, evidence: { binary: await machine.fingerprint(binaryFile) }, effects: completed };
        } catch {
          return { receipt, effects: completed };
        }
      },
    },
    'ccline.appearance': {
      async assess(definition, fact) {
        if (definition.payload.preserve)
          return {
            state: 'complete',
            evidence: { preserved: true },
            effects: [{ state: 'kept', code: 'appearance-kept' }],
          };
        const p = definition.payload;
        const file = textField(p, 'file');
        const after = textField(p, 'after');
        const current = await machine.read(file);
        if (current === after)
          return {
            state: 'complete',
            evidence: { matched: true },
            effects: [
              {
                state: p.before === null ? 'done' : 'kept',
                code: p.before === null ? 'appearance-copied' : 'appearance-kept',
              },
            ],
          };
        if (fact.confirmed || current !== p.before) return { state: 'unknown', problem: 'appearance-changed' };
        return { state: 'ready' };
      },
      async execute(definition) {
        const p = definition.payload;
        if (!(await effects.initialize(textField(p, 'file'), textField(p, 'after'))))
          throw new Error('appearance-changed');
        return { receipt: { kind: 'returned', failure: null } };
      },
    },
    'ccline.binary-remove': {
      async assess(definition, fact) {
        const current = await machine.fingerprint(binaryFile);
        if (current === null)
          return {
            state: 'complete',
            evidence: { absent: true },
            effects: [{ state: 'done', code: 'program-removed', detail: binaryFile }],
          };
        if (fact.confirmed || current !== definition.payload.binary || !(await binaryAtHome()))
          return { state: 'unknown', problem: 'program-changed' };
        if (!pendingOrFailed(fact)) return { state: 'unknown', problem: 'program-removal-unconfirmed' };
        return { state: 'ready' };
      },
      async execute(definition) {
        if (!(await binaryAtHome())) throw new Error('program-changed');
        await effects.remove(binaryFile, textField(definition.payload, 'binary'));
        return { receipt: { kind: 'returned', failure: null } };
      },
    },
    'ccline.uninstall-guard': {
      async assess(definition, fact, facts) {
        const p = definition.payload;
        if (fact.confirmed && (facts['ccline/package']?.attemptId || facts['ccline/binary-remove']?.attemptId))
          return { state: 'complete', evidence: { superseded: true } };
        const scope = scopeOf(definition);
        if (scope) await verifyNpmScope(options, scope);
        if (scope && (await packageVersion(scope.npmRoot)) !== p.version) throw new Error('program-changed');
        if (p.hasFileObservation && (await machine.fingerprint(binaryFile)) !== p.binary)
          throw new Error('program-changed');
        return {
          state: 'complete',
          evidence: { matched: true },
          effects: [
            { state: 'kept', code: 'appearance-kept' },
            { state: 'kept', code: 'keep-user-data' },
            ...(p.binary !== null && !p.removeBinary
              ? [{ state: 'kept' as const, code: 'unrecognized-program-kept', detail: binaryFile }]
              : []),
          ],
        };
      },
      execute: () => Promise.reject(new Error('read-only-operation')),
    },
    'ccline.program-ready': {
      async assess(definition, _fact, facts) {
        const p = definition.payload;
        const scope = scopeOf(definition);
        if (scope) await verifyNpmScope(options, scope);
        const binary = await machine.fingerprint(binaryFile);
        if (p.removed) {
          if (scope && (await packageVersion(scope.npmRoot)) !== null) throw new Error('program-still-installed');
          if (p.removeBinary && binary !== null) throw new Error('program-changed');
          const current = await fieldsAt();
          if (FIELDS.some(field => isCcline(current[field]))) throw new Error('connection-changed');
          if (p.problem !== null && p.problem !== 'npm-not-found') throw new Error('program-removal-unconfirmed');
          const copies = [];
          for (const file of await machine.locate('ccline'))
            if ((await machine.realpath(file)) !== null) copies.push(file);
          return {
            state: 'complete',
            evidence: { absent: true },
            effects: [
              { state: 'kept', code: 'appearance-kept' },
              { state: 'kept', code: 'keep-user-data' },
              ...(p.problem === 'npm-not-found' ? [{ state: 'kept' as const, code: 'npm-not-found' }] : []),
              ...(p.binary !== null && !p.removeBinary
                ? [{ state: 'kept' as const, code: 'unrecognized-program-kept', detail: binaryFile }]
                : []),
              ...(p.binary === null && p.version === null
                ? [{ state: 'kept' as const, code: 'program-not-installed' }]
                : []),
              ...(copies.length
                ? [{ state: 'kept' as const, code: 'program-other-copies-kept', detail: copies.join('\n') }]
                : []),
              ...(p.companion
                ? [{ state: 'kept' as const, code: 'ccline-companion-kept', detail: COMPANION_PLUGIN }]
                : []),
            ],
          };
        }
        const expected = scope ? facts['ccline/package']?.evidence?.binary : p.binary;
        if (binary === null || binary !== expected) throw new Error('program-changed');
        if (scope && (await packageVersion(scope.npmRoot)) !== p.target) throw new Error('program-not-ready');
        const version = await machine.execute(binaryFile, ['--version'], { timeoutMs: READ_COMMAND_TIMEOUT_MS });
        const found = CCLINE_BINARY_VERSION.exec(version.stdout.trim())?.[1];
        if (!succeeded(version) || found === undefined || (scope && found !== p.target))
          throw new Error('binary-version-mismatch');
        return { state: 'complete', evidence: { binary }, effects: [{ state: 'done', code: 'program-ready' }] };
      },
      execute: () => Promise.reject(new Error('read-only-operation')),
    },
  };

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
    const scope = observed.version === null ? null : (await freezeNpmScope(options)).data;
    const operations: OperationDefinition[] = [
      define(
        'uninstall-guard',
        'ccline.uninstall-guard',
        serial({
          scope,
          version: observed.version,
          binary: observed.binary,
          hasFileObservation,
          removeBinary: shouldRemoveBinary,
        }),
      ),
      connectionDefinition(
        observed,
        false,
        {},
        'detach',
        ['ccline/uninstall-guard'],
        null,
        FIELDS.some(field => isCcline(observed.fields[field]))
          ? [{ code: 'ccline-disconnect-before-uninstall', detail: settingsFile }]
          : [],
      ),
    ];
    if (scope)
      operations.push(
        define(
          'package',
          'ccline.package',
          serial({
            scope,
            before: observed.version,
            target: null,
            binary: observed.binary,
            action: 'uninstall',
            registry: null,
            mutate: true,
            removed: true,
          }),
          [{ code: 'program-uninstall', detail: 'CCometixLine · npm · ' + observed.version }],
          ['ccline/detach'],
        ),
      );
    if (shouldRemoveBinary)
      operations.push(
        define(
          'binary-remove',
          'ccline.binary-remove',
          { binary: observed.binary },
          [{ code: 'program-uninstall', detail: binaryFile }],
          [scope ? 'ccline/package' : 'ccline/detach'],
        ),
      );
    operations.push(
      define(
        'program-ready',
        'ccline.program-ready',
        serial({
          scope,
          removed: true,
          removeBinary: shouldRemoveBinary,
          binary: observed.binary,
          version: observed.version,
          problem: programProblem,
          companion: observed.hasCompanionPlugin,
        }),
        [
          ...(!shouldRemoveBinary && observed.binary !== null
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
          ...(observed.hasCompanionPlugin ? [{ code: 'ccline-companion-kept', detail: COMPANION_PLUGIN }] : []),
        ],
        operations.map(value => value.id),
      ),
    );
    return { operations, changes: operations.flatMap(value => value.changes) };
  }
  async function inspectItem(): Promise<Item> {
    // 全量探测失败才降级只读探测
    let observed: Observation | null = null;
    try {
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
          { code: observed.hasCompanionPlugin ? 'ccline-companion-present' : 'ccline-companion-missing' },
        ],
        actions,
      };
    } catch (error) {
      const fallback = await observe(false, false).catch(() => null);
      return {
        id: 'ccline',
        title: knownTitle('ccline'),
        kind: 'ccline',
        canInstall: true,
        facts: [],
        actions: [
          'install',
          ...(fallback && FIELDS.some(field => isCcline(fallback.fields[field])) ? (['detach'] as const) : []),
        ],
        problem: errorCode(error),
      };
    }
  }

  return {
    handlers,
    async inspect(): Promise<Inspection> {
      return { items: [await inspectItem()], problems: [] };
    },

    async prepare(selection: Selection): Promise<Prepared> {
      if (selection.id !== 'ccline') throw new Error('unknown-selection');
      let action = selection.action;
      if (action === 'uninstall') return prepareUninstall();
      if (action === 'install' && (await machine.fingerprint(binaryFile)) !== null) action = 'connect';
      if (!['install', 'connect', 'update', 'reinstall', 'detach'].includes(action))
        throw new Error('action-unavailable');
      const observed = await observe(action !== 'detach' && action !== 'connect', action !== 'detach');
      if (observed.npmProblem !== null) throw new Error(observed.npmProblem);
      if (action === 'detach') {
        if (!FIELDS.some(field => isCcline(observed.fields[field]))) throw new Error('no-connection');
        const operation = connectionDefinition(observed, false, {}, 'detach', [], null, [
          { code: 'ccline-detach', detail: settingsFile },
          { code: 'appearance-kept' },
        ]);
        return { operations: [operation], changes: operation.changes };
      }
      const scope = action === 'connect' ? null : (await freezeNpmScope(options)).data;
      if (scope && (await packageVersion(scope.npmRoot)) !== observed.version) throw new Error('program-changed');
      let release = '2.0.1';
      let registry: NpmRegistry = null;
      if (action !== 'connect') {
        const resolved = await resolveNpmView(machine, PACKAGE + '@latest', 'version', value =>
          isExactVersion(value) ? value : null,
        );
        if (resolved === null) throw new Error('source-unavailable');
        release = resolved.value;
        registry = resolved.registry;
        if (!/^2\.\d+\.\d+$/.test(release)) throw new Error('unsupported-ccline-release');
        noDowngrade(observed.version, release);
      }
      if (observed.appearance !== null) validateAppearance(observed.appearance);
      if (action === 'update' && observed.version === null) throw new Error('npm-package-missing');
      if ((action === 'install' || action === 'reinstall') && observed.binary !== null && observed.version === null)
        throw new Error('manual-program-preserved');
      if (action === 'connect' && observed.binary === null) throw new Error('program-not-ready');
      const templates = observed.fields;
      const detachedFields = { ...observed.fields };
      if (action === 'reinstall')
        for (const field of FIELDS) if (isCcline(detachedFields[field])) delete detachedFields[field];
      const operations: OperationDefinition[] = [];
      const programChanges: Change[] = [
        action === 'connect'
          ? { code: 'ccline-program-kept', detail: binaryFile }
          : { code: action === 'update' ? 'ccline-program-update' : 'ccline-program-prepare', detail: release },
        ...(action === 'reinstall' ? [{ code: 'ccline-reinstall-connection', detail: settingsFile }] : []),
      ];
      if (action === 'reinstall')
        operations.push(connectionDefinition(observed, false, {}, 'detach', [], 'ccline/connection'));
      if (scope)
        operations.push(
          define(
            'package',
            'ccline.package',
            serial({
              scope,
              before: observed.version,
              target: release,
              binary: observed.binary,
              action,
              registry,
              removed: false,
              mutate:
                action === 'reinstall' ||
                action === 'update' ||
                observed.version !== release ||
                observed.binary === null,
            }),
            programChanges,
            action === 'reinstall' ? ['ccline/detach'] : [],
          ),
        );
      operations.push(
        define(
          'program-ready',
          'ccline.program-ready',
          serial({
            scope,
            removed: false,
            binary: observed.binary,
            target: release,
          }),
          action === 'connect' ? programChanges : [],
          scope ? ['ccline/package'] : [],
        ),
      );
      if (action === 'update') {
        operations.push(
          define(
            'appearance',
            'ccline.appearance',
            {
              file: path.join(cclineDirectory(observed.fields), 'config.toml'),
              before: observed.appearance,
              after: observed.appearance,
              preserve: true,
            },
            [{ code: 'ccline-settings-kept' }],
            ['ccline/program-ready'],
          ),
        );
      } else {
        const styleFile = path.join(cclineDirectory(observed.fields), 'config.toml');
        const appearanceText = observed.appearance ?? (await machine.read(ASSET));
        if (appearanceText === null) throw new Error('asset-missing');
        validateAppearance(appearanceText);
        operations.push(
          define(
            'appearance',
            'ccline.appearance',
            { file: styleFile, before: observed.appearance, after: appearanceText },
            [
              observed.appearance === null
                ? { code: 'appearance-copy', detail: styleFile }
                : { code: 'appearance-kept' },
            ],
            ['ccline/program-ready'],
          ),
        );
        operations.push(
          connectionDefinition(
            { ...observed, fields: detachedFields },
            true,
            templates,
            'connection',
            ['ccline/program-ready', 'ccline/appearance'],
            null,
            [
              ...(isCcline(templates.subagentStatusLine) && action === 'reinstall'
                ? [{ code: 'ccline-subagent-restore', detail: settingsFile }]
                : []),
              {
                code:
                  observed.fields.statusLine !== undefined && !isCcline(observed.fields.statusLine)
                    ? 'ccline-statusline-replace'
                    : 'ccline-connect',
                detail: settingsFile,
              },
              ...(!samePath(options, cclineDirectory(templates), defaultCclineDirectory)
                ? [{ code: 'ccline-root-configure', detail: cclineDirectory(templates) }]
                : []),
            ],
          ),
        );
      }
      return { operations, changes: operations.flatMap(value => value.changes) };
    },
  };
}
