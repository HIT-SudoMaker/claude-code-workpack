import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createCcw } from '../dist/ccw.js';
import { createMachine } from '../dist/machine.js';
import { formatBytes } from '../dist/cleanup.js';
import { HOME_TITLE } from '../dist/render.js';
import { describeResult } from '../dist/run-presentation.js';
import { runTerminal } from './terminal-test.mjs';
import { createEnv } from './env.mjs';

test('人类可读字节换算', () => {
  assert.equal(formatBytes(0n), '0 B');
  assert.equal(formatBytes(512n), '512 B');
  assert.equal(formatBytes(1023n), '1023 B');
  assert.equal(formatBytes(1536n), '1.5 KB');
  assert.equal(formatBytes(10240n), '10.0 KB');
  assert.equal(formatBytes(1048575n), '1.0 MB');
  assert.equal(formatBytes(1048576n), '1.0 MB');
  assert.equal(formatBytes(1610612736n), '1.5 GB');
  assert.equal(formatBytes(1073741824n * 1024n), '1.0 TB');
});

const directories = [
  'backup',
  'backups',
  'cache',
  'daemon/dispatch',
  'daemon/pty-pids',
  'debug',
  'file-history',
  'image-cache',
  'jobs',
  'logs',
  'paste-cache',
  'projects',
  'session-env',
  'sessions',
  'shell-snapshots',
  'statsig',
  'tasks',
  'usage-data',
];
const files = ['daemon.lock', 'daemon.log', 'daemon.status.json', 'history.jsonl', 'stats-cache.json'];
const ids = ['data:cache', 'data:history', 'data:memory', 'data:backups', 'data:runtime'];
async function fixture(t, platform = process.platform) {
  const f = await createEnv(t, { layout: 'home' });
  const state = {
    running: false, // 进程枚举缺省意图：空枚举＝未在运行
    onCheck: null, // 进程检查钩子：false→空枚举、true→命中条目、null→枚举未知
    onRemoveTree: null, // removeTree 完成后的钩子（时钟回拨/复核失败场景）
    failRemoveOn: null, // 第 N 次 removeTree 直接抛错（不执行删除）
    unreadableAfterFailure: false,
    failRemoveRead: false, // 删除后回读失败：完成工作再抛出，并拉起 treeStamp 闩锁
    treeStampFails: false, // treeStamp 读取失败闩锁
    entriesFails: false, // entries 读取失败（全部目录）
    blockedEntries: null, // 指定目录的 entries 抛错
    removeTreeCalls: 0,
  };
  const wrapped = f.machine({
    processes: async () => {
      const running = state.onCheck ? await state.onCheck() : state.running;
      return running === null ? null : running ? [{ name: 'claude.exe', command: 'claude --resume' }] : [];
    },
  });
  const machine = {
    ...wrapped,
    async removeTree(...args) {
      state.removeTreeCalls++;
      if (state.failRemoveOn !== null && state.removeTreeCalls === state.failRemoveOn) {
        state.treeStampFails = state.unreadableAfterFailure;
        throw new Error('remove-failed');
      }
      const result = await wrapped.removeTree(...args);
      if (state.onRemoveTree) await state.onRemoveTree(args[0]);
      if (state.failRemoveRead) {
        state.treeStampFails = true;
        throw new Error('read-failed');
      }
      return result;
    },
    async treeStamp(...args) {
      if (state.treeStampFails) throw new Error('read-failed');
      return wrapped.treeStamp(...args);
    },
    async entries(directory) {
      if (state.entriesFails || directory === state.blockedEntries) throw new Error('read-failed');
      return wrapped.entries(directory);
    },
  };
  const ccw = f.ccw(machine, { platform });
  const write = async (relative, text = relative) => {
    const file = path.join(f.claudeRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return file;
  };
  const exists = async relative =>
    fs.lstat(path.join(f.claudeRoot, relative)).then(
      () => true,
      () => false,
    );
  const plan = selected => ccw.plan({ task: 'clean', selected: selected.map(id => ({ id })) });
  return { ...f, state, machine, ccw, write, exists, plan };
}

test('核对清理白名单：匹配 BAT', async () => {
  const script = await fs.readFile(new URL('./fixtures/claude_and_codex_cleaner.bat', import.meta.url), 'utf8');
  const block = script.slice(script.indexOf('claude = @{'), script.indexOf('codex = @{'));
  const entries = label =>
    [...block.match(new RegExp(`${label} = @\\(([\\s\\S]*?)\\)`))[1].matchAll(/'([^']+)'/g)].map(match =>
      match[1].replaceAll('\\', '/'),
    );
  assert.deepEqual(entries('Dirs'), directories);
  assert.deepEqual(entries('Files'), files);
});

for (const platform of ['win32', 'darwin', 'linux'])
  test(`${platform} 清理全部数据：保留程序与配置`, async t => {
    const f = await fixture(t, platform);
    for (const directory of directories) await f.write(`${directory}/nested/data.bin`);
    for (const file of files) await f.write(file);
    await f.write('projects/project/memory/MEMORY.md');
    await f.write('agent-memory/test/MEMORY.md');
    const protectedFiles = [
      'settings.json',
      '.credentials.json',
      '.claude.json',
      'CLAUDE.md',
      'skills/test/SKILL.md',
      'rules/test.md',
      'plugins/test/config.json',
      'ccline/ccline.exe',
      'ccline/config.toml',
      'daemon/keep.json',
      'unknown/keep.txt',
    ];
    for (const file of protectedFiles) await f.write(file);
    await fs.mkdir(path.join(f.home, '.codex'), { recursive: true });
    await fs.writeFile(path.join(f.home, '.codex/history.jsonl'), 'keep codex');
    const view = await f.ccw.inspect('data');
    assert.deepEqual(
      view.items.map(item => item.id),
      ids,
    );
    assert.ok(view.items.every(item => item.actions.includes('clean')));
    const plan = await f.plan(ids);
    assert.ok(
      plan.items.every(item => item.problem === null),
      JSON.stringify(plan),
    );
    assert.equal((await f.ccw.apply(plan.id)).state, 'done');
    for (const directory of directories)
      assert.deepEqual(await fs.readdir(path.join(f.claudeRoot, directory)), [], directory);
    for (const file of files) assert.equal(await f.exists(file), false, file);
    for (const file of protectedFiles) assert.equal(await fs.readFile(path.join(f.claudeRoot, file), 'utf8'), file);
    assert.equal(await fs.readFile(path.join(f.home, '.codex/history.jsonl'), 'utf8'), 'keep codex');
  });

test('清理历史：保留记忆和运行状态', async t => {
  const f = await fixture(t);
  for (const file of [
    'projects/p/transcript.jsonl',
    'projects/p/tool-results/result.txt',
    'projects/p/memory/MEMORY.md',
    'sessions/session.json',
  ])
    await f.write(file);
  const plan = await f.plan(['data:history']);
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.equal(await f.exists('projects/p/tool-results/result.txt'), false);
  assert.equal(await f.exists('projects/p/memory/MEMORY.md'), true);
  assert.equal(await f.exists('sessions/session.json'), true);
});

test('取消清理：仅重试剩余文件', async t => {
  const f = await fixture(t);
  await f.write('debug/a.log');
  await f.write('debug/b.log');
  const plan = await f.plan(['data:cache']);
  const abort = new AbortController();
  const first = await f.ccw.apply(plan.id, abort.signal, event => {
    if (event.kind === 'effect' && event.effect.code === 'data-file-removed') abort.abort();
  });
  assert.equal(first.state, 'cancelled');
  assert.ok(first.remaining);
  await f.write('debug/a.log', 'regenerated');
  const resumed = await f.ccw.plan({ resume: first.remaining });
  const result = await f.ccw.apply(resumed.id);
  assert.equal(result.state, 'done');
  assert.equal(result.remaining, undefined);
  assert.equal(await fs.readFile(path.join(f.claudeRoot, 'debug/a.log'), 'utf8'), 'regenerated');
  assert.equal(await f.exists('debug/b.log'), false);
  assert.match(describeResult(result), /清理完成（有保留）/);
});

test('删除结果未知：只核对且不重复删除', async t => {
  const f = await fixture(t);
  await f.write('debug/a.log');
  await f.write('debug/b.log');
  f.state.failRemoveOn = 2;
  f.state.unreadableAfterFailure = true;
  const plan = await f.plan(['data:cache']);
  const first = await f.ccw.apply(plan.id);
  f.state.treeStampFails = false;
  const resumed = await f.ccw.plan({ resume: first.remaining });
  const result = await f.ccw.apply(resumed.id);
  assert.equal(result.state, 'partial');
  assert.equal(f.state.removeTreeCalls, 2);
  assert.equal(await f.exists('debug/a.log'), false);
  assert.equal(await f.exists('debug/b.log'), true);
  assert.ok(!result.items[0].effects.some(effect => effect.code === 'data-selected-cleared'));
  await f.ccw.abandon(result.remaining);
  assert.equal((await f.ccw.apply((await f.plan(['data:cache'])).id)).state, 'done');
  assert.equal(f.state.removeTreeCalls, 3);
});

test('删除抛错后证实原目标未变：新实例重新确认后可删除剩余文件', async t => {
  const f = await fixture(t);
  await f.write('debug/a.log');
  await f.write('debug/b.log');
  f.state.failRemoveOn = 2;
  const first = await f.ccw.apply((await f.plan(['data:cache'])).id);
  assert.ok(first.remaining);
  assert.equal(f.state.removeTreeCalls, 2);
  const restarted = (f.ccw = createCcw({
    machine: f.machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform: process.platform,
  }));
  const recovery = await restarted.recovery();
  assert.equal(f.state.removeTreeCalls, 2);
  const resumed = await restarted.plan({ resume: recovery.id });
  assert.equal((await restarted.apply(resumed.id)).state, 'done');
  assert.equal(f.state.removeTreeCalls, 3);
  assert.equal(await f.exists('debug/b.log'), false);
});

test('后一次删除结果不可读：新实例不能借用前一次未变证据再次删除', async t => {
  const f = await fixture(t);
  await f.write('debug/a.log');
  f.state.failRemoveOn = 1;
  const first = await f.ccw.apply((await f.plan(['data:cache'])).id);
  const retry = await f.ccw.plan({ resume: first.remaining });
  f.state.failRemoveOn = 2;
  f.state.unreadableAfterFailure = true;
  const second = await f.ccw.apply(retry.id);
  assert.ok(second.remaining);
  f.state.treeStampFails = false;
  const restarted = createCcw({
    machine: f.machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform: process.platform,
  });
  const recovery = await restarted.recovery();
  const remaining = await restarted.plan({ resume: recovery.id });
  assert.notEqual((await restarted.apply(remaining.id)).state, 'done');
  assert.equal(f.state.removeTreeCalls, 2);
  assert.equal(await f.exists('debug/a.log'), true);
});

test('清理数据：时钟回拨仍复核进程', async t => {
  const f = await fixture(t);
  await f.write('debug/a.log');
  await f.write('debug/b.log');
  const now = Date.now;
  let isClockAdjusted = false;
  let isFirst = true;
  Date.now = () => now() - (isClockAdjusted ? 10_000 : 0);
  t.after(() => {
    Date.now = now;
  });
  f.state.onRemoveTree = async () => {
    if (!isFirst) return;
    isFirst = false;
    await delay(1_100);
    f.state.running = true;
    isClockAdjusted = true;
  };
  const plan = await f.plan(['data:cache']);
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'partial');
  assert.ok(result.items[0].effects.some(effect => effect.code === 'claude-may-be-running'));
  assert.equal(await f.exists('debug/b.log'), true);
});

test('删除确认失败：重试仅复核', async t => {
  const f = await fixture(t);
  await f.write('debug/a.log');
  f.state.failRemoveRead = true;
  const plan = await f.plan(['data:cache']);
  const first = await f.ccw.apply(plan.id);
  assert.ok(first.remaining);
  f.state.failRemoveRead = false;
  f.state.treeStampFails = false;
  const resumed = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(resumed.id)).state, 'done');
  assert.equal(f.state.removeTreeCalls, 1);
});

test('重建操作实例：删除回执丢失后只核对冻结文件', async t => {
  const f = await fixture(t);
  await f.write('debug/a.log');
  f.state.failRemoveRead = true;
  const first = await f.ccw.apply((await f.plan(['data:cache'])).id);
  assert.ok(first.remaining);
  f.state.failRemoveRead = false;
  f.state.treeStampFails = false;
  await f.write('debug/new.log', 'user data after interruption');
  const restarted = (f.ccw = createCcw({
    machine: f.machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform: process.platform,
  }));
  const recovered = await restarted.plan({ resume: first.remaining });
  assert.equal((await restarted.apply(recovered.id)).state, 'done');
  assert.equal(f.state.removeTreeCalls, 1);
  assert.equal(await f.exists('debug/new.log'), true);
});

test('最终复核失败：跳过已完成清理', async t => {
  const f = await fixture(t);
  await f.write('debug/nested/a.log');
  f.state.onRemoveTree = async () => {
    f.state.entriesFails = true;
  };
  const plan = await f.plan(['data:cache']);
  const first = await f.ccw.apply(plan.id);
  assert.ok(first.remaining);
  assert.equal(first.state, 'partial');
  f.state.entriesFails = false;
  const resumed = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(resumed.id)).state, 'done');
  assert.equal(f.state.removeTreeCalls, 1);
});

test('清理后重启 Claude：阻止完成确认', async t => {
  const f = await fixture(t);
  await f.write('jobs/a.json');
  f.state.onRemoveTree = async () => {
    f.state.running = true;
  };
  const plan = await f.plan(['data:runtime']);
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  f.state.running = false;
  f.state.onRemoveTree = null;
  const resumed = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(resumed.id)).state, 'done');
});

test('删除 Claude 数据：保护 CCW 子目录', async t => {
  const f = await fixture(t);
  const claudeRoot = path.join(f.home, '.ccw', 'nested-claude');
  const binary = path.join(f.home, '.local/bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  const version = path.join(f.home, '.local/share/claude/versions/2.1.1');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, 'known claude');
  await fs.mkdir(path.dirname(version), { recursive: true });
  await fs.writeFile(version, 'known claude');
  await fs.mkdir(claudeRoot, { recursive: true });
  await fs.writeFile(path.join(claudeRoot, 'keep.txt'), 'protected storage');
  const machine = {
    ...createMachine({}, f.root),
    processes: async () => [],
    npm: async args => ({
      code: 0,
      failed: false,
      stdout: args[0] === 'root' ? path.join(f.root, 'npm/node_modules') : '{}',
    }),
    locate: async () => [],
  };
  const ccw = createCcw({
    machine,
    home: f.home,
    claudeRoot,
    cclineRoot: path.join(f.home, '.claude/ccline'),
    platform: process.platform,
  });
  const plan = await ccw.plan({ task: 'uninstall', selected: [{ id: 'claude' }], removeData: true });
  assert.equal(plan.items.find(item => item.id === 'data:claude').problem, 'invalid-data-root');
  assert.equal(await fs.readFile(path.join(claudeRoot, 'keep.txt'), 'utf8'), 'protected storage');
});

test('替换祖先链接：阻止清理目标', async t => {
  const f = await fixture(t);
  await f.write('debug/nested/a.log', 'same');
  const shared = path.join(f.root, 'shared');
  await fs.mkdir(shared);
  await fs.writeFile(path.join(shared, 'a.log'), 'same');
  const plan = await f.plan(['data:cache']);
  const nested = path.join(f.claudeRoot, 'debug/nested');
  await fs.unlink(path.join(nested, 'a.log'));
  await fs.rmdir(nested);
  await fs.symlink(shared, nested, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.ccw.apply(plan.id)).state, 'failed');
  assert.equal(await fs.readFile(path.join(shared, 'a.log'), 'utf8'), 'same');
});

test('检查历史目录：不虚构记忆项', async t => {
  const f = await fixture(t);
  await f.write('projects/p/session.jsonl');
  const view = await f.ccw.inspect('data');
  assert.deepEqual(view.items.find(item => item.id === 'data:memory').actions, []);
});

test('清理缓存：移除空子目录', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.claudeRoot, 'debug/empty'), { recursive: true });
  const plan = await f.plan(['data:cache']);
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.deepEqual(await fs.readdir(path.join(f.claudeRoot, 'debug')), []);
});

test('隔离目录故障：继续清理其他类别', async t => {
  const f = await fixture(t);
  await f.write('debug/a.log');
  await f.write('backups/a.json');
  f.state.blockedEntries = path.join(f.claudeRoot, 'debug');
  const view = await f.ccw.inspect('data');
  assert.equal(view.items.length, 5);
  assert.equal(view.items.find(item => item.id === 'data:cache').problem, 'cleanup-inspection-incomplete');
  assert.equal(view.items.find(item => item.id === 'data:backups').problem, undefined);
  const blocked = await f.plan(['data:cache']);
  assert.equal(blocked.items[0].problem, 'cleanup-inspection-incomplete');
  const plan = await f.plan(['data:backups']);
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.equal(await f.exists('debug/a.log'), true);
});

for (const running of [true, null])
  test(`检查进程 ${running}：阻止清理数据`, async t => {
    const f = await fixture(t);
    await f.write('jobs/task.json');
    f.state.running = running;
    const plan = await f.plan(['data:runtime']);
    const result = await f.ccw.apply(plan.id);
    assert.equal(result.state, 'failed');
    assert.equal(await f.exists('jobs/task.json'), true);
  });

test('提交清理选择：仅确认一次', async t => {
  const f = await fixture(t);
  for (const file of [
    'debug/a',
    'projects/p/session.jsonl',
    'projects/p/memory/MEMORY.md',
    'backups/settings.json',
    'jobs/task',
  ])
    await f.write(file);
  let homes = 0;
  let confirmations = 0;
  await runTerminal(f.ccw, {
    wait: (_title, work) => work(new AbortController().signal),
    show() {},
    async select(page, change) {
      assert.equal(page.rows.length, 5);
      assert.ok(page.rows.every(row => !row.checked));
      const selected = change({ kind: 'all' });
      assert.ok(selected.rows.every(row => row.checked));
      return { kind: 'submit', index: 5 };
    },
    async choose(title, choices) {
      if (title === HOME_TITLE) return homes++ ? 4 : 3;
      if (choices.includes('确认清理')) {
        confirmations++;
        assert.match(title, /后台任务与运行状态/);
        return 0;
      }
      return 1;
    },
  });
  assert.equal(confirmations, 1);
  assert.ok((await f.ccw.inspect('data')).items.every(item => !item.actions.includes('clean')));
});

test('分类清理数据：保留未选与新增文件', async t => {
  const f = await fixture(t);
  await f.write('projects/abc/session.jsonl', 'history');
  await f.write('projects/abc/memory/MEMORY.md', 'remember');
  await f.write('.credentials.json', 'secret');
  const plan = await f.plan(['data:history']);
  await f.write('projects/abc/new.jsonl', 'new');
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'done');
  assert.equal(await f.exists('projects/abc/session.jsonl'), false);
  assert.equal(await fs.readFile(path.join(f.claudeRoot, 'projects/abc/new.jsonl'), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(f.claudeRoot, 'projects/abc/memory/MEMORY.md'), 'utf8'), 'remember');
  assert.equal(await fs.readFile(path.join(f.claudeRoot, '.credentials.json'), 'utf8'), 'secret');
});

test('变更清理目标：阻止旧计划删除', async t => {
  const f = await fixture(t);
  const file = path.join(f.claudeRoot, 'debug/a.log');
  await f.write('debug/a.log', 'old');
  let plan = await f.plan(['data:cache']);
  f.state.running = true;
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'failed');
  f.state.running = false;
  await f.ccw.abandon(first.remaining);
  plan = await f.plan(['data:cache']);
  await fs.writeFile(file, 'new');
  assert.equal((await f.ccw.apply(plan.id)).state, 'failed');
  assert.equal(await fs.readFile(file, 'utf8'), 'new');
});

test('取消清理预览：保留全部文件', async t => {
  const f = await fixture(t);
  const file = path.join(f.claudeRoot, 'debug/a.log');
  await f.write('debug/a.log', 'keep');
  const choices = [3, 1, 4];
  let selected = 0;
  await runTerminal(f.ccw, {
    wait: (_title, work) => work(new AbortController().signal),
    handoff: work => work(),
    show() {},
    async choose(title, rows, index) {
      if (typeof title === 'string' && title.startsWith('变更预览')) assert.equal(index, 1);
      return choices.shift();
    },
    async select(page, change) {
      if (selected++ === 0) {
        assert.equal(
          page.rows.some(row => row.checked),
          false,
        );
        const index = page.rows.findIndex(row => row.label.startsWith('缓存'));
        change({ kind: 'toggle', index });
        return { kind: 'submit', index: page.rows.length };
      }
      return { kind: 'cancel', index: 0 };
    },
  });
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
  assert.equal(choices.length, 0);
});

test('清理链接目录：保留共享内容', async t => {
  const f = await fixture(t);
  const shared = path.join(f.root, 'shared-cache');
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, 'log.jsonl'), 'shared data');
  await fs.mkdir(path.join(f.claudeRoot, 'debug'), { recursive: true });
  await fs.symlink(shared, path.join(f.claudeRoot, 'debug/shared'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.write('debug/local.log', 'local data');
  const plan = await f.plan(['data:cache']);
  assert.ok(
    plan.items.every(item => item.problem === null),
    JSON.stringify(plan),
  );
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.equal(await fs.readFile(path.join(shared, 'log.jsonl'), 'utf8'), 'shared data');
});

test('取消数据检查：停止目录遍历', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const entered = Promise.withResolvers();
  const listing = Promise.withResolvers();
  const reads = [];
  // 目标 fixture 无 onEntries 钩子：局部包装 entries，等价 full-flow 侧 onEntries 完全替换语义
  const machine = {
    ...f.machine,
    async entries(directory) {
      reads.push(directory);
      entered.resolve();
      return listing.promise;
    },
  };
  const ccw = createCcw({
    machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform: process.platform,
  });
  const inspecting = ccw.inspect('data', controller.signal);
  await entered.promise;
  controller.abort();
  listing.resolve([{ name: 'cache', kind: 'directory', sizeBytes: 0n }]);
  await assert.rejects(inspecting, /cancelled/);
  assert.deepEqual(reads, [f.claudeRoot]);
});
