import path from 'node:path';

import { DATA_CATEGORY_KEYS, knownTitle } from './titles.js';
import type { DataCategory } from './titles.js';
import { errorCode } from './machine.js';
import { cancelled, claudeRunning, normalizePath, restOf } from './model.js';
import type { Change, Context, Domain, Item, Prepared } from './model.js';

const CATEGORIES = DATA_CATEGORY_KEYS;
/** 删除循环内周期复核 Claude 进程：删除可能跨越进程启动 */
const PROCESS_RECHECK_INTERVAL_MS = 1_000;
type Category = DataCategory;

/** 清理结果仍有保留（新增、再生或共享链接）时标题须警示：清理承诺删除所选数据，保留是异常；
 *  卸载/安装的保留项是承诺，不警示；发射点与消费表共用同名常量，新增保留码不得漏登记 */
const RESIDUE_REGENERATED = 'data-remains-or-regenerated';
const RESIDUE_LINK_KEPT = 'cleanup-link-kept';
export const CLEANUP_RESIDUE_CODES: readonly string[] = [RESIDUE_REGENERATED, RESIDUE_LINK_KEPT];
type Group = Category | 'projects';
interface DataFile {
  readonly file: string;
  readonly sizeBytes: bigint;
}
interface Candidate extends DataFile {
  readonly stamp: string;
}
interface Inventory {
  readonly files: DataFile[];
  readonly directories: string[];
  readonly problems: Change[];
  readonly preserved: Change[];
}
const DIRECTORIES: Readonly<Record<string, Group>> = {
  backup: 'backups',
  backups: 'backups',
  cache: 'cache',
  'daemon/dispatch': 'runtime',
  'daemon/pty-pids': 'runtime',
  debug: 'cache',
  'file-history': 'history',
  'image-cache': 'cache',
  jobs: 'runtime',
  logs: 'cache',
  'paste-cache': 'cache',
  projects: 'projects',
  'session-env': 'runtime',
  sessions: 'runtime',
  'shell-snapshots': 'history',
  statsig: 'cache',
  tasks: 'runtime',
  'usage-data': 'cache',
  'agent-memory': 'memory',
  'agent-memory-local': 'memory',
};
const FILES: Readonly<Record<string, Category>> = {
  'daemon.lock': 'runtime',
  'daemon.log': 'cache',
  'daemon.status.json': 'runtime',
  'history.jsonl': 'history',
  'stats-cache.json': 'cache',
};

function isCategory(value: string): value is Category {
  return CATEGORIES.some(category => category === value);
}
/** 人类可读字节：满 1024 即换算到下一单位（B/KB/MB/GB/TB），保留 1 位小数 */
export function formatBytes(bytes: bigint): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes * 10n;
  let unit = 0;
  while (unit < units.length - 1 && value >= 10n * 1024n) {
    value = (value + 512n) / 1024n;
    unit++;
  }
  return unit === 0 ? `${value / 10n} B` : `${value / 10n}.${value % 10n} ${units[unit]}`;
}
function size(files: readonly DataFile[]) {
  return `${files.length} · ${formatBytes(files.reduce((sum, file) => sum + file.sizeBytes, 0n))}`;
}

/** 「文件数 · 逻辑大小」事实的读取面：详情提取与空类别判定跟生产格式同处一地，消费者不反解格式 */
export const dataSizeDetailOf = (item: { readonly facts: readonly Change[] }) =>
  item.facts.find(fact => fact.code === 'data-size')?.detail;
export const isEmptyDataSize = (detail: string | undefined): boolean =>
  detail === undefined || detail.startsWith('0 · ');

/** 清点白名单；projects 的记忆独立选择，读取缺口按类别保留 */
async function candidates(ctx: Context, selected?: Category): Promise<Record<Category, Inventory>> {
  const empty = (): Inventory => ({ files: [], directories: [], problems: [], preserved: [] });
  const result = { cache: empty(), history: empty(), memory: empty(), backups: empty(), runtime: empty() };
  const groups = (group: Group): Category[] =>
    (group === 'projects' ? (['history', 'memory'] as const) : [group]).filter(
      category => !selected || category === selected,
    );
  const problem = (group: Group, file: string, error: unknown) => {
    for (const category of groups(group)) result[category].problems.push({ code: errorCode(error), detail: file });
  };
  const preserve = (group: Group, file: string) => {
    for (const category of groups(group)) result[category].preserved.push({ code: RESIDUE_LINK_KEPT, detail: file });
  };
  const regularFile = (file: string, category: Category, sizeBytes: bigint) => {
    if (!groups(category).length) return;
    result[category].files.push({ file, sizeBytes });
  };
  const walk = async (directory: string, group: Group, isRoot = false): Promise<void> => {
    if (!groups(group).length) return;
    const memoryBefore = result.memory.files.length + result.memory.directories.length;
    try {
      for (const entry of await ctx.machine.entries(directory)) {
        const file = path.join(directory, entry.name);
        const childGroup =
          group === 'projects' && entry.name === 'memory' && entry.kind === 'directory' ? 'memory' : group;
        if (entry.kind === 'link') {
          preserve(childGroup, file);
          continue;
        }
        if (entry.kind === 'directory') await walk(file, childGroup);
        else regularFile(file, group === 'projects' ? 'history' : group, entry.sizeBytes);
      }
      if (!isRoot)
        for (const category of groups(group)) {
          if (
            group !== 'projects' ||
            category !== 'memory' ||
            result.memory.files.length + result.memory.directories.length > memoryBefore
          )
            result[category].directories.push(directory);
        }
    } catch (error) {
      problem(group, directory, error);
    }
  };
  try {
    if (ctx.platform === 'win32' && /^[\\/]{2}/.test(ctx.claudeRoot)) throw new Error('cleanup-network-root');
    const real = await ctx.machine.realpath(ctx.claudeRoot);
    if (real !== null && normalizePath(ctx.platform, real) !== normalizePath(ctx.platform, ctx.claudeRoot))
      throw new Error('linked-parent');
  } catch (error) {
    for (const category of CATEGORIES) problem(category, ctx.claudeRoot, error);
    return result;
  }
  for (const [kind, roots] of [
    ['directory', DIRECTORIES],
    ['file', FILES],
  ] as const) {
    for (const [relative, group] of Object.entries(roots)) {
      if (!groups(group).length) continue;
      const file = path.join(ctx.claudeRoot, relative);
      try {
        const entry = (await ctx.machine.entries(path.dirname(file))).find(value => value.name === path.basename(file));
        if (!entry) continue;
        if (entry.kind === 'link') {
          preserve(group, file);
          continue;
        }
        if (entry.kind !== kind) throw new Error('cleanup-type-changed');
        if (entry.kind === 'directory') await walk(file, group, true);
        else if (group !== 'projects') regularFile(file, group, entry.sizeBytes);
      } catch (error) {
        problem(group, file, error);
      }
    }
  }
  return result;
}

/** 创建清理域渠道：检查数组归一为聚合，余段即数据类别，clean 是唯一动作 */
export function createCleanupDomain(ctx: Context): Domain {
  return {
    async inspect() {
      return { items: await inspectCleanup(ctx), problems: [] };
    },
    prepare(selection) {
      const category = restOf(selection.id);
      if (category === undefined || selection.action !== 'clean') throw new Error('unknown-selection');
      return prepareCleanup(ctx, category);
    },
  };
}

async function inspectCleanup(ctx: Context): Promise<Item[]> {
  const found = await candidates(ctx);
  return CATEGORIES.map(category => {
    const inventory = found[category];
    return {
      id: `data:${category}`,
      title: knownTitle(`data:${category}`),
      kind: 'data',
      location: ctx.claudeRoot,
      facts: [{ code: 'data-size', detail: size(inventory.files) }, ...inventory.preserved, ...inventory.problems],
      ...(inventory.problems.length ? { problem: 'cleanup-inspection-incomplete' } : {}),
      actions: inventory.files.length || inventory.directories.length || inventory.problems.length ? ['clean'] : [],
    };
  });
}

async function prepareCleanup(ctx: Context, category: string): Promise<Prepared> {
  if (!isCategory(category)) throw new Error('invalid-data-category');
  const inventory = (await candidates(ctx, category))[category];
  if (inventory.problems.length) throw new Error('cleanup-inspection-incomplete');
  const files: Candidate[] = [];
  const { directories } = inventory;
  for (const file of inventory.files) {
    const stamp = await ctx.machine.fingerprint(file.file);
    if (stamp !== null) files.push({ ...file, stamp });
  }
  let index = 0;
  let directoryIndex = 0;
  let isComplete = false;
  const removed: Candidate[] = [];
  const operation: Prepared = {
    get changes() {
      return [
        { code: 'data-delete', detail: `${knownTitle(`data:${category}`)} · ${size(files.slice(index))}` },
        { code: 'data-clean-root', detail: ctx.claudeRoot },
        { code: 'no-recovery' },
        { code: 'keep-settings-credentials' },
        ...(category === 'runtime' ? [{ code: 'data-runtime-impact' }] : []),
        ...inventory.preserved,
        ...(directories.length > directoryIndex
          ? [{ code: 'data-empty-directories', detail: `${directories.length - directoryIndex}` }]
          : []),
      ];
    },
    async run(report, signal) {
      let checkedAtMs = 0;
      const checkProcess = async () => {
        cancelled(signal);
        const isClaudeRunning = await claudeRunning(ctx.machine, signal);
        cancelled(signal);
        if (isClaudeRunning !== false) throw new Error('claude-may-be-running');
        checkedAtMs = performance.now();
      };
      await checkProcess();
      while (index < files.length) {
        cancelled(signal);
        if (performance.now() - checkedAtMs >= PROCESS_RECHECK_INTERVAL_MS) await checkProcess();
        const file = files[index];
        if (!file) break;
        if ((await ctx.machine.treeStamp(file.file, signal)) === null) {
          index++;
          report({ state: 'kept', code: 'data-file-absent', detail: file.file });
          continue;
        }
        try {
          await ctx.effects.removeTree(file.file, file.stamp);
        } catch (error) {
          if ((await ctx.machine.treeStamp(file.file, signal)) !== null) throw error;
        }
        removed.push(file);
        index++;
        report({ state: 'done', code: 'data-file-removed', detail: file.file });
      }
      while (directoryIndex < directories.length) {
        cancelled(signal);
        if (performance.now() - checkedAtMs >= PROCESS_RECHECK_INTERVAL_MS) await checkProcess();
        const directory = directories[directoryIndex];
        if (!directory) break;
        await ctx.effects.removeEmptyDirectory(directory);
        directoryIndex++;
      }
      cancelled(signal);
      const remaining = (await candidates(ctx, category))[category];
      if (remaining.problems.length) {
        for (const problem of remaining.problems) report({ state: 'kept', ...problem });
        throw new Error('cleanup-inspection-incomplete');
      }
      await checkProcess();
      isComplete = true;
      report({ state: 'done', code: 'data-selected-cleared', detail: size(removed) });
      for (const preserved of remaining.preserved) report({ state: 'kept', ...preserved });
      if (remaining.files.length) report({ state: 'kept', code: RESIDUE_REGENERATED, detail: size(remaining.files) });
      if (files.length === 0 && directories.length === 0) report({ state: 'kept', code: 'no-data' });
    },
    remaining: () => (isComplete ? undefined : operation),
  };
  return operation;
}

/** 删除明确选择的整个配置根；首次删除读取当前内容，继续只处理原目标并保护已删路径的重建 */
export async function prepareClaudeDataRemoval(ctx: Context, verifyPrograms: () => Promise<void>): Promise<Prepared> {
  const normalize = (file: string) => normalizePath(ctx.platform, file);
  const contains = (directory: string, file: string) =>
    normalize(file) === normalize(directory) || normalize(file).startsWith(`${normalize(directory)}${path.sep}`);
  if (
    contains(ctx.claudeRoot, ctx.home) ||
    contains(ctx.claudeRoot, ctx.storage) ||
    contains(ctx.storage, ctx.claudeRoot)
  )
    throw new Error('invalid-data-root');
  if (
    !contains(ctx.claudeRoot, ctx.stateFile) &&
    normalize(ctx.stateFile) !== normalize(path.join(ctx.home, '.claude.json'))
  )
    throw new Error('invalid-data-root');
  const targets = [
    { file: ctx.claudeRoot, kind: 'directory' as const },
    ...(!contains(ctx.claudeRoot, ctx.stateFile) ? [{ file: ctx.stateFile, kind: 'file' as const }] : []),
  ];
  const checkTarget = async (target: (typeof targets)[number]) => {
    if (!path.isAbsolute(target.file)) throw new Error('invalid-data-root');
    if (ctx.platform === 'win32' && /^[\\/]{2}/.test(target.file)) throw new Error('cleanup-network-root');
    const parent = await ctx.machine.realpath(path.dirname(target.file));
    const real = await ctx.machine.realpath(target.file);
    if (
      (parent !== null && normalize(parent) !== normalize(path.dirname(target.file))) ||
      (real !== null && normalize(real) !== normalize(target.file))
    )
      throw new Error('linked-parent');
    const entry = (await ctx.machine.entries(path.dirname(target.file))).find(
      value => normalize(path.join(path.dirname(target.file), value.name)) === normalize(target.file),
    );
    if (entry && entry.kind !== target.kind) throw new Error('cleanup-type-changed');
    return entry !== undefined;
  };
  const pending: {
    file: string;
    kind: 'directory' | 'file';
    hasExisted: boolean;
    hasAttemptedRemoval: boolean;
    stamp: string | null;
    isDone: boolean;
  }[] = await Promise.all(
    targets.map(async target => ({
      ...target,
      hasExisted: await checkTarget(target),
      hasAttemptedRemoval: false,
      stamp: null,
      isDone: false,
    })),
  );
  let isComplete = false;
  const checkProcess = async (signal?: AbortSignal) => {
    cancelled(signal);
    const isClaudeRunning = await claudeRunning(ctx.machine, signal);
    cancelled(signal);
    if (isClaudeRunning !== false) throw new Error(isClaudeRunning ? 'claude-running' : 'process-state-unconfirmed');
  };
  await checkProcess();
  const verify = async () => {
    for (const target of pending)
      if ((await ctx.machine.treeStamp(target.file)) !== null) throw new Error('target-changed');
  };
  const operation: Prepared = {
    get changes() {
      return [
        ...pending
          .filter(target => !target.isDone)
          .map(target => ({
            code: target.kind === 'directory' ? 'claude-data-remove' : 'claude-state-remove',
            detail: target.file,
          })),
        { code: 'claude-data-impact' },
        { code: 'no-recovery' },
      ];
    },
    async run(report, signal) {
      await checkProcess(signal);
      await verifyPrograms();
      for (const target of pending) {
        const isPresent = await checkTarget(target);
        if (isPresent && (target.isDone || !target.hasExisted)) throw new Error('target-changed');
      }
      for (const target of pending) {
        if (target.isDone) continue;
        await checkProcess(signal);
        await checkTarget(target);
        const current = await (
          target.kind === 'file'
            ? ctx.machine.fingerprint(target.file, signal)
            : ctx.machine.treeStamp(target.file, signal)
        ).catch(error => {
          cancelled(signal);
          throw error;
        });
        if (current !== null) {
          if (!target.hasExisted) throw new Error('target-changed');
          if (target.hasAttemptedRemoval && current !== target.stamp) throw new Error('target-changed');
          target.stamp = current;
          target.hasAttemptedRemoval = true;
          await checkProcess(signal);
          try {
            if (target.kind === 'file') await ctx.effects.remove(target.file, current);
            else await ctx.effects.removeTree(target.file, current);
          } catch (error) {
            if ((await ctx.machine.treeStamp(target.file, signal)) !== null) throw error;
          }
        }
        target.isDone = true;
        report({
          state: current === null ? 'kept' : 'done',
          code: current === null ? 'data-file-absent' : 'claude-data-removed',
          detail: target.file,
        });
      }
      await verify();
      isComplete = true;
      report({ state: 'done', code: 'claude-data-cleared' });
    },
    remaining: () => (isComplete ? undefined : operation),
    verify,
  };
  return operation;
}
