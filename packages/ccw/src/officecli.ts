import path from 'node:path';
import { knownTitle, OFFICECLI_REPO_SLUG, OFFICE_INTEGRATION } from './management-catalog.js';
import {
  sourcesFile,
  currentSkill,
  prepareSkillFiles,
  skillFilesStamp,
  disableSkillEntry,
  repairSkillSource,
  ownsSkill,
  checkSkillSource,
} from './skill-files.js';
import { isGitRevision, isObject, errorCode, succeeded } from './machine.js';
import { createHash } from 'node:crypto';
import { json, userBinDirectory } from './model.js';
import type { Context, Domain, Prepared, Selection, Item } from './model.js';
import { isExactVersion, compareVersions } from './npm-registry.js';
import { samePath } from './program-channels.js';
import { removeProgramFile, deployProgram, programPath } from './program-operations.js';
import { step, sequence, work } from './work.js';

const PROGRAM_ACTION_CHANGE = { install: 'program-install', update: 'program-update' } as const;
const CHECKSUM_DOWNLOAD_TIMEOUT_MS = 10_000;
const PROGRAM_DOWNLOAD_TIMEOUT_MS = 30_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const MAX_TAG_DEREFERENCES = 4;

interface OfficeProgram {
  readonly channel: 'native' | 'manual';
  readonly binary: string;
}
/**
 * 管理 OfficeCLI 原生程序和配套技能
 *
 * @remarks 仅管理固定用户目录；按发布摘要及技能提交安装，摘要匹配时复用程序
 * 拒绝降级、来源不明或覆盖本地技能改动
 * 卸载移除程序并保留自有技能副本，不动其他技能和用户数据
 */
export function createOfficecli(ctx: Context): Domain {
  const directory = path.join(ctx.claudeRoot, 'skills', 'officecli');
  return {
    async inspect() {
      const found = await officePrograms(ctx);
      return {
        items: found.items.length
          ? found.items
          : [
              {
                id: 'officecli',
                title: knownTitle('officecli'),
                kind: 'officecli',
                location: officeBinary(ctx),
                canInstall: true,
                facts: [{ code: 'not-installed' }],
              },
            ],
        problems: [],
      };
    },
    async prepare(selection: Selection): Promise<Prepared> {
      if (selection.id !== 'officecli') throw new Error('channel-not-supported');
      const found = await officePrograms(ctx);
      const program = found.values.get('officecli');
      if (!program && found.values.size) throw new Error('channel-not-supported');
      let metadata: Record<string, unknown>;
      try {
        metadata = await json(ctx.machine, sourcesFile(ctx));
      } catch {
        throw new Error('source-metadata-unavailable');
      }
      const before = await ctx.machine.treeStamp(directory);
      const record = metadata[directory];
      const owned = ownsSkill(record, OFFICE_INTEGRATION.skill.repository, before);
      if (selection.action !== 'uninstall' && before !== null)
        checkSkillSource(record, OFFICE_INTEGRATION.skill.repository);
      if (selection.action === 'uninstall') {
        const operation = await prepareOfficeRemoval(ctx, program);
        const detach = owned && before !== null ? disableSkillEntry(ctx, directory, before, record) : work([]);
        const kept = step([], () =>
          Promise.resolve({
            state: 'complete',
            effects:
              before !== null && !owned
                ? [{ state: 'kept', code: 'unmatched-integration-kept', detail: directory }]
                : [],
          }),
        );
        return work([sequence([detach, operation]), kept]);
      }
      const operation = await prepareOfficeNative(ctx, program);
      const revision = await officeRevision(ctx, operation.targetVersion);
      const files = await ctx.machine.source(
        OFFICE_INTEGRATION.skill.repository,
        revision,
        OFFICE_INTEGRATION.skill.folder,
      );
      const source = {
        repository: OFFICE_INTEGRATION.skill.repository,
        revision,
        files,
        stamp: skillFilesStamp(files),
      };
      const target = { name: 'officecli', directory, stamp: before, sourceRecord: record };
      if (before !== null && !owned && before !== source.stamp) throw new Error('local-edits-preserved');
      const skill =
        before === source.stamp
          ? owned
            ? currentSkill(ctx, 'officecli', directory, before)
            : repairSkillSource(ctx, target, source)
          : prepareSkillFiles(ctx, target, source);
      return {
        ...sequence([operation, skill]),
        action: operation.action ?? 'install',
      };
    },
  };
}
async function prepareOfficeRemoval(ctx: Context, program?: OfficeProgram): Promise<Prepared> {
  if (program?.channel === 'manual') throw new Error('channel-not-supported');
  if (!program || program.channel !== 'native') throw new Error('program-not-installed');
  if ((await officeVersion(ctx, program.binary)) === null) throw new Error('program-identity-unconfirmed');
  const targets = [
    { file: program.binary, stamp: await ctx.machine.treeStamp(program.binary) },
    ...(await officeUpdates(ctx, program.binary)),
  ];
  return work(
    targets.map(target =>
      removeProgramFile(ctx, { file: target.file, before: target.stamp }, [
        { code: 'program-uninstall', detail: target.file },
      ]),
    ),
  );
}

async function prepareOfficeNative(
  ctx: Context,
  program?: OfficeProgram,
): Promise<Prepared & { readonly targetVersion: string }> {
  if (program?.channel === 'manual') throw new Error('channel-not-supported');
  const action = program ? 'update' : 'install';
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
    read: (url: string, options?: { readonly timeoutMs: number }) => Promise<T>,
    timeoutMs: number,
  ): Promise<T> => {
    try {
      return await read(`${baseUrl}${name}`, { timeoutMs });
    } catch (error) {
      if (errorCode(error) === 'cancelled') throw error;
      // 上游官方镜像只作为传输备选，标签、文件名与摘要仍由 GitHub 发布约束
      return read(`${OFFICE_INTEGRATION.releaseMirror}/releases/download/${tag}/${name}`);
    }
  };
  const checksums = await fetchReleaseFile(
    'SHA256SUMS',
    (url, options) => ctx.machine.fetchText(url, options),
    CHECKSUM_DOWNLOAD_TIMEOUT_MS,
  );
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
    const currentVersion = await officeVersion(ctx, binary);
    if (currentVersion === null) throw new Error('program-version-unconfirmed');
    if (compareVersions(currentVersion, targetVersion) > 0) throw new Error('newer-version-preserved');
  }
  // 完整摘要与发布原件一致才复用，版本号相同但内容不同仍需下载校验
  const shouldKeepBinary = action === 'update' && before === digest;
  const bytes = shouldKeepBinary
    ? null
    : await fetchReleaseFile(
        assetName,
        (url, options) => ctx.machine.fetchBytes(url, options),
        PROGRAM_DOWNLOAD_TIMEOUT_MS,
      );
  if (bytes !== null && createHash('sha256').update(bytes).digest('hex') !== digest)
    throw new Error('release-checksum-mismatch');
  const removals = updates.map(target =>
    removeProgramFile(
      ctx,
      { file: target.file, before: target.stamp },
      target.stamp === null ? [] : [{ code: 'program-copy-remove', detail: target.file }],
    ),
  );
  const deploy = deployProgram(ctx, { binary, before, digest, bytes }, [
    {
      code: shouldKeepBinary ? 'program-kept' : PROGRAM_ACTION_CHANGE[action],
      detail: 'OfficeCLI · native · ' + targetVersion + ' · ' + binary,
    },
  ]);
  const ready = step([], async () => {
    if ((await ctx.machine.fingerprint(binary)) !== digest || (await officeVersion(ctx, binary)) !== targetVersion)
      throw new Error('program-not-ready');
    return { state: 'complete', effects: [{ state: 'done', code: 'program-ready' }] };
  });
  const userPath = programPath(ctx, path.dirname(binary), [
    { code: 'program-user-path', detail: path.dirname(binary) },
    { code: 'keep-user-data' },
  ]);
  return {
    ...sequence([...(removals.length ? [work(removals)] : []), deploy, ready, userPath]),
    action,
    targetVersion,
  };
}
async function officeRevision(ctx: Context, version: string): Promise<string> {
  if (!isExactVersion(version)) throw new Error('source-version-unavailable');
  const reference: unknown = JSON.parse(
    await ctx.machine.fetchText(`https://api.github.com/repos/${OFFICECLI_REPO_SLUG}/git/ref/tags/v${version}`),
  );
  if (!isObject(reference) || reference.ref !== 'refs/tags/v' + version || !isObject(reference.object))
    throw new Error('source-version-unavailable');
  let object = reference.object;
  // 技能固定到对应程序版本的提交，最多解引用四层附注标签
  for (let depth = 0; depth < MAX_TAG_DEREFERENCES; depth++) {
    if (typeof object.sha !== 'string' || !isGitRevision(object.sha)) throw new Error('source-version-unavailable');
    if (object.type === 'commit') return object.sha;
    if (object.type !== 'tag') throw new Error('source-version-unavailable');
    const tag: unknown = JSON.parse(
      await ctx.machine.fetchText(`https://api.github.com/repos/${OFFICECLI_REPO_SLUG}/git/tags/${object.sha}`),
    );
    if (!isObject(tag) || tag.sha !== object.sha || !isObject(tag.object))
      throw new Error('source-version-unavailable');
    object = tag.object;
  }
  throw new Error('source-version-unavailable');
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
function officeAsset(ctx: Context) {
  const arch = ctx.arch ?? process.arch;
  if (arch !== 'x64' && arch !== 'arm64') throw new Error('unsupported-architecture');
  if (ctx.platform === 'win32') return `officecli-win-${arch}.exe`;
  if (ctx.platform === 'darwin') return `officecli-mac-${arch}`;
  return `officecli-linux-${ctx.libc === 'musl' ? 'alpine-' : ''}${arch}`;
}

/** OfficeCLI 自行发现受管原生安装和只读的外部入口，不参与 npm 发现 */
async function officePrograms(ctx: Context): Promise<{ items: Item[]; values: Map<string, OfficeProgram> }> {
  const values = new Map<string, OfficeProgram>();
  const native = officeBinary(ctx);
  if ((await ctx.machine.treeStamp(native)) !== null) values.set('officecli', { channel: 'native', binary: native });
  for (const binary of await ctx.machine.locate('officecli')) {
    const canonical = await ctx.machine.realpath(binary);
    if (
      !canonical ||
      [...values.values()].some(
        program => samePath(ctx, program.binary, binary) || samePath(ctx, program.binary, canonical),
      )
    )
      continue;
    values.set('officecli:external:' + binary, { channel: 'manual', binary });
  }
  return {
    values,
    items: [...values.entries()].map(([id, program]) => ({
      id,
      title: knownTitle('officecli'),
      kind: 'officecli',
      location: program.binary,
      canInstall: program.channel !== 'manual',
      canUninstall: program.channel !== 'manual',
      facts: [
        { code: 'program-exists', detail: program.channel },
        ...(program.channel === 'manual' ? [{ code: 'external-program-preserved' }] : []),
      ],
    })),
  };
}

/**
 * 计算 OfficeCLI 固定入口：Windows 本地应用目录，其他平台用户 bin 目录
 *
 * @throws Error - 目录不是绝对路径或指向文件系统根时抛出 invalid-config-root
 */
function officeBinary(ctx: Context) {
  const root =
    ctx.platform === 'win32'
      ? path.join(ctx.localAppData ?? path.join(ctx.home, 'AppData/Local'), 'OfficeCli')
      : userBinDirectory(ctx);
  if (!path.isAbsolute(root) || path.resolve(root) === path.parse(path.resolve(root)).root)
    throw new Error('invalid-config-root');
  return path.join(root, ctx.platform === 'win32' ? 'officecli.exe' : 'officecli');
}
/**
 * 禁用自更新后探测 OfficeCLI 身份和版本
 *
 * @returns 经确认的三段版本，无法确认时为 null；命令调用拒绝仍向外传播
 * @remarks 版本与帮助探测共用五秒；版本输出缺少程序名时再查帮助
 */
async function officeVersion(ctx: Context, binary: string) {
  const deadlineMs = performance.now() + VERSION_PROBE_TIMEOUT_MS;
  const probe = (argument: string) =>
    ctx.machine.execute(binary, [argument], {
      env: { ...OFFICE_INTEGRATION.suppressSelfUpdate },
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
