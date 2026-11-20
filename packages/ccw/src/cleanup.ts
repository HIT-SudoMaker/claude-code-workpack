import path from 'node:path';
import { knownTitle } from './management-catalog.js';
import { claudeRunning } from './claude-program.js';
import { errorCode } from './machine.js';
import { normalizePath, unchanged } from './model.js';
import type { Context, Effect, Inspection, Prepared, Selection } from './model.js';
import { step } from './work.js';

const CATEGORIES = ['cache', 'history', 'memory', 'backups', 'runtime'] as const;
type Category = (typeof CATEGORIES)[number];
const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;
const BINARY_UNIT_BASE = 1024n;
const DIRECTORIES: Record<Category, readonly string[]> = {
  cache: ['cache', 'debug', 'image-cache', 'logs', 'paste-cache', 'statsig', 'usage-data'],
  history: ['file-history', 'shell-snapshots', 'sessions', 'projects'],
  memory: ['agent-memory', 'agent-memory-local', 'projects'],
  backups: ['backup', 'backups'],
  runtime: ['daemon/dispatch', 'daemon/pty-pids', 'jobs', 'session-env', 'tasks'],
};
const FILES: Record<Category, readonly string[]> = {
  cache: ['daemon.log', 'stats-cache.json'],
  history: ['history.jsonl'],
  memory: [],
  backups: [],
  runtime: ['daemon.lock', 'daemon.status.json'],
};

interface CleanupInventory {
  readonly files: readonly string[];
  readonly directories: readonly string[];
  readonly links: readonly string[];
  readonly totalSizeBytes: bigint;
}

/** 格式化字节数，使用整数运算将二进制单位舍入到一位小数 */
function formatSizeBytes(sizeBytes: bigint) {
  let unitIndex = 0;
  let bytesPerUnit = 1n;
  while (sizeBytes >= bytesPerUnit * BINARY_UNIT_BASE && unitIndex < SIZE_UNITS.length - 1) {
    bytesPerUnit *= BINARY_UNIT_BASE;
    unitIndex++;
  }
  if (unitIndex === 0) return `${sizeBytes} B`;
  const sizeTenths = (sizeBytes * 10n + bytesPerUnit / 2n) / bytesPerUnit;
  return `${sizeTenths / 10n}.${sizeTenths % 10n} ${SIZE_UNITS[unitIndex]}`;
}

/** 清点所选类别，按子目录优先的顺序记录可移除目录 */
async function collectCleanupInventory(ctx: Context, category: Category): Promise<CleanupInventory> {
  const files: string[] = [];
  const directories: string[] = [];
  const links: string[] = [];
  let totalSizeBytes = 0n;
  const canonicalRoot = await ctx.machine.realpath(ctx.claudeRoot);
  if (
    canonicalRoot !== null &&
    normalizePath(ctx.platform, canonicalRoot) !== normalizePath(ctx.platform, ctx.claudeRoot)
  )
    throw new Error('linked-parent');
  const belongsToCategory = (file: string) => {
    const parts = path.relative(ctx.claudeRoot, file).split(path.sep);
    return parts[0] !== 'projects' || (parts[2] === 'memory') === (category === 'memory');
  };
  const visitEntry = async (file: string, kind: 'file' | 'directory' | 'link', sizeBytes: bigint): Promise<boolean> => {
    const isInCategory = belongsToCategory(file);
    if (kind === 'link') {
      if (isInCategory) links.push(file);
      return false;
    }
    if (kind === 'file') {
      if (isInCategory) {
        files.push(file);
        totalSizeBytes += sizeBytes;
      }
      return isInCategory;
    }
    let canRemoveDirectory = isInCategory;
    for (const entry of await ctx.machine.entries(file))
      if (!(await visitEntry(path.join(file, entry.name), entry.kind, entry.sizeBytes))) canRemoveDirectory = false;
    if (canRemoveDirectory) directories.push(file);
    return canRemoveDirectory;
  };
  for (const [kind, names] of [
    ['directory', DIRECTORIES[category]],
    ['file', FILES[category]],
  ] as const)
    for (const name of names) {
      const file = path.join(ctx.claudeRoot, name);
      const canonicalPath = await ctx.machine.realpath(file);
      if (canonicalPath !== null && normalizePath(ctx.platform, canonicalPath) !== normalizePath(ctx.platform, file)) {
        links.push(file);
        continue;
      }
      const entry = (await ctx.machine.entries(path.dirname(file))).find(entry => entry.name === path.basename(file));
      if (!entry) continue;
      if (entry.kind !== 'link' && entry.kind !== kind) throw new Error('cleanup-type-changed');
      await visitEntry(file, entry.kind, entry.sizeBytes);
    }
  return { files, directories, links, totalSizeBytes };
}

/** 格式化检查与预览共用的清理明细 */
function formatCleanupSummary({ files, directories, totalSizeBytes }: CleanupInventory) {
  return `${files.length} 个文件 · ${directories.length} 个目录 · ${formatSizeBytes(totalSizeBytes)}`;
}

/**
 * 检查 Claude 可清理数据
 *
 * @returns 各类别的清理资格与清点明细，读取失败记在相应类别
 */
export async function inspectClaudeData(ctx: Context): Promise<Inspection> {
  const items = await Promise.all(
    CATEGORIES.map(async category => {
      const item = {
        id: 'data:' + category,
        title: knownTitle('data:' + category),
        kind: 'data' as const,
        location: ctx.claudeRoot,
      };
      try {
        const inventory = await collectCleanupInventory(ctx, category);
        return {
          ...item,
          canClean: inventory.files.length > 0 || inventory.directories.length > 0,
          facts: [
            { code: 'data-size', detail: formatCleanupSummary(inventory) },
            ...(inventory.links.length ? [{ code: 'data-links-kept', detail: String(inventory.links.length) }] : []),
          ],
        };
      } catch (error) {
        return { ...item, canClean: false, facts: [], problem: errorCode(error) };
      }
    }),
  );
  return { items, problems: [] };
}

/** 确认 Claude 已停止，进程状态不明时也阻止清理 */
async function requireClaudeStopped(ctx: Context) {
  const isRunning = await claudeRunning(ctx.machine);
  if (isRunning !== false) throw new Error(isRunning ? 'claude-running' : 'process-state-unconfirmed');
}

/**
 * 准备类别清理计划
 *
 * @returns 待确认的工作项，内部保留文件摘要
 * @throws Error - 类别无效、目标已变化、读取失败或无法确认 Claude 已停止时 Promise 拒绝
 * @remarks 准备时只读取目标，执行时仅移除清单内文件和空目录
 * 取消后由执行核心复核已发生的效果
 */
export async function prepareDataCleanup(ctx: Context, selection: Selection): Promise<Prepared> {
  const category = CATEGORIES.find(value => selection.id === `data:${value}`);
  if (!category || selection.action !== 'clean') throw new Error('unknown-selection');
  const inventory = await collectCleanupInventory(ctx, category);
  await requireClaudeStopped(ctx);
  const fileSnapshots = await Promise.all(
    inventory.files.map(async file => {
      const fingerprint = await ctx.machine.fingerprint(file);
      if (fingerprint === null) throw new Error('target-changed');
      return { file, fingerprint };
    }),
  );
  const checkCleanupTargets = async () => {
    await requireClaudeStopped(ctx);
    await collectCleanupInventory(ctx, category);
    for (const { file, fingerprint } of fileSnapshots) unchanged(await ctx.machine.fingerprint(file), fingerprint);
  };
  return {
    ...step(
      [
        { code: 'data-delete', detail: formatCleanupSummary(inventory) },
        { code: 'data-root', detail: ctx.claudeRoot },
        { code: 'data-permanent' },
        { code: 'data-keep-configuration' },
        ...(inventory.links.length ? [{ code: 'data-links-kept', detail: String(inventory.links.length) }] : []),
      ],
      async attempt => {
        if (!attempt.dispatched) {
          await checkCleanupTargets();
          return { state: 'ready' };
        }
        const remainingInventory = await collectCleanupInventory(ctx, category);
        if (remainingInventory.files.length || remainingInventory.directories.length)
          return { state: 'blocked', problem: attempt.receipt?.failure ?? 'cleanup-incomplete' };
        return { state: 'complete' };
      },
      async () => {
        const effects: Effect[] = [];
        try {
          await checkCleanupTargets();
          for (const { file, fingerprint } of fileSnapshots) {
            await requireClaudeStopped(ctx);
            await ctx.effects.removeFile(file, fingerprint);
            effects.push({ state: 'done', code: 'data-file-removed', detail: file });
          }
          for (const directory of inventory.directories) {
            await requireClaudeStopped(ctx);
            await ctx.effects.removeEmptyDirectory(directory);
          }
          if (!effects.length) effects.push({ state: 'done', code: 'data-cleared' });
          if (inventory.links.length)
            effects.push({ state: 'kept', code: 'data-links-kept', detail: String(inventory.links.length) });
          return { receipt: { kind: 'returned' as const, failure: null }, effects };
        } catch (error) {
          return { receipt: { kind: 'unknown' as const, failure: errorCode(error) }, effects };
        }
      },
    ),
    action: 'clean',
  };
}
