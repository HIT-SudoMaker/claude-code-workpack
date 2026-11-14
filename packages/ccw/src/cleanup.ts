import path from 'node:path';
import { knownTitle } from './management-catalog.js';
import { claudeRunning } from './claude-program.js';
import { errorCode } from './machine.js';
import { normalizePath, restOf, unchanged } from './model.js';
import type { Context, Effect, Inspection, Prepared, Selection } from './model.js';
import { step } from './work.js';

const CATEGORIES = ['cache', 'history', 'memory', 'backups', 'runtime'] as const;
type Category = (typeof CATEGORIES)[number];
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const BINARY_UNIT_BASE = 1024;
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

function size(bytes: bigint) {
  let value = Number(bytes),
    unit = 0;
  while (value >= BINARY_UNIT_BASE && unit < SIZE_UNITS.length - 1) {
    value /= BINARY_UNIT_BASE;
    unit++;
  }
  return `${unit ? value.toFixed(1) : value} ${SIZE_UNITS[unit]}`;
}

async function inventory(ctx: Context, category: Category) {
  const files: { file: string; size: bigint }[] = [];
  const directories: string[] = [];
  const links: string[] = [];
  const real = await ctx.machine.realpath(ctx.claudeRoot);
  if (real !== null && normalizePath(ctx.platform, real) !== normalizePath(ctx.platform, ctx.claudeRoot))
    throw new Error('linked-parent');
  const belongs = (file: string) => {
    const parts = path.relative(ctx.claudeRoot, file).split(path.sep);
    return parts[0] !== 'projects' || (parts[2] === 'memory') === (category === 'memory');
  };
  const visit = async (file: string, kind: 'file' | 'directory' | 'link', bytes: bigint): Promise<boolean> => {
    if (kind === 'link') {
      if (belongs(file)) links.push(file);
      return false;
    }
    if (kind === 'file') {
      if (belongs(file)) files.push({ file, size: bytes });
      return belongs(file);
    }
    let removable = belongs(file);
    for (const entry of await ctx.machine.entries(file))
      if (!(await visit(path.join(file, entry.name), entry.kind, entry.sizeBytes))) removable = false;
    if (removable) directories.push(file);
    return removable;
  };
  for (const [kind, names] of [
    ['directory', DIRECTORIES[category]],
    ['file', FILES[category]],
  ] as const)
    for (const name of names) {
      const file = path.join(ctx.claudeRoot, name);
      const canonical = await ctx.machine.realpath(file);
      if (canonical !== null && normalizePath(ctx.platform, canonical) !== normalizePath(ctx.platform, file)) {
        links.push(file);
        continue;
      }
      const entry = (await ctx.machine.entries(path.dirname(file))).find(entry => entry.name === path.basename(file));
      if (!entry) continue;
      if (entry.kind !== 'link' && entry.kind !== kind) throw new Error('cleanup-type-changed');
      await visit(file, entry.kind, entry.sizeBytes);
    }
  return {
    files,
    directories,
    links,
    detail: `${files.length} 个文件 · ${directories.length} 个目录 · ${size(files.reduce((sum, file) => sum + file.size, 0n))}`,
  };
}

/** 清点白名单数据，保留配置、凭据、插件和 Skills */
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
        const found = await inventory(ctx, category);
        return {
          ...item,
          canClean: found.files.length > 0 || found.directories.length > 0,
          facts: [
            { code: 'data-size', detail: found.detail },
            ...(found.links.length ? [{ code: 'data-links-kept', detail: String(found.links.length) }] : []),
          ],
        };
      } catch (error) {
        return { ...item, canClean: false, facts: [], problem: errorCode(error) };
      }
    }),
  );
  return { items, problems: [] };
}

async function requireStopped(ctx: Context) {
  const running = await claudeRunning(ctx.machine);
  if (running !== false) throw new Error(running ? 'claude-running' : 'process-state-unconfirmed');
}

/** 删除已确认的类别快照，保留 Claude 配置根目录 */
export async function prepareDataCleanup(ctx: Context, selection: Selection): Promise<Prepared> {
  const category = CATEGORIES.find(value => value === restOf(selection.id));
  if (!category || selection.action !== 'clean') throw new Error('unknown-selection');
  const found = await inventory(ctx, category);
  await requireStopped(ctx);
  const files = await Promise.all(
    found.files.map(async file => ({ ...file, stamp: await ctx.machine.fingerprint(file.file) })),
  );
  const before = async () => {
    await requireStopped(ctx);
    await inventory(ctx, category);
    for (const file of files) unchanged(await ctx.machine.fingerprint(file.file), file.stamp);
  };
  return {
    ...step(
      [
        { code: 'data-delete', detail: found.detail },
        { code: 'data-root', detail: ctx.claudeRoot },
        { code: 'data-permanent' },
        { code: 'data-keep-configuration' },
        ...(found.links.length ? [{ code: 'data-links-kept', detail: String(found.links.length) }] : []),
      ],
      async fact => {
        if (!fact.dispatched) {
          await before();
          return { state: 'ready' };
        }
        const current = await inventory(ctx, category);
        if (current.files.length || current.directories.length)
          return { state: 'blocked', problem: fact.receipt?.failure ?? 'cleanup-incomplete' };
        return { state: 'complete' };
      },
      async () => {
        const effects: Effect[] = [];
        try {
          await before();
          for (const file of files) {
            await requireStopped(ctx);
            if (file.stamp !== null) await ctx.effects.removeTree(file.file, file.stamp);
            effects.push({ state: 'done', code: 'data-file-removed', detail: file.file });
          }
          for (const directory of found.directories) {
            if ((await ctx.machine.entries(directory)).length) continue;
            const stamp = await ctx.machine.treeStamp(directory);
            if (stamp !== null) {
              await requireStopped(ctx);
              await ctx.effects.removeTree(directory, stamp);
            }
          }
          if (!effects.length) effects.push({ state: 'done', code: 'data-cleared' });
          if (found.links.length)
            effects.push({ state: 'kept', code: 'data-links-kept', detail: String(found.links.length) });
          return { receipt: { kind: 'returned' as const, failure: null }, effects };
        } catch (error) {
          return { receipt: { kind: 'unknown' as const, failure: errorCode(error) }, effects };
        }
      },
    ),
    action: 'clean',
  };
}
