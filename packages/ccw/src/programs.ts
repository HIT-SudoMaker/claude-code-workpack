import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { knownTitle } from './titles.js';
import { OFFICECLI_REPO_SLUG, officeIntegration } from './management-catalog.js';
import { errorCode, isObject, succeeded } from './machine.js';
import type { CommandOptions } from './machine.js';
import { claudeEnvironment, claudeRunning, userBinary } from './model.js';
import { isExactVersion, NPM_OFFICIAL, resolveNpmView } from './npm-registry.js';
import type { Context, Item, Prepared, Selection } from './model.js';
import type { NpmRegistry, NpmResolution } from './npm-registry.js';
import {
  channelCanPinVersion,
  containsPath,
  freezeProgramScope,
  freezeNpmScope,
  identifyProgramChannel,
  npmBinary,
  npmGlobalRoot,
  npmVersion,
  officeBinary,
  PROGRAM_PACKAGES,
  samePath,
} from './program-channels.js';
import type { Program, ProgramKind } from './program-channels.js';
import { programOperation, programPrepared } from './program-operations.js';
export { programHandlers } from './program-operations.js';
import { installScratch } from './storage.js';

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
  if (selection.action === 'uninstall')
    return prepareProgramRemoval(ctx, kind, selection, program, !selection.removeData);
  if (kind === 'claude' && program === undefined && selection.action === 'install')
    return prepareClaudeInstall(ctx, selection.id);
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
  if (action !== 'login' && targetVersion === null) throw new Error('pinned-version-channel-unsupported');
  const payload = {
    program,
    scope: scope.data,
    before: stamp,
    action,
    targetVersion,
    registry: targetRegistry ?? null,
  };
  const command = programOperation(
    selection.id,
    action === 'login' ? 'login' : 'program-command',
    'program.maintain',
    payload,
    [
      {
        code: PROGRAM_ACTION_CHANGE[action],
        detail: program.binary + ' · ' + channel + (targetVersion ? ' · ' + targetVersion : ''),
      },
      { code: 'keep-user-data' },
    ],
    [],
    [program.binary],
  );
  const ready = programOperation(
    selection.id,
    'program-ready',
    'program.ready',
    { binary: program.binary, kind, version: targetVersion, scope: scope.data, program, command: command.id },
    [],
    [command.id],
  );
  return {
    ...programPrepared(action === 'login' ? [command] : [command, ready]),
    targetVersion,
    ...(targetRegistry ? { targetRegistry } : {}),
  };
}

export async function claudeVersion(ctx: Context, binary: string) {
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

/** Freeze npm and the optional official CMD alternative before approval. */
async function prepareClaudeInstall(
  ctx: Context,
  itemId: string,
): Promise<Prepared & { readonly targetVersion: string; readonly targetRegistry: NpmRegistry }> {
  const release = await stableClaudeVersion(ctx);
  let npm = null;
  try {
    npm = (await freezeNpmScope(ctx)).data;
  } catch (error) {
    if (errorCode(error) !== 'npm-not-found') throw error;
  }
  const script = ctx.platform === 'win32' ? await ctx.machine.fetchText('https://claude.ai/install.cmd') : null;
  if (script !== null && (/^\s*</.test(script) || !script.trim())) throw new Error('installer-unavailable');
  const target = {
    version: release.value,
    registry: release.registry,
    npm,
    native: userBinary(ctx, 'claude'),
    script,
    directory: script === null ? null : installScratch(ctx, 'claude-' + randomUUID()),
    npmOperation: itemId + '/npm-install',
    cleanupOperation: itemId + '/npm-cleanup',
    stageOperation: itemId + '/cmd-stage',
    cmdOperation: itemId + '/cmd-install',
    scriptCleanupOperation: itemId + '/cmd-cleanup',
  };
  const operations = [
    programOperation(itemId, 'npm-install', 'claude.install-npm', target, [
      { code: ctx.platform === 'win32' ? 'program-install-cmd' : 'program-install', detail: 'npm · ' + release.value },
      { code: 'keep-user-data' },
    ]),
  ];
  if (ctx.platform === 'win32')
    operations.push(
      programOperation(itemId, 'npm-cleanup', 'claude.cleanup-npm', target),
      programOperation(itemId, 'cmd-stage', 'claude.stage-cmd', target),
      programOperation(itemId, 'cmd-install', 'claude.install-cmd', target),
      programOperation(itemId, 'cmd-cleanup', 'claude.cleanup-script', target),
    );
  operations.push(
    programOperation(itemId, 'program-ready', 'program.ready', {
      kind: 'claude',
      version: release.value,
      alternatives: [target.npmOperation, ...(ctx.platform === 'win32' ? [target.cmdOperation] : [])],
    }),
  );
  return { ...programPrepared(operations), targetVersion: release.value, targetRegistry: release.registry };
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
      return { file, stamp: await ctx.machine.treeStamp(file) };
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
  const removals = updates.map((target, index) =>
    programOperation(
      selection.id,
      'update-artifact-' + index,
      'program.remove-file',
      { file: target.file, before: target.stamp },
      target.stamp === null ? [] : [{ code: 'program-copy-remove', detail: target.file }],
      [],
      [target.file],
    ),
  );
  const deploy = programOperation(
    selection.id,
    'program-deploy',
    'program.deploy',
    {
      binary,
      before,
      digest,
      version: targetVersion,
      bytes: bytes === null ? null : Buffer.from(bytes).toString('base64'),
      source: baseUrl + assetName,
    },
    [
      {
        code: shouldKeepBinary ? 'program-kept' : PROGRAM_ACTION_CHANGE[action],
        detail: 'OfficeCLI · native · ' + targetVersion + ' · ' + binary,
      },
    ],
    removals.map(operation => operation.id),
    [binary],
  );
  const ready = programOperation(
    selection.id,
    'program-ready',
    'program.ready',
    { binary, digest, version: targetVersion, kind: 'officecli' },
    [],
    [deploy.id],
  );
  const userPath = programOperation(
    selection.id,
    'program-path',
    'program.path',
    { directory: path.dirname(binary) },
    [{ code: 'program-user-path', detail: path.dirname(binary) }, { code: 'keep-user-data' }],
    [ready.id],
  );
  return { ...programPrepared([...removals, deploy, ready, userPath]), targetVersion, targetBinary: binary };
}

/** Claude 变更前的进程复核：枚举失败保留未知，不臆断未运行 */
async function ensureClaudeNotRunning(ctx: Context) {
  const isClaudeActive = await claudeRunning(ctx.machine);
  if (isClaudeActive !== false) throw new Error(isClaudeActive ? 'claude-running' : 'process-state-unconfirmed');
}

async function prepareProgramRemoval(
  ctx: Context,
  kind: ProgramKind,
  selection: Selection,
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
  const operations = [];
  for (const [index, file] of nativeFiles.entries())
    operations.push(
      programOperation(
        selection.id,
        'program-remove-' + index,
        'program.remove-file',
        { file, before: await ctx.machine.treeStamp(file), claude: kind === 'claude' },
        [{ code: file === program.binary ? 'program-uninstall' : 'program-copy-remove', detail: file }],
        [],
        [file],
      ),
    );
  if (program.channel === 'native' && kind === 'officecli')
    for (const [index, target] of (await officeUpdates(ctx, program.binary)).entries())
      operations.push(
        programOperation(
          selection.id,
          'program-artifact-remove-' + index,
          'program.remove-file',
          { file: target.file, before: target.stamp },
          target.stamp === null ? [] : [{ code: 'program-copy-remove', detail: target.file }],
          [],
          [target.file],
        ),
      );
  if (!nativeFiles.length)
    operations.push(
      programOperation(
        selection.id,
        'program-package-remove',
        'program.remove-package',
        { program, scope: scope.data, before, action: 'uninstall', targetVersion: null, registry: null },
        [{ code: 'program-uninstall', detail: program.channel + ' · ' + program.binary }],
        [],
        [program.binary],
      ),
    );
  const ready = programOperation(
    selection.id,
    'program-removed',
    'program.ready',
    { kind, binary: program.binary, version: null, removed: true, removals: operations.map(operation => operation.id) },
    shouldPreserveData ? [{ code: 'keep-user-data' }] : [],
    operations.map(operation => operation.id),
  );
  return { ...programPrepared([...operations, ready]), targetVersion: null };
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
