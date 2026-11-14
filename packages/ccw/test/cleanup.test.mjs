import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createTestEnvironment } from './test-environment.mjs';
import { describePlan } from '../dist/render.js';

test('清理数据独立预览和执行，只删除所选类别并保留配置与记忆', async testContext => {
  const workspace = await createTestEnvironment(testContext);
  const ccw = workspace.ccw(workspace.machine({ processes: async () => [] }));
  for (const [file, text] of [
    ['cache/a', 'cached'],
    ['projects/demo/session.jsonl', 'history'],
    ['projects/demo/memory/MEMORY.md', 'memory'],
    ['settings.json', '{"env":{"ANTHROPIC_API_KEY":"keep"}}'],
    ['skills/custom/SKILL.md', 'custom'],
  ])
    await workspace.write(path.join(workspace.claudeRoot, file), text);
  const view = await ccw.inspect(undefined, 'data');
  assert.equal(view.items.find(i => i.id === 'data:cache').canClean, true);
  const plan = await ccw.plan({ task: 'clean', selected: [{ id: 'data:cache' }, { id: 'data:history' }] });
  assert.ok(
    plan.items.every(i => i.problem === null),
    JSON.stringify(plan),
  );
  assert.equal(await fs.readFile(path.join(workspace.claudeRoot, 'cache/a'), 'utf8'), 'cached');
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  assert.equal(await workspace.machine().treeStamp(path.join(workspace.claudeRoot, 'cache/a')), null);
  assert.equal(await fs.readFile(path.join(workspace.claudeRoot, 'projects/demo/memory/MEMORY.md'), 'utf8'), 'memory');
  assert.match(await fs.readFile(workspace.settingsFile, 'utf8'), /keep/);
  assert.equal(await fs.readFile(path.join(workspace.claudeRoot, 'skills/custom/SKILL.md'), 'utf8'), 'custom');
});

test('清理数据保护预览后修改的文件及共享链接目标', async testContext => {
  const workspace = await createTestEnvironment(testContext);
  const ccw = workspace.ccw(workspace.machine({ processes: async () => [] }));
  const file = path.join(workspace.claudeRoot, 'cache/a');
  await workspace.write(file, 'before');
  const shared = path.join(workspace.home, 'shared');
  await workspace.write(path.join(shared, 'keep'), 'shared');
  await fs.symlink(
    shared,
    path.join(workspace.claudeRoot, 'cache/shared'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const plan = await ccw.plan({ task: 'clean', selected: [{ id: 'data:cache' }] });
  assert.equal(plan.items[0].problem, null);
  await workspace.write(file, 'modified');
  assert.equal((await ccw.apply(plan.id)).state, 'failed');
  assert.equal(await fs.readFile(file, 'utf8'), 'modified');
  assert.equal(await fs.readFile(path.join(shared, 'keep'), 'utf8'), 'shared');
});

test('Claude 运行时拒绝清理数据，不影响普通安装入口', async testContext => {
  const workspace = await createTestEnvironment(testContext);
  const ccw = workspace.ccw(workspace.machine({ processes: async () => [{ name: 'claude.exe', command: 'claude' }] }));
  await workspace.write(path.join(workspace.claudeRoot, 'cache/a'), 'keep');
  const plan = await ccw.plan({ task: 'clean', selected: [{ id: 'data:cache' }] });
  assert.equal(plan.items[0].problem, 'claude-running');
  assert.equal((await ccw.apply(plan.id)).state, 'failed');
  assert.equal(await fs.readFile(path.join(workspace.claudeRoot, 'cache/a'), 'utf8'), 'keep');
});

for (const confirm of [false, true])
  test(`清理菜单明确预览并确认后才执行：${confirm}`, async testContext => {
    const { runTerminal } = await import('../dist/terminal.js');
    const { HOME_TITLE } = await import('../dist/render.js');
    const workspace = await createTestEnvironment(testContext);
    const ccw = workspace.ccw(workspace.machine({ processes: async () => [] }));
    const file = path.join(workspace.claudeRoot, 'cache/a');
    await workspace.write(file, 'cached');
    let homes = 0,
      selections = 0;
    await runTerminal(ccw, {
      wait: (_title, work) => work(new AbortController().signal),
      show() {},
      choose: async (title, choices) => {
        if (title === HOME_TITLE) return homes++ ? 4 : 3;
        if (title.startsWith('变更预览')) {
          assert.match(title, /永久删除/);
          assert.match(title, /保留程序、配置与凭据/);
          assert.equal(choices[0], '确认清理');
          return confirm ? 0 : 1;
        }
        return 0;
      },
      select: async (page, change) => {
        if (selections++) return 'cancel';
        assert.match(page.title, /清理数据/);
        change({ kind: 'toggle', index: 0 });
        return 'submit';
      },
    });
    assert.equal((await workspace.machine().treeStamp(file)) === null, confirm);
  });

test('取消清理只停止后续删除，保留已完成结果', async testContext => {
  const workspace = await createTestEnvironment(testContext);
  const abort = new AbortController();
  const base = workspace.machine({ processes: async () => [] });
  const ccw = workspace.ccw({
    ...base,
    async removeTree(...args) {
      await base.removeTree(...args);
      abort.abort();
    },
  });
  const first = path.join(workspace.claudeRoot, 'cache/a'),
    second = path.join(workspace.claudeRoot, 'cache/b');
  await workspace.write(first, 'a');
  await workspace.write(second, 'b');
  const plan = await ccw.plan({ task: 'clean', selected: [{ id: 'data:cache' }] });
  const result = await ccw.apply(plan.id, abort.signal);
  assert.equal(result.state, 'cancelled');
  assert.equal(await base.treeStamp(first), null);
  assert.equal(await fs.readFile(second, 'utf8'), 'b');
});

test('仅有项目记忆时历史不可清理，清理记忆不会删除历史目录', async testContext => {
  const workspace = await createTestEnvironment(testContext);
  const ccw = workspace.ccw(workspace.machine({ processes: async () => [] }));
  const memory = path.join(workspace.claudeRoot, 'projects/demo/memory');
  await fs.mkdir(memory, { recursive: true });
  let view = await ccw.inspect(undefined, 'data');
  assert.equal(view.items.find(item => item.id === 'data:history').canClean, false);
  assert.equal(view.items.find(item => item.id === 'data:memory').canClean, true);
  const history = path.join(workspace.claudeRoot, 'projects/demo/session.jsonl');
  await workspace.write(history, 'history');
  const plan = await ccw.plan({ task: 'clean', selected: [{ id: 'data:memory' }] });
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  assert.equal(await fs.readFile(history, 'utf8'), 'history');
  assert.equal(await workspace.machine().treeStamp(memory), null);
  view = await ccw.inspect(undefined, 'data');
  assert.equal(view.items.find(item => item.id === 'data:memory').canClean, false);
});

test('会话清理保留空项目记忆目录，预览明确说明跳过共享链接', async testContext => {
  const workspace = await createTestEnvironment(testContext);
  const ccw = workspace.ccw(workspace.machine({ processes: async () => [] }));
  const memory = path.join(workspace.claudeRoot, 'projects/demo/memory');
  await fs.mkdir(memory, { recursive: true });
  await workspace.write(path.join(workspace.claudeRoot, 'projects/demo/session.jsonl'), 'history');
  const shared = path.join(workspace.home, 'shared');
  await workspace.write(path.join(shared, 'keep'), 'shared');
  await fs.symlink(
    shared,
    path.join(workspace.claudeRoot, 'projects/demo/shared'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const plan = await ccw.plan({ task: 'clean', selected: [{ id: 'data:history' }] });
  assert.match(describePlan(plan), /保留共享链接及其目标/);
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  assert.ok((await fs.stat(memory)).isDirectory());
  assert.equal(await fs.readFile(path.join(shared, 'keep'), 'utf8'), 'shared');
  const view = await ccw.inspect(undefined, 'data');
  assert.equal(view.items.find(item => item.id === 'data:history').canClean, false);
});

for (const hasFile of [false, true])
  test(`清理失败保留权限原因，空目录也必须核验并允许重试：${hasFile}`, async testContext => {
    const workspace = await createTestEnvironment(testContext);
    const directory = path.join(workspace.claudeRoot, 'cache');
    await fs.mkdir(directory, { recursive: true });
    if (hasFile) await workspace.write(path.join(directory, 'a'), 'cache');
    const base = workspace.machine({ processes: async () => [] });
    let blocked = true;
    const ccw = workspace.ccw({
      ...base,
      removeTree: async (...args) => {
        if (blocked) throw Object.assign(new Error('fixture'), { code: 'EACCES' });
        return base.removeTree(...args);
      },
    });
    const request = { task: 'clean', selected: [{ id: 'data:cache' }] };
    const plan = await ccw.plan(request);
    assert.match(describePlan(plan), /1 个目录/);
    const failed = await ccw.apply(plan.id);
    assert.equal(failed.state, 'failed');
    assert.ok(failed.items[0].effects.some(effect => effect.state === 'failed' && effect.code === 'EACCES'));
    assert.ok(!failed.items[0].effects.some(effect => effect.code === 'cleanup-incomplete'));
    assert.ok((await fs.stat(directory)).isDirectory());
    blocked = false;
    const retry = await ccw.plan(request);
    assert.equal((await ccw.apply(retry.id)).state, 'done');
    assert.equal(await base.treeStamp(directory), null);
  });
