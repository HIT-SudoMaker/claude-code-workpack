import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { runTerminal } from './terminal-test.mjs';
import { contentRows } from '../dist/render.js';
import { createEnv, exists, ok } from './env.mjs';

async function fixture(t) {
  const f = await createEnv(t, { layout: 'home' });
  const state = {
    // 写入后回读失败：以 calls 中该文件的 editJson 记录为触发条件，一次性生效
    failReadAfterEdit: null,
    readFailed: false,
    // 删除原语：按基名阻断删除；前置钩子负责记录启动并支持取消
    blockedRemove: null,
    onRemoveTree: null,
    // 并发观察包装：覆盖 editJson 与 removeTree
    observe: null,
  };
  const wrapped = f.machine({
    npm: async () => ok('{}'),
    read: async (file, base) => {
      if (
        file === state.failReadAfterEdit &&
        !state.readFailed &&
        f.calls.some(call => call.kind === 'editJson' && call.target === file)
      ) {
        state.readFailed = true;
        throw new Error('read-failed');
      }
      return base.read(file);
    },
  });
  const machine = {
    ...wrapped,
    async editJson(file, edit) {
      const work = () => wrapped.editJson(file, edit);
      return state.observe ? state.observe(file, work) : work();
    },
    async removeTree(...args) {
      if (state.onRemoveTree) await state.onRemoveTree(args[0]);
      if (state.blockedRemove !== null && path.basename(args[0]) === state.blockedRemove)
        throw Object.assign(new Error('blocked'), { code: 'EACCES' });
      const work = () => wrapped.removeTree(...args);
      return state.observe ? state.observe(args[0], work) : work();
    },
  };
  const ccw = f.ccw(machine);
  const removable = async () => (await ccw.inspect()).items.filter(item => item.actions.includes('detach'));
  return { ...f, state, machine, ccw, removable };
}

test('MCP 删除确认失败：重试仅复核', async t => {
  const f = await fixture(t);
  await f.json(f.stateFile, { mcpServers: { external: { command: 'server' } }, keep: true });
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'mcp:external' }] });
  f.state.failReadAfterEdit = f.stateFile;
  const first = await f.ccw.apply(plan.id);
  assert.ok(first.remaining);
  const resumed = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(resumed.id)).state, 'done');
  assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.stateFile).length, 1);
  assert.deepEqual(await f.read(f.stateFile), { mcpServers: {}, keep: true });
});

test('取消解除 CCometixLine：不重复删除', async t => {
  const f = await fixture(t);
  await f.json(f.settingsFile, { statusLine: { type: 'command', command: 'ccline' }, language: '中文' });
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'ccline', removal: 'detach' }] });
  const abort = new AbortController();
  const result = await f.ccw.apply(plan.id, abort.signal, event => {
    if (event.kind === 'effect' && event.effect.code === 'disconnected') abort.abort();
  });
  assert.equal(result.items[0].isPending, false);
  assert.equal(result.remaining, undefined);
  assert.deepEqual(await f.read(f.settingsFile), { language: '中文' });
});

test('重建 MCP 注册：阻止重复删除', async t => {
  const f = await fixture(t);
  const original = { mcpServers: { external: { command: 'server' } } };
  await f.json(f.stateFile, original);
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'mcp:external' }] });
  f.state.failReadAfterEdit = f.stateFile;
  const first = await f.ccw.apply(plan.id);
  await f.json(f.stateFile, original);
  const resumed = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(resumed.id)).state, 'failed');
  assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.stateFile).length, 1);
  assert.deepEqual(await f.read(f.stateFile), original);
});

test('取消解除 AMIRC：保留剩余许可', async t => {
  const f = await fixture(t);
  await f.json(f.stateFile, { mcpServers: { amirc: { command: 'server' } } });
  await f.json(f.settingsFile, { permissions: { allow: ['mcp__amirc__get_papers', 'other'] } });
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'mcp:amirc' }] });
  const abort = new AbortController();
  const first = await f.ccw.apply(plan.id, abort.signal, event => {
    if (event.kind === 'effect' && event.effect.code === 'registration-removed') abort.abort();
  });
  assert.equal(first.state, 'cancelled');
  assert.deepEqual((await f.read(f.settingsFile)).permissions.allow, ['mcp__amirc__get_papers', 'other']);
  const resumed = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(resumed.id)).state, 'done');
  assert.deepEqual((await f.read(f.settingsFile)).permissions.allow, ['other']);
});

for (const recreated of [false, true])
  test(`复核 AMIRC 许可：${recreated ? '保留重建许可' : '仅读取结果'}`, async t => {
    const f = await fixture(t);
    const original = { permissions: { allow: ['mcp__amirc__get_papers', 'other'] } };
    await f.json(f.settingsFile, original);
    const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'mcp:amirc' }] });
    f.state.failReadAfterEdit = f.settingsFile;
    const first = await f.ccw.apply(plan.id);
    assert.ok(first.remaining);
    if (recreated) await f.json(f.settingsFile, original);
    const resumed = await f.ccw.plan({ resume: first.remaining });
    const result = await f.ccw.apply(resumed.id);
    assert.equal(result.state, recreated ? 'failed' : 'done');
    assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length, 1);
    assert.deepEqual(
      (await f.read(f.settingsFile)).permissions.allow,
      recreated ? original.permissions.allow : ['other'],
    );
  });

test('准备卸载失败：跳过整批操作', async t => {
  const f = await fixture(t);
  const original = { mcpServers: { external: { command: 'server' } } };
  await f.json(f.stateFile, original);
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'mcp:external' }, { id: 'skill:missing' }] });
  const result = await f.ccw.apply(plan.id);
  assert.deepEqual(result.items.find(item => item.id === 'mcp:external').effects, [
    { state: 'skipped', code: 'changes-not-started' },
  ]);
  assert.deepEqual(await f.read(f.stateFile), original);
});

test('隔离损坏技能：继续检查其他入口', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.claudeRoot, 'skills/good/SKILL.md'), '# Good');
  await f.write(path.join(f.claudeRoot, 'skills/bad/SKILL.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await f.write(path.join(f.claudeRoot, 'skills/empty/SKILL.md'), '  ');
  await f.write(path.join(f.claudeRoot, 'commands/good.md'), '# Command');
  const view = await f.ccw.inspect();
  for (const id of ['skill:good', 'skill:bad', 'skill:empty', 'command:good.md'])
    assert.ok(view.items.find(item => item.id === id)?.actions.includes('detach'), id);
  assert.equal(view.items.find(item => item.id === 'skill:bad').problem, 'file-too-large');
  assert.equal(view.items.find(item => item.id === 'skill:empty').problem, 'skill-entry-invalid');
});

test('解除无效 MCP：不标记已安装', async t => {
  const f = await fixture(t);
  await f.json(f.stateFile, { mcpServers: { context7: null } });
  const item = (await f.ccw.inspect()).items.find(item => item.id === 'mcp:context7');
  assert.equal(item.problem, 'invalid-mcp-registration');
  assert.doesNotMatch(contentRows([item])[0].detail, /已安装/);
  assert.ok(item.actions.includes('detach'));
});

test('安装无效注册入口：覆盖重建注册', async t => {
  const f = await fixture(t);
  await f.json(f.stateFile, { mcpServers: { context7: null } });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'mcp:context7' }] });
  assert.equal(plan.items[0].problem, null);
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.deepEqual((await f.read(f.stateFile)).mcpServers.context7, {
    type: 'http',
    url: 'https://mcp.context7.com/mcp',
  });
});

test('卸载空环境：拒绝虚报成功', async t => {
  const f = await fixture(t);
  assert.deepEqual(
    (await f.removable()).map(item => item.id),
    [],
  );
  let homes = 0;
  await runTerminal(f.ccw, {
    wait: (_title, work) => work(new AbortController().signal),
    choose: async () => (homes++ ? 4 : 2),
    select: async page => {
      assert.deepEqual(page.rows, []);
      assert.match(page.title, /无可卸载项/);
      return { kind: 'cancel', index: 0 };
    },
  });
  const plan = await f.ccw.plan({
    task: 'detach',
    selected: ['settings', 'ccline', 'mcp:missing', 'skill:missing', 'plugin:missing@market'].map(id => ({
      id,
    })),
  });
  assert.ok(plan.items.every(item => item.problem === 'no-connection'));
  assert.equal((await f.ccw.apply(plan.id)).state, 'failed');
  assert.equal(await exists(f.settingsFile), false);
});

test('解除用户入口：保留程序与共享源', async t => {
  const f = await fixture(t);
  const shared = path.join(f.root, 'shared');
  const link = path.join(f.claudeRoot, 'skills/shared');
  await f.write(path.join(shared, 'SKILL.md'), 'shared resource');
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(shared, link, process.platform === 'win32' ? 'junction' : 'dir');
  await f.write(path.join(f.claudeRoot, 'skills/local/SKILL.md'), 'local resource');
  const binary = path.join(f.claudeRoot, 'ccline', process.platform === 'win32' ? 'ccline.exe' : 'ccline');
  await f.write(binary, 'keep binary');
  await f.json(f.settingsFile, {
    env: { ANTHROPIC_BASE_URL: 'https://example.test', KEEP: 'yes' },
    language: '中文',
    enabledPlugins: { 'active@market': true, 'disabled@market': false },
    statusLine: { type: 'command', command: 'ccline' },
  });
  const project = { mcpServers: { external: { command: 'project program' } } };
  await f.json(f.stateFile, { mcpServers: { external: { command: 'shared program' } }, projects: { keep: project } });
  const items = await f.removable();
  assert.deepEqual(
    items.map(item => item.id).sort(),
    ['settings', 'ccline', 'plugin:active@market', 'mcp:external', 'skill:shared', 'skill:local'].sort(),
  );
  const plan = await f.ccw.plan({ task: 'detach', selected: items.map(item => ({ id: item.id })) });
  assert.ok(plan.items.every(item => item.problem === null));
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(shared, 'SKILL.md'), 'utf8'), 'shared resource');
  assert.equal(await fs.readFile(binary, 'utf8'), 'keep binary');
  const preserved = result.items
    .find(item => item.id === 'skill:local')
    .effects.find(effect => effect.code === 'entry-disabled').detail;
  assert.equal(await fs.readFile(path.join(preserved, 'SKILL.md'), 'utf8'), 'local resource');
  assert.deepEqual(await f.read(f.settingsFile), {
    env: { KEEP: 'yes' },
    language: '中文',
    enabledPlugins: { 'active@market': false, 'disabled@market': false },
  });
  assert.deepEqual(await f.read(f.stateFile), { mcpServers: {}, projects: { keep: project } });
  assert.deepEqual(
    (await f.removable()).map(item => item.id),
    [],
  );
});
test('拒绝未知任务：保留用户入口', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.claudeRoot, 'skills/local/SKILL.md'), 'keep');
  await assert.rejects(f.ccw.plan({ task: 'delete', selected: [{ id: 'skill:local' }] }), /action-unavailable/);
  assert.equal(await fs.readFile(path.join(f.claudeRoot, 'skills/local/SKILL.md'), 'utf8'), 'keep');
});

test('并发解除入口：串行修改同一文件', async t => {
  const f = await fixture(t);
  const enabledPlugins = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`plugin${i}@market`, true]));
  await f.json(f.settingsFile, {
    enabledPlugins,
    keep: true,
    permissions: { allow: ['mcp__amirc__get_papers', 'Read'] },
  });
  await f.json(f.stateFile, {
    mcpServers: { amirc: { command: 'keep program' }, external: { command: 'another program' } },
  });
  for (let i = 0; i < 6; i++) await f.write(path.join(f.claudeRoot, `skills/skill${i}/SKILL.md`), `resource ${i}`);
  let inFlight = 0;
  let peak = 0;
  const writing = new Set();
  f.state.observe = async (file, work) => {
    assert.equal(writing.has(file), false, '同一文件不能并发写入');
    writing.add(file);
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      return await work();
    } finally {
      inFlight--;
      writing.delete(file);
    }
  };
  const selections = (await f.removable()).map(item => ({ id: item.id }));
  const plan = await f.ccw.plan({ task: 'detach', selected: selections });
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.ok(peak > 1 && peak <= 4, `并发应在 2 至 4 项之间，实际 ${peak}`);
  assert.deepEqual(
    result.items.map(item => item.id),
    plan.items.map(item => item.id),
  );
  assert.deepEqual(await f.read(f.settingsFile), {
    enabledPlugins: Object.fromEntries(Object.keys(enabledPlugins).map(key => [key, false])),
    keep: true,
    permissions: { allow: ['Read'] },
  });
  assert.deepEqual(await f.read(f.stateFile), { mcpServers: {} });
});

test('并发解除失败：仅重试失败项', async t => {
  const f = await fixture(t);
  for (const name of ['good', 'blocked']) await f.write(path.join(f.claudeRoot, `skills/${name}/SKILL.md`), name);
  f.state.blockedRemove = 'blocked';
  const plan = await f.ccw.plan({ task: 'detach', selected: (await f.removable()).map(item => ({ id: item.id })) });
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'partial');
  assert.equal(result.items.find(item => item.id === 'skill:good').state, 'done');
  assert.equal(result.items.find(item => item.id === 'skill:blocked').effects.at(-1).code, 'EACCES');
  assert.deepEqual(
    (await f.removable()).map(item => item.id),
    ['skill:blocked'],
  );
  f.state.blockedRemove = null;
  const retry = await f.ccw.plan({ resume: result.remaining });
  assert.equal((await f.ccw.apply(retry.id)).state, 'done');
  assert.deepEqual(await f.removable(), []);
});

test('取消并发解除：停止新增操作', async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  for (let i = 0; i < 8; i++)
    await f.write(path.join(f.claudeRoot, `skills/skill${i}/SKILL.md`), 'keep until processed');
  const started = [];
  f.state.onRemoveTree = async file => {
    started.push(file);
    await new Promise(resolve => setTimeout(resolve, 10));
    abort.abort();
  };
  const plan = await f.ccw.plan({ task: 'detach', selected: (await f.removable()).map(item => ({ id: item.id })) });
  const result = await f.ccw.apply(plan.id, abort.signal);
  assert.equal(result.state, 'cancelled');
  assert.ok(started.length > 0 && started.length <= 4);
  assert.equal(result.items.filter(item => item.state === 'cancelled').length, 8 - started.length);
  assert.equal((await f.removable()).length, 8 - started.length);
});

test('解除残留 AMIRC：移除孤立许可', async t => {
  const f = await fixture(t);
  await f.json(f.settingsFile, { permissions: { allow: ['mcp__amirc__get_papers', 'mcp__other__tool'] } });
  assert.deepEqual(
    (await f.removable()).map(item => item.id),
    ['mcp:amirc'],
  );
  const plan = await f.ccw.plan({ task: 'detach', selected: [{ id: 'mcp:amirc' }] });
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.deepEqual(await f.read(f.settingsFile), { permissions: { allow: ['mcp__other__tool'] } });
  assert.deepEqual(
    (await f.removable()).map(item => item.id),
    [],
  );
});

test('解除残留声明：无需程序存在', async t => {
  const f = await fixture(t);
  await f.json(f.settingsFile, {
    enabledPlugins: { 'missing@market': true, 'cometix@ccline': true },
    statusLine: { type: 'command', command: 'ccline' },
  });
  let homes = 0;
  await runTerminal(f.ccw, {
    wait: (_title, work) => work(new AbortController().signal),
    choose: async () => (homes++ ? 4 : 2),
    select: async page => {
      assert.deepEqual(
        page.rows.map(({ label, detail }) => [label, detail]),
        [
          ['missing@market', '残留声明'],
          ['cometix@ccline', '残留声明'],
          ['CCometixLine', '残留配置'],
        ],
      );
      assert.ok(page.rows.every(row => row.enter === 'toggle'));
      return { kind: 'cancel', index: 0 };
    },
  });
  const plan = await f.ccw.plan({ task: 'detach', selected: (await f.removable()).map(item => ({ id: item.id })) });
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.deepEqual(
    (await f.removable()).map(item => item.id),
    [],
  );
});

test('隔离配置故障：保留独立入口', async t => {
  const f = await fixture(t);
  await f.write(f.settingsFile, '{bad');
  await f.write(path.join(f.claudeRoot, 'skills/local/SKILL.md'), 'local');
  await f.json(f.stateFile, {
    mcpServers: { broken: { command: 'missing' }, keep: { url: 'https://keep.test' } },
    projects: { keep: true },
  });
  const view = await f.ccw.inspect();
  assert.ok(view.items.some(item => item.id === 'skill:local'));
  assert.ok(view.problems.length);
  f.calls.length = 0;
  const plan = await f.ccw.plan({ task: 'detach', selected: [{ id: 'mcp:broken' }] });
  assert.ok(
    plan.items.every(item => item.problem === null),
    JSON.stringify(plan),
  );
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'done');
  assert.deepEqual(await f.read(f.stateFile), {
    mcpServers: { keep: { url: 'https://keep.test' } },
    projects: { keep: true },
  });
  assert.equal(f.calls.filter(call => call.kind !== 'editJson').length, 0);
});

test('变更 MCP 目标：继续独立操作', async t => {
  const f = await fixture(t);
  await f.json(f.stateFile, { mcpServers: { external: { command: 'old' }, other: { command: 'keep program' } } });
  const plan = await f.ccw.plan({ task: 'detach', selected: [{ id: 'mcp:external' }, { id: 'mcp:other' }] });
  await f.json(f.stateFile, { mcpServers: { external: { command: 'new' }, other: { command: 'keep program' } } });
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'partial');
  const state = await f.read(f.stateFile);
  assert.equal(state.mcpServers.external.command, 'new');
  assert.equal(state.mcpServers.other, undefined);
});

test('安装密钥入口：计划排除明文密钥', async t => {
  const f = await fixture(t);
  await f.json(f.stateFile, { mcpServers: {} });
  const install = await f.ccw.plan({
    task: 'install',
    selected: [{ id: 'mcp:context7', fields: { secret: 'secret-value' } }],
  });
  assert.equal(JSON.stringify(install).includes('secret-value'), false);
  assert.equal((await f.ccw.apply(install.id)).state, 'done');
  assert.equal((await f.read(f.stateFile)).mcpServers.context7.headers.Authorization, 'Bearer secret-value');
});

test('解除旧 Commands：定位嵌套入口', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.claudeRoot, 'commands/review/deep.md'), 'nested command');
  await f.write(path.join(f.claudeRoot, 'commands/keep.md'), 'keep');
  await fs.mkdir(path.join(f.claudeRoot, 'skills/empty'), { recursive: true });
  const view = await f.ccw.inspect();
  assert.ok(view.items.some(item => item.id === 'command:review/deep.md'));
  assert.equal(
    view.items.some(item => item.id === 'skill:empty'),
    false,
  );
  const plan = await f.ccw.plan({ task: 'detach', selected: [{ id: 'command:review/deep.md' }] });
  assert.ok(
    plan.items.every(item => item.problem === null),
    JSON.stringify(plan),
  );
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.equal(await fs.readFile(path.join(f.claudeRoot, 'commands/keep.md'), 'utf8'), 'keep');
  assert.equal(
    (await f.ccw.plan({ task: 'detach', selected: [{ id: 'command:../settings.json' }] })).items[0].problem,
    'invalid-target',
  );
});
