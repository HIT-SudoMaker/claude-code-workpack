import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createEnv, fail, npmOf, npmWorld, ok, versionProbe } from './env.mjs';

async function fixture(t, { replaceDuringDefaults = false, failProgramReadDuringDefaults = false } = {}) {
  const f = await createEnv(t, { seed: { settings: { language: 'English' } } });
  const npmRoot = path.join(f.root, 'npm/lib/node_modules');
  const binary = path.join(npmRoot, '@anthropic-ai/claude-code/cli.js');
  const pluginCommands = [];
  let isProgramReadUnavailable = false;
  const world = npmWorld({
    package: '@anthropic-ai/claude-code',
    npmRoot,
    installVersion: '2.1.2',
    view: async () => ok(JSON.stringify('2.1.2')),
    bin: { claude: 'cli.js' },
    binaryContent: 'installed by this operation',
  });
  const wrapped = f.machine({
    npm: world.npm,
    execute: versionProbe({
      binary,
      node: true,
      output: '2.1.2 Claude Code',
      before: async (file, args) => {
        const command = file === process.execPath ? args.slice(1) : args;
        if (command[0] !== 'plugin') return undefined;
        pluginCommands.push(command);
        return fail();
      },
    }),
    processes: async () => [],
  });
  const machine = {
    ...wrapped,
    async treeStamp(file, ...args) {
      if (file === binary && isProgramReadUnavailable) throw new Error('program-read-unavailable');
      return wrapped.treeStamp(file, ...args);
    },
    async editJson(file, edit) {
      await wrapped.editJson(file, edit);
      if (file !== f.settingsFile) return;
      if (replaceDuringDefaults) await f.write(binary, 'external replacement');
      if (failProgramReadDuringDefaults) isProgramReadUnavailable = true;
    },
  };
  return {
    ...f,
    binary,
    pluginCommands,
    suspendProgramRead: () => (isProgramReadUnavailable = true),
    recoverProgramRead: () => (isProgramReadUnavailable = false),
    ccw: f.ccw(machine, { platform: 'linux' }),
  };
}

test('Claude 新安装：默认设置完成后仍满足程序验收才能完成', async t => {
  const f = await fixture(t);
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(plan.items[0].problem, null);
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'done');
  assert.equal(npmOf(f, 'install').length, 1);
  assert.equal(await fs.readFile(f.binary, 'utf8'), 'installed by this operation');
  assert.equal((await f.read(f.settingsFile)).language, 'English');
  assert.ok(result.items[0].effects.some(effect => effect.code === 'settings-saved'));
});

test('Claude 新安装：默认设置写入期间程序被替换，拒绝完成与旧计划续办', async t => {
  const f = await fixture(t, { replaceDuringDefaults: true });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'partial');
  assert.equal(result.remaining, undefined);
  assert.ok(result.items[0].effects.some(effect => effect.code === 'program-changed'));
  assert.equal(npmOf(f, 'install').length, 1);
  assert.equal(await fs.readFile(f.binary, 'utf8'), 'external replacement');
});

test('Claude 最终验收失效：即使早先报告 ready 也不执行依赖的插件命令', async t => {
  const f = await fixture(t, { replaceDuringDefaults: true });
  const plan = await f.ccw.plan({
    task: 'install',
    selected: [{ id: 'claude' }, { id: 'plugin:github@claude-plugins-official' }],
  });
  assert.ok(
    plan.items.every(item => item.problem === null),
    JSON.stringify(plan),
  );
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'partial');
  assert.equal(result.remaining, undefined);
  assert.ok(result.items[0].effects.some(effect => effect.code === 'program-ready'));
  assert.ok(result.items[0].effects.some(effect => effect.code === 'program-changed'));
  assert.ok(result.items[1].effects.some(effect => effect.code === 'dependency-not-ready'));
  assert.equal(f.pluginCommands.length, 0);
});

test('Claude 最终程序复核暂时不可读：暂停依赖，恢复后只验收不重装或重写设置', async t => {
  const f = await fixture(t, { failProgramReadDuringDefaults: true });
  const plan = await f.ccw.plan({
    task: 'install',
    selected: [{ id: 'claude' }, { id: 'plugin:github@claude-plugins-official' }],
  });
  assert.ok(
    plan.items.every(item => item.problem === null),
    JSON.stringify(plan),
  );
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  assert.ok(first.items[0].effects.some(effect => effect.code === 'program-ready'));
  assert.ok(first.items[1].effects.some(effect => effect.code === 'dependency-not-ready'));
  assert.equal(f.pluginCommands.length, 0);
  f.recoverProgramRead();
  const continued = await f.ccw.plan({ resume: first.remaining });
  const result = await f.ccw.apply(continued.id);
  assert.equal(result.items[0].state, 'done');
  assert.ok(f.pluginCommands.length > 0);
  assert.equal(npmOf(f, 'install').length, 1);
  assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length, 1);
});

test('Claude 就绪通知后的程序复核失败：停止依赖，续办沿用已确认的安装', async t => {
  const f = await fixture(t);
  const plan = await f.ccw.plan({
    task: 'install',
    selected: [{ id: 'claude' }, { id: 'plugin:github@claude-plugins-official' }],
  });
  const first = await f.ccw.apply(plan.id, undefined, event => {
    if (event.kind === 'effect' && event.effect.code === 'program-ready') f.suspendProgramRead();
  });
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  assert.ok(first.items[1].effects.some(effect => effect.code === 'dependency-not-ready'));
  assert.equal(f.pluginCommands.length, 0);
  assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length, 0);
  f.recoverProgramRead();
  const continued = await f.ccw.plan({ resume: first.remaining });
  const result = await f.ccw.apply(continued.id);
  assert.equal(result.items[0].state, 'done');
  assert.ok(f.pluginCommands.length > 0);
  assert.equal(npmOf(f, 'install').length, 1);
});
