import { createHash } from 'node:crypto';
import path from 'node:path';

import { knownTitle } from './titles.js';
import { OFFICECLI_REPO_SLUG, officeIntegration } from './management-catalog.js';
import { errorCode, isObject, succeeded } from './machine.js';
import type { CommandOptions } from './machine.js';
import { cancelled, claudeEnvironment, claudeRunning, success, userBinary } from './model.js';
import { isExactVersion, NPM_OFFICIAL, resolveNpmView } from './npm-registry.js';
import type { Context, Item, Prepared, Selection } from './model.js';
import type { NpmRegistry, NpmResolution } from './npm-registry.js';
import {
  channelCanPinVersion,
  containsPath,
  freezeProgramScope,
  identifyProgramChannel,
  maintainProgramChannel,
  npmBinary,
  npmGlobalRoot,
  npmVersion,
  officeBinary,
  PROGRAM_PACKAGES,
  programPackageAbsent,
  removeProgramChannel,
  samePath,
} from './program-channels.js';
import type { Program, ProgramKind } from './program-channels.js';
import { createOfficeNativeProtocol } from './office-native-protocol.js';
import { createClaudeInstallProtocol } from './claude-install-protocol.js';

export async function programs(
  ctx: Context,
  kind: ProgramKind,
): Promise<{ items: Item[]; values: Map<string, Program>; problems: string[] }> {
  const values = new Map<string, Program>();
  const problems: string[] = [];
  const canonicalPaths: string[] = [];
  const native = kind === 'claude' ? userBinary(ctx, 'claude') : officeBinary(ctx);
  const add = (value: Program) => values.set(`${kind}:${value.channel}:${value.binary}`, value);
  try {
    const version = await npmVersion(ctx, PROGRAM_PACKAGES[kind]);
    if (version !== null) {
      const root = await npmGlobalRoot(ctx);
      const binary = await npmBinary(ctx, kind, root);
      add({
        kind,
        channel: 'npm',
        binary,
        version,
        npmRoot: root,
        packageName: PROGRAM_PACKAGES[kind],
        isMissing: (await ctx.machine.treeStamp(binary)) === null,
      });
      canonicalPaths.push((await ctx.machine.realpath(binary)) ?? binary);
    }
  } catch (error) {
    if (errorCode(error) === 'npm-changed') throw error;
    problems.push(errorCode(error));
  }
  const candidates = new Set([native, ...(await ctx.machine.locate(kind))]);
  for (const candidate of candidates) {
    let binary = candidate;
    if (ctx.platform === 'win32' && binary.endsWith('.exe')) {
      const shim = await ctx.machine.read(binary.slice(0, -4) + '.shim');
      const target = shim === null ? undefined : /^path\s*=\s*"([^"]+)"/m.exec(shim)?.[1];
      if (
        target !== undefined &&
        path.isAbsolute(target) &&
        /\/apps\/officecli\/[^/]+\/(?:[^/]+\/)*officecli(?:\.exe)?$/.test(target.replaceAll('\\', '/').toLowerCase())
      )
        binary = target;
    }
    const canonical = await ctx.machine.realpath(binary);
    if (
      canonical === null ||
      canonicalPaths.some(file => samePath(ctx, file, canonical)) ||
      [...values.values()].some(
        program =>
          program.npmRoot !== undefined &&
          containsPath(ctx, path.join(program.npmRoot, program.packageName), canonical),
      )
    )
      continue;
    if (
      [kind, `${kind}.cmd`, `${kind}.ps1`].includes(path.basename(binary).toLowerCase()) &&
      [...values.values()].some(
        program =>
          program.npmRoot !== undefined &&
          samePath(ctx, program.npmRoot, path.join(path.dirname(binary), 'node_modules')),
      )
    )
      continue;
    add({ kind, binary, version: null, ...(await identifyProgramChannel(ctx, kind, binary, canonical, native)) });
    canonicalPaths.push(canonical);
  }
  return {
    values,
    problems,
    items: [...values.entries()].map(([id, value]) => ({
      id,
      name: kind,
      title: knownTitle(kind),
      kind,
      canInstall: true,
      location: value.binary,
      facts: [
        // 渠道与版本各占一条事实；展示层直读结构化字段，不反解拼接文本
        { code: value.isMissing ? 'program-missing' : 'program-exists', detail: value.channel },
        ...(value.version ? [{ code: 'program-version', detail: value.version }] : []),
      ],
      actions:
        value.channel === 'manual'
          ? kind === 'officecli'
            ? ['connect']
            : []
          : [
              ...(value.isMissing
                ? ['install' as const]
                : [
                    'update' as const,
                    'reinstall' as const,
                    ...(kind === 'officecli' ? ['connect' as const] : ['login' as const]),
                  ]),
              'uninstall' as const,
            ],
    })),
  };
}

export async function claudeCommand(ctx: Context, args: readonly string[], isInteractive = false) {
  const candidates = await programs(ctx, 'claude');
  const program = [...candidates.values.values()].find(value => !value.isMissing && !value.binary.endsWith('.cmd'));
  if (program === undefined) throw new Error('claude-not-installed');
  const isObservation = args.includes('--help') || (args[0] === 'auth' && args[1] === 'status');
  return executeClaude(ctx, program.binary, args, { isInteractive }, isObservation ? 'observe' : 'effect');
}

function executeClaude(
  ctx: Context,
  binary: string,
  args: readonly string[],
  options: Pick<CommandOptions, 'isInteractive' | 'timeoutMs'> = {},
  mode: 'observe' | 'effect' = 'observe',
) {
  const machine = mode === 'observe' ? ctx.machine : ctx.effects;
  return machine.execute(
    binary.endsWith('.js') ? process.execPath : binary,
    binary.endsWith('.js') ? [binary, ...args] : args,
    { env: claudeEnvironment(ctx), cwd: ctx.home, ...options },
  );
}

/** 计划预览变更码按动作显式枚举：模板串会产生字典外码，登录复用既有官方登录入口码 */
const PROGRAM_ACTION_CHANGE: Readonly<Record<'install' | 'update' | 'reinstall' | 'login', string>> = {
  install: 'program-install',
  update: 'program-update',
  reinstall: 'program-reinstall',
  login: 'login-browser',
};

export async function prepareProgram(
  ctx: Context,
  kind: ProgramKind,
  selection: Selection,
  program?: Program,
): Promise<
  Prepared & {
    readonly targetVersion: string | null;
    readonly targetBinary?: string;
    readonly targetRegistry?: NpmRegistry;
  }
> {
  if (selection.action === 'uninstall') return prepareProgramRemoval(ctx, kind, program, !selection.removeData);
  if (kind === 'claude' && program === undefined && selection.action === 'install') return prepareClaudeInstall(ctx);
  if (kind === 'officecli' && (program === undefined || program.channel === 'native'))
    return prepareOfficeNative(ctx, selection, program);
  const action = selection.action;
  if (program === undefined) throw new Error('program-changed');
  const channel = program.channel;
  if (channel === 'manual') throw new Error('channel-not-supported');
  if (action !== 'install' && action !== 'update' && action !== 'reinstall' && action !== 'login')
    throw new Error('action-unavailable');
  if (program.channel === 'npm' && action === 'install' && !program.isMissing) throw new Error('program-changed');
  const stamp = await ctx.machine.treeStamp(program.binary);
  let targetVersion: string | null = null;
  let targetRegistry: NpmRegistry | undefined;
  if (kind === 'claude' && action !== 'login') {
    if (!channelCanPinVersion(channel)) throw new Error('pinned-version-channel-unsupported');
    const release = await stableClaudeVersion(ctx);
    targetVersion = release.value;
    targetRegistry = release.registry;
    const current = program.version ?? (await claudeVersion(ctx, program.binary));
    if (current === null) throw new Error('program-version-unconfirmed');
    if (current !== null && compareVersions(current, targetVersion) > 0) throw new Error('newer-version-preserved');
  }
  if (channel === 'npm' && action !== 'login') {
    const release =
      kind === 'claude' && targetVersion !== null && targetRegistry !== undefined
        ? { value: targetVersion, registry: targetRegistry }
        : await resolveNpmView(ctx.machine, `${PROGRAM_PACKAGES[kind]}@latest`, 'version', exactVersion);
    if (release === null) throw new Error('invalid-release');
    targetVersion = release.value;
    targetRegistry = release.registry;
    if (program.version && compareVersions(program.version, release.value) > 0)
      throw new Error('newer-version-preserved');
  }
  const scope = await freezeProgramScope(ctx, program);
  let isComplete = false;
  let isCommandCompleted = false;
  let commandStamp: string | null | undefined;
  let verifiedBinary: string | undefined;
  let verifiedStamp: string | null = null;
  const operation: Prepared & { readonly targetVersion: string | null; readonly targetRegistry?: NpmRegistry } = {
    targetVersion,
    ...(targetRegistry !== undefined ? { targetRegistry } : {}),
    get changes() {
      return [
        {
          code: isCommandCompleted ? 'program-installation-confirm' : PROGRAM_ACTION_CHANGE[action],
          detail: `${program.binary} · ${channel}${targetVersion ? ` · ${targetVersion}` : ''}`,
        },
        { code: 'keep-user-data' },
      ];
    },
    async run(report, signal) {
      cancelled(signal);
      if (isCommandCompleted) {
        if (commandStamp === undefined) throw new Error('program-installation-unconfirmed');
        if ((await ctx.machine.treeStamp(program.binary)) !== commandStamp) throw new Error('program-changed');
      } else {
        if ((await ctx.machine.treeStamp(program.binary)) !== stamp) throw new Error('program-changed');
        await scope.verify();
      }
      if (action === 'login') {
        success(
          await executeClaude(ctx, program.binary, ['auth', 'login'], { isInteractive: true }, 'effect'),
          'login-failed',
        );
        const status: unknown = JSON.parse(
          success(await executeClaude(ctx, program.binary, ['auth', 'status', '--json'])),
        );
        if (!isObject(status) || status.loggedIn !== true) throw new Error('login-unconfirmed');
        isComplete = true;
        report({ state: 'done', code: 'logged-in' });
        return;
      }
      if (!isCommandCompleted)
        await maintainProgramChannel(ctx, program, scope, action, targetVersion, targetRegistry, async () => {
          isCommandCompleted = true;
          report({ state: 'done', code: 'package-command-completed' });
          try {
            commandStamp = await ctx.machine.treeStamp(program.binary);
          } catch (error) {
            throw new Error('program-installation-unconfirmed', { cause: error });
          }
        });
      if (channel === 'npm' || channel === 'brew') await scope.verify();
      const found = await programs(ctx, kind);
      let selected: Program | undefined;
      for (const value of found.values.values())
        if (await scope.matches(value)) {
          selected = value;
          break;
        }
      if (selected === undefined || (await ctx.machine.treeStamp(selected.binary)) === null)
        throw new Error('program-not-ready');
      if (channel === 'npm' && selected.version !== targetVersion) throw new Error('program-not-ready');
      if (kind === 'claude' && (await claudeVersion(ctx, selected.binary)) !== targetVersion)
        throw new Error('program-not-ready');
      verifiedBinary = selected.binary;
      verifiedStamp = await ctx.machine.treeStamp(selected.binary);
      isComplete = true;
      report({ state: 'done', code: 'program-ready' });
      cancelled(signal);
    },
    remaining: () => (isComplete ? undefined : operation),
    async verify() {
      if (isCommandCompleted && commandStamp === undefined) throw new Error('program-installation-unconfirmed');
      if (verifiedBinary && (await ctx.machine.treeStamp(verifiedBinary)) !== verifiedStamp)
        throw new Error('program-changed');
    },
  };
  return operation;
}

async function claudeVersion(ctx: Context, binary: string) {
  const output = await executeClaude(ctx, binary, ['--version'], { timeoutMs: 10_000 });
  const version = /\b(\d+\.\d+\.\d+)\b/.exec(output.stdout)?.[1];
  return !output.failed && output.code === 0 ? (version ?? null) : null;
}

function exactVersion(value: unknown) {
  return isExactVersion(value) ? value : null;
}

async function stableClaudeVersion(ctx: Context): Promise<NpmResolution<string>> {
  const release = await resolveNpmView(ctx.machine, `${PROGRAM_PACKAGES.claude}@stable`, 'version', exactVersion);
  if (release !== null) return release;
  try {
    const metadata: unknown = JSON.parse(
      await ctx.machine.fetchText(`${NPM_OFFICIAL}/@anthropic-ai%2Fclaude-code/stable`, { timeoutMs: 5_000 }),
    );
    if (!isObject(metadata)) throw new Error('invalid-release');
    const version = exactVersion(metadata.version);
    if (version === null) throw new Error('invalid-release');
    return { value: version, registry: NPM_OFFICIAL };
  } catch {
    throw new Error('stable-release-unavailable');
  }
}

async function installedClaude(ctx: Context, channel: 'npm' | 'native', expected: string) {
  const found = await programs(ctx, 'claude');
  if (found.problems.length) throw new Error('installation-state-unconfirmed');
  const program = [...found.values.values()].find(value => value.channel === channel);
  return program !== undefined &&
    (await ctx.machine.treeStamp(program.binary)) !== null &&
    (await claudeVersion(ctx, program.binary)) === expected
    ? program
    : undefined;
}

/** 固定 stable 版本与来源，安装进度由 Claude 私有协议持有。 */
async function prepareClaudeInstall(
  ctx: Context,
): Promise<Prepared & { readonly targetVersion: string | null; readonly targetRegistry: NpmRegistry }> {
  const release = await stableClaudeVersion(ctx);
  const operation = await createClaudeInstallProtocol(
    ctx,
    {
      version: release.value,
      registry: release.registry,
    },
    {
      inspect: () => programs(ctx, 'claude'),
      installed: channel => installedClaude(ctx, channel, release.value),
    },
  );
  // Object.assign 保留协议的 changes getter；spread 会把续办视图冻结成准备时的值。
  return Object.assign(operation, { targetVersion: release.value, targetRegistry: release.registry });
}

function officeAsset(ctx: Context) {
  const arch = ctx.arch ?? process.arch;
  if (arch !== 'x64' && arch !== 'arm64') throw new Error('unsupported-architecture');
  if (ctx.platform === 'win32') return `officecli-win-${arch}.exe`;
  if (ctx.platform === 'darwin') return `officecli-mac-${arch}`;
  return `officecli-linux-${ctx.libc === 'musl' ? 'alpine-' : ''}${arch}`;
}

export async function officeVersion(ctx: Context, binary: string) {
  const deadlineMs = performance.now() + 5_000;
  const probe = (argument: string) =>
    ctx.machine.execute(binary, [argument], {
      env: { ...officeIntegration.suppressSelfUpdate },
      cwd: ctx.home,
      timeoutMs: Math.max(1, Math.ceil(deadlineMs - performance.now())),
    });
  const output = await probe('--version');
  const version = /\b(\d+\.\d+\.\d+)\b/.exec(output.stdout)?.[1];
  if (!succeeded(output) || version === undefined) return null;
  if (/\bofficecli\b/i.test(output.stdout)) return version;
  if (performance.now() >= deadlineMs) return null;
  const help = await probe('--help');
  return succeeded(help) && /\bofficecli\b/i.test(help.stdout) ? version : null;
}

async function officeUpdates(ctx: Context, binary: string) {
  const files = ['.update', '.update.partial', '.old'].map(suffix => binary + suffix);
  const entries = await ctx.machine.entries(path.dirname(binary));
  return Promise.all(
    files.map(async file => {
      if (entries.some(entry => entry.name === path.basename(file) && entry.kind === 'directory'))
        throw new Error('program-update-conflict');
      return { file, stamp: await ctx.machine.treeStamp(file), isDone: false };
    }),
  );
}

async function prepareOfficeNative(
  ctx: Context,
  selection: Selection,
  program?: Program,
): Promise<Prepared & { readonly targetVersion: string; readonly targetBinary: string }> {
  const action = selection.action;
  if (action !== 'install' && action !== 'update' && action !== 'reinstall') throw new Error('action-unavailable');
  const binary = program?.binary ?? officeBinary(ctx);
  if (!samePath(ctx, binary, officeBinary(ctx))) throw new Error('channel-not-supported');
  const before = await ctx.machine.fingerprint(binary);
  if (!program && before !== null) throw new Error('program-changed');
  const updates = await officeUpdates(ctx, binary);
  const assetName = officeAsset(ctx);
  const release: unknown = JSON.parse(
    await ctx.machine.fetchText(`https://api.github.com/repos/${OFFICECLI_REPO_SLUG}/releases/latest`),
  );
  if (
    !isObject(release) ||
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.tag_name !== 'string' ||
    !/^v\d+\.\d+\.\d+$/.test(release.tag_name) ||
    !Array.isArray(release.assets)
  )
    throw new Error('invalid-release');
  const tag = release.tag_name;
  const targetVersion = tag.slice(1);
  const baseUrl = `https://github.com/${OFFICECLI_REPO_SLUG}/releases/download/${tag}/`;
  const assets = release.assets.filter(isObject);
  const asset = assets.find(value => value.name === assetName);
  const manifest = assets.find(value => value.name === 'SHA256SUMS');
  if (
    !asset ||
    asset.browser_download_url !== `${baseUrl}${assetName}` ||
    !manifest ||
    manifest.browser_download_url !== `${baseUrl}SHA256SUMS`
  )
    throw new Error('release-asset-unavailable');
  const fetchReleaseFile = async <T>(
    name: string,
    read: (url: string, options?: { timeoutMs: number }) => Promise<T>,
    timeoutMs: number,
  ): Promise<T> => {
    try {
      return await read(`${baseUrl}${name}`, { timeoutMs });
    } catch (error) {
      if (errorCode(error) === 'cancelled') throw error;
      // 上游官方镜像只作为传输备选；标签、文件名与摘要仍由 GitHub 发布约束。
      return read(`${officeIntegration.releaseMirror}/releases/download/${tag}/${name}`);
    }
  };
  const checksums = await fetchReleaseFile('SHA256SUMS', (url, options) => ctx.machine.fetchText(url, options), 10_000);
  const matching = checksums
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts[1]?.replace(/^\*/, '') === assetName);
  const digest = matching.length === 1 ? matching[0]?.[0]?.toLowerCase() : undefined;
  if (
    digest === undefined ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    (asset.digest !== undefined && asset.digest !== null && asset.digest !== `sha256:${digest}`)
  )
    throw new Error('release-checksum-unavailable');
  if (before !== null) {
    const currentVersion = program?.version ?? (await officeVersion(ctx, binary));
    if (currentVersion === null) throw new Error('program-version-unconfirmed');
    if (compareVersions(currentVersion, targetVersion) > 0) throw new Error('newer-version-preserved');
  }
  // 完整摘要与发布原件一致才复用；版本号相同但内容不同仍需下载校验。
  const shouldKeepBinary = action === 'update' && before === digest;
  const bytes = shouldKeepBinary
    ? null
    : await fetchReleaseFile(assetName, (url, options) => ctx.machine.fetchBytes(url, options), 30_000);
  if (bytes !== null && createHash('sha256').update(bytes).digest('hex') !== digest)
    throw new Error('release-checksum-mismatch');
  const operation = createOfficeNativeProtocol(
    ctx,
    {
      binary,
      before,
      digest,
      version: targetVersion,
      deployment: bytes === null ? { kind: 'reuse' } : { kind: 'replace', bytes },
      updates,
      change: {
        code: shouldKeepBinary ? 'program-kept' : PROGRAM_ACTION_CHANGE[action],
        detail: `OfficeCLI · native · ${targetVersion} · ${binary}`,
      },
    },
    () => officeVersion(ctx, binary),
  );
  return Object.assign(operation, { targetVersion, targetBinary: binary });
}

/** Claude 变更前的进程复核：枚举失败保留未知，不臆断未运行 */
async function ensureClaudeNotRunning(ctx: Context) {
  const isClaudeActive = await claudeRunning(ctx.machine);
  if (isClaudeActive !== false) throw new Error(isClaudeActive ? 'claude-running' : 'process-state-unconfirmed');
}

async function prepareProgramRemoval(
  ctx: Context,
  kind: ProgramKind,
  program?: Program,
  shouldPreserveData = true,
): Promise<Prepared & { readonly targetVersion: null }> {
  if (!program) throw new Error('program-not-installed');
  if (program.channel === 'manual') throw new Error('channel-not-supported');
  if (kind === 'claude') await ensureClaudeNotRunning(ctx);
  const before = await ctx.machine.treeStamp(program.binary);
  const scope = await freezeProgramScope(ctx, program);
  if (
    kind === 'officecli' &&
    program.channel === 'native' &&
    before !== null &&
    (await officeVersion(ctx, program.binary)) === null
  )
    throw new Error('program-identity-unconfirmed');
  const nativeFiles =
    program.channel === 'native'
      ? [program.binary, ...(kind === 'claude' ? [path.join(ctx.home, '.local/share/claude')] : [])]
      : [];
  const removals = [
    ...(await Promise.all(
      nativeFiles.map(async file => ({ file, stamp: await ctx.machine.treeStamp(file), isDone: false })),
    )),
    ...(program.channel === 'native' && kind === 'officecli' ? await officeUpdates(ctx, program.binary) : []),
  ];
  let isComplete = false;
  let hasAttemptedCommand = false;
  let isCommandFailed = false;
  let isBinaryRemoved = false;
  const verifyRemoved = async () => {
    if (program.channel === 'npm') {
      await scope.verify();
      if ((await npmVersion(ctx, PROGRAM_PACKAGES[kind], scope.npmRoot)) !== null)
        throw new Error('program-still-installed');
    }
    if ((await ctx.machine.treeStamp(program.binary)) !== null) throw new Error('program-still-installed');
    for (const target of removals)
      if ((await ctx.machine.treeStamp(target.file)) !== null) throw new Error('program-still-installed');
  };
  const operation: Prepared & { readonly targetVersion: null } = {
    targetVersion: null,
    get changes() {
      const pending = removals.filter(value => !value.isDone && value.stamp !== null);
      return [
        ...(removals.length
          ? pending.length
            ? pending.map(value => ({
                code: value.file === program.binary ? 'program-uninstall' : 'program-copy-remove',
                detail: value.file,
              }))
            : [{ code: 'program-removal-confirm' }]
          : hasAttemptedCommand
            ? [{ code: 'program-removal-confirm' }]
            : [{ code: 'program-uninstall', detail: `${program.channel} · ${program.binary}` }]),
        ...(shouldPreserveData ? [{ code: 'keep-user-data' }] : []),
      ];
    },
    async run(report, signal) {
      cancelled(signal);
      if (kind === 'claude') await ensureClaudeNotRunning(ctx);
      if (removals.length) {
        for (const target of removals) {
          if (target.isDone) {
            if ((await ctx.machine.treeStamp(target.file)) !== null) throw new Error('program-changed');
            continue;
          }
          cancelled(signal);
          if ((await ctx.machine.treeStamp(target.file)) !== target.stamp) throw new Error('program-changed');
          if (target.stamp !== null) await ctx.effects.removeTree(target.file, target.stamp);
          target.isDone = true;
          report({ state: target.stamp === null ? 'kept' : 'done', code: 'program-copy-removed', detail: target.file });
          cancelled(signal);
        }
      } else {
        const isConfirming = hasAttemptedCommand;
        if (!hasAttemptedCommand) {
          if ((await ctx.machine.treeStamp(program.binary)) !== before) throw new Error('program-changed');
          await scope.verify();
          const result = await removeProgramChannel(ctx, program, scope);
          hasAttemptedCommand = true;
          isCommandFailed = !succeeded(result);
          if (!isCommandFailed) report({ state: 'kept', code: 'program-uninstall-command-completed' });
        }
        const current = await ctx.machine.treeStamp(program.binary);
        if (current === null && before !== null && !isBinaryRemoved) {
          isBinaryRemoved = true;
          report({ state: 'done', code: 'program-copy-removed', detail: program.binary });
        }
        try {
          await verifyRemoved();
        } catch (error) {
          const code = errorCode(error);
          if (code === 'program-still-installed' && current === before) hasAttemptedCommand = false;
          throw new Error(
            code === 'program-still-installed'
              ? isCommandFailed
                ? 'program-uninstall-failed'
                : code
              : 'program-removal-unconfirmed',
            { cause: error },
          );
        }
        if (isCommandFailed && program.channel !== 'npm') {
          if (!isConfirming || (await programPackageAbsent(ctx, program, scope)) !== true)
            throw new Error('program-removal-unconfirmed');
        }
      }
      await verifyRemoved();
      isComplete = true;
      report({ state: 'done', code: 'program-removed', detail: program.binary });
      if (shouldPreserveData) report({ state: 'kept', code: 'keep-user-data' });
      try {
        const found = await programs(ctx, kind);
        for (const value of found.values.values())
          report({ state: 'kept', code: 'program-other-copies-kept', detail: value.binary });
        for (const code of found.problems) report({ state: 'kept', code: 'program-inspection-warning', detail: code });
      } catch (error) {
        report({ state: 'kept', code: 'program-inspection-warning', detail: errorCode(error) });
      }
      cancelled(signal);
    },
    remaining: () => (isComplete ? undefined : operation),
    verify: verifyRemoved,
  };
  return operation;
}

/** 三段语义化版本比较：正值为左更新；ccline 的降级门共用 */
export function compareVersions(left: string, right: string) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
