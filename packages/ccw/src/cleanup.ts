import path from 'node:path';
import { createHash } from 'node:crypto';

import { DATA_CATEGORY_KEYS, knownTitle } from './titles.js';
import type { DataCategory } from './titles.js';
import { errorCode, isObject } from './machine.js';
import { cancelled, claudeRunning, normalizePath, restOf } from './model.js';
import type {
  Change,
  Context,
  Domain,
  Item,
  Prepared,
  OperationDefinition,
  OperationFact,
  OperationHandler,
  JsonObject,
} from './model.js';

const CATEGORIES = DATA_CATEGORY_KEYS;
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
    handlers: cleanupHandlers(ctx),
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

interface RemovalTarget {
  readonly file: string;
  readonly kind: 'file' | 'directory';
}
interface RemovalPayload extends RemovalTarget {
  readonly wholeRoot: boolean;
  readonly present: boolean;
  readonly stamp: string | null;
}
function removalPayload(definition: OperationDefinition): RemovalPayload {
  const value = definition.payload;
  const valid = (value: unknown): value is RemovalPayload =>
    isObject(value) &&
    typeof value.file === 'string' &&
    (value.kind === 'file' || value.kind === 'directory') &&
    typeof value.wholeRoot === 'boolean' &&
    typeof value.present === 'boolean' &&
    (value.stamp === null || typeof value.stamp === 'string');
  if (!valid(value)) throw new Error('operation-record-invalid');
  return value;
}
function textField(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') throw new Error('operation-record-invalid');
  return value;
}
const targetId = (file: string) => createHash('sha256').update(file).digest('hex').slice(0, 20);
const operation = (
  itemId: string,
  suffix: string,
  handler: string,
  payload: JsonObject,
  changes: readonly Change[] = [],
  dependsOn: readonly string[] = [],
): OperationDefinition => ({
  id: itemId + '/' + suffix,
  itemId,
  handler,
  payload,
  changes,
  dependsOn,
});

/** Scope and target kind are checked on every assessment, including after a restart. */
async function checkTarget(ctx: Context, target: RemovalTarget) {
  const normalize = (file: string) => normalizePath(ctx.platform, file);
  if (!path.isAbsolute(target.file)) throw new Error('invalid-data-root');
  if (ctx.platform === 'win32' && /^[\\/]{2}/.test(target.file)) throw new Error('cleanup-network-root');
  const parent = path.dirname(target.file);
  const canonicalParent = await ctx.machine.realpath(parent);
  const canonical = await ctx.machine.realpath(target.file);
  if (
    (canonicalParent !== null && normalize(canonicalParent) !== normalize(parent)) ||
    (canonical !== null && normalize(canonical) !== normalize(target.file))
  )
    throw new Error('linked-parent');
  const entry = (await ctx.machine.entries(parent)).find(
    value => normalize(path.join(parent, value.name)) === normalize(target.file),
  );
  if (entry && entry.kind !== target.kind) throw new Error('cleanup-type-changed');
  return entry !== undefined;
}
async function checkProcess(ctx: Context, wholeRoot = false, signal?: AbortSignal) {
  cancelled(signal);
  const running = await claudeRunning(ctx.machine, signal);
  cancelled(signal);
  if (running !== false)
    throw new Error(wholeRoot ? (running ? 'claude-running' : 'process-state-unconfirmed') : 'claude-may-be-running');
}
const canRetryRemoval = (fact: OperationFact) =>
  !fact.attemptId ||
  (fact.receipt?.kind === 'returned' && fact.receipt.failure !== null) ||
  fact.evidence?.unchangedSinceDispatch === true;

function cleanupHandlers(ctx: Context): Readonly<Record<string, OperationHandler>> {
  return {
    'cleanup.remove': {
      async assess(definition, fact) {
        const { file, kind, wholeRoot, present, stamp } = removalPayload(definition);
        await checkTarget(ctx, { file, kind });
        const current = await ctx.machine.treeStamp(file);
        if ((fact.confirmed || fact.evidence?.absent === true) && current !== null) {
          if (wholeRoot) return { state: 'unknown', problem: 'target-changed' };
          return {
            state: 'complete',
            evidence: { preserved: true },
            effects: [{ state: 'kept', code: RESIDUE_REGENERATED, detail: file }],
          };
        }
        if (current === null)
          return {
            state: 'complete',
            evidence: { absent: true },
            effects: [
              {
                state: fact.attemptId ? 'done' : 'kept',
                code: fact.attemptId ? (wholeRoot ? 'claude-data-removed' : 'data-file-removed') : 'data-file-absent',
                detail: file,
              },
            ],
          };
        if (!present) return { state: 'unknown', problem: 'target-changed' };
        const expected = fact.dispatch?.stamp ?? stamp;
        if (expected !== null && current !== expected) return { state: 'unknown', problem: 'target-changed' };
        await checkProcess(ctx, wholeRoot);
        if (!canRetryRemoval(fact)) return { state: 'unknown', problem: 'removal-unconfirmed' };
        return { state: 'ready', dispatch: { stamp: current } };
      },
      async execute(definition, fact, _inputs, signal) {
        const { file, kind, wholeRoot } = removalPayload(definition);
        await checkProcess(ctx, wholeRoot, signal);
        await checkTarget(ctx, { file, kind });
        const stamp = fact.dispatch?.stamp;
        if (typeof stamp !== 'string') throw new Error('target-changed');
        try {
          if (wholeRoot && kind === 'file') await ctx.effects.remove(file, stamp);
          else await ctx.effects.removeTree(file, stamp);
          return {
            receipt: { kind: 'returned', failure: null },
            evidence: { absent: true },
            effects: [{ state: 'done', code: wholeRoot ? 'claude-data-removed' : 'data-file-removed', detail: file }],
          };
        } catch (error) {
          const receipt = { kind: 'unknown' as const, failure: errorCode(error) };
          try {
            const current = await ctx.machine.treeStamp(file);
            return { receipt, evidence: { unchangedSinceDispatch: current === stamp, absent: current === null } };
          } catch {
            return { receipt };
          }
        }
      },
    },
    'cleanup.empty-directory': {
      async assess(definition, fact) {
        const file = textField(definition.payload, 'file');
        const exists = await checkTarget(ctx, { file, kind: 'directory' });
        if (!exists || fact.confirmed) return { state: 'complete', evidence: { absent: !exists } };
        if ((await ctx.machine.entries(file)).length) return { state: 'complete', evidence: { preserved: true } };
        await checkProcess(ctx);
        if (!canRetryRemoval(fact)) return { state: 'unknown', problem: 'removal-unconfirmed' };
        return { state: 'ready' };
      },
      async execute(definition, _fact, _inputs, signal) {
        await checkProcess(ctx, false, signal);
        await checkTarget(ctx, { file: textField(definition.payload, 'file'), kind: 'directory' });
        await ctx.effects.removeEmptyDirectory(textField(definition.payload, 'file'));
        return { receipt: { kind: 'returned', failure: null } };
      },
    },
    'cleanup.verify': {
      async assess(definition) {
        const category = textField(definition.payload, 'category');
        if (!isCategory(category)) throw new Error('operation-record-invalid');
        await checkProcess(ctx);
        const inventory = (await candidates(ctx, category))[category];
        if (inventory.problems.length) throw new Error('cleanup-inspection-incomplete');
        return {
          state: 'complete',
          evidence: { checked: true },
          effects: [
            { state: 'done', code: 'data-selected-cleared', detail: textField(definition.payload, 'size') },
            ...inventory.preserved.map(value => ({ state: 'kept' as const, ...value })),
            ...(inventory.files.length
              ? [{ state: 'kept' as const, code: RESIDUE_REGENERATED, detail: size(inventory.files) }]
              : []),
            ...(definition.payload.empty ? [{ state: 'kept' as const, code: 'no-data' }] : []),
          ],
        };
      },
      execute: () => Promise.reject(new Error('read-only-operation')),
    },
    'cleanup.claude-verify': {
      async assess(definition) {
        await checkProcess(ctx, true);
        const targets = definition.payload.targets;
        if (!Array.isArray(targets) || !targets.every(value => typeof value === 'string'))
          throw new Error('operation-record-invalid');
        for (const file of targets) if ((await ctx.machine.treeStamp(file)) !== null) throw new Error('target-changed');
        return {
          state: 'complete',
          evidence: { absent: true },
          effects: [{ state: 'done', code: 'claude-data-cleared' }],
        };
      },
      execute: () => Promise.reject(new Error('read-only-operation')),
    },
  };
}

async function prepareCleanup(ctx: Context, category: string): Promise<Prepared> {
  if (!isCategory(category)) throw new Error('invalid-data-category');
  const inventory = (await candidates(ctx, category))[category];
  if (inventory.problems.length) throw new Error('cleanup-inspection-incomplete');
  const files: Candidate[] = [];
  for (const file of inventory.files) {
    const stamp = await ctx.machine.fingerprint(file.file);
    if (stamp !== null) files.push({ ...file, stamp });
  }
  const itemId = 'data:' + category;
  const changes: Change[] = [
    { code: 'data-delete', detail: knownTitle(itemId) + ' · ' + size(files) },
    { code: 'data-clean-root', detail: ctx.claudeRoot },
    { code: 'no-recovery' },
    { code: 'keep-settings-credentials' },
    ...(category === 'runtime' ? [{ code: 'data-runtime-impact' }] : []),
    ...inventory.preserved,
    ...(inventory.directories.length
      ? [{ code: 'data-empty-directories', detail: String(inventory.directories.length) }]
      : []),
  ];
  const operations = files.map(file =>
    operation(itemId, 'file-' + targetId(file.file), 'cleanup.remove', {
      file: file.file,
      kind: 'file',
      stamp: file.stamp,
      present: true,
      wholeRoot: false,
    }),
  );
  for (const file of inventory.directories)
    operations.push(
      operation(
        itemId,
        'directory-' + targetId(file),
        'cleanup.empty-directory',
        { file },
        [],
        operations
          .filter(value => typeof value.payload.file === 'string' && value.payload.file.startsWith(file + path.sep))
          .map(value => value.id),
      ),
    );
  operations.push(
    operation(
      itemId,
      'verified',
      'cleanup.verify',
      {
        category,
        size: size(files),
        empty: files.length === 0 && inventory.directories.length === 0,
      },
      changes,
      operations.map(value => value.id),
    ),
  );
  return { operations };
}

/** Dependencies are the frozen absence checks for every selected Claude program. */
export async function prepareClaudeDataRemoval(ctx: Context, dependencies: readonly string[]): Promise<Prepared> {
  const normalize = (file: string) => normalizePath(ctx.platform, file);
  const contains = (directory: string, file: string) =>
    normalize(file) === normalize(directory) || normalize(file).startsWith(normalize(directory) + path.sep);
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
  const targets: RemovalTarget[] = [
    { file: ctx.claudeRoot, kind: 'directory' },
    ...(!contains(ctx.claudeRoot, ctx.stateFile) ? [{ file: ctx.stateFile, kind: 'file' as const }] : []),
  ];
  await checkProcess(ctx, true);
  const operations: OperationDefinition[] = [];
  for (const target of targets)
    operations.push(
      operation(
        'data:claude',
        targetId(target.file),
        'cleanup.remove',
        {
          ...target,
          present: await checkTarget(ctx, target),
          wholeRoot: true,
          stamp: null,
        },
        [{ code: target.kind === 'directory' ? 'claude-data-remove' : 'claude-state-remove', detail: target.file }],
        [...dependencies, ...operations.map(value => value.id)],
      ),
    );
  operations.push(
    operation(
      'data:claude',
      'verified',
      'cleanup.claude-verify',
      {
        targets: targets.map(target => target.file),
      },
      [{ code: 'claude-data-impact' }, { code: 'no-recovery' }],
      operations.map(value => value.id),
    ),
  );
  return { operations };
}
