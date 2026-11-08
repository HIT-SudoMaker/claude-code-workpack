import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { contentRows } from '../dist/render.js';
import { createEnv } from './env.mjs';

const quietNpm = () => ({ code: 0, failed: false, stdout: '{}' });
const seed = {
  settings: { enabledPlugins: { 'active@market': true } },
  state: { mcpServers: { external: { command: 'shared program' } } },
};

async function fixture(t) {
  const f = await createEnv(t, { layout: 'home', seed });
  return { ...f, ccw: f.ccw(f.machine({ npm: quietNpm })) };
}

async function gatedFixture(t) {
  const f = await createEnv(t, { layout: 'home', seed });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let block = true;
  const ccw = f.ccw(
    f.machine({
      npm: quietNpm,
      read: async (file, base) => {
        if (file === f.settingsFile && block) {
          block = false;
          entered.resolve();
          await release.promise;
        }
        return base.read(file);
      },
    }),
  );
  return { f, ccw, entered, release };
}

test('准备新计划：拒绝并发与旧计划', async t => {
  const { f, ccw, entered, release } = await gatedFixture(t);
  const old = await ccw.plan({ task: 'detach', selected: [{ id: 'mcp:external' }] });
  const preparing = ccw.plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
  await entered.promise;
  try {
    assert.equal((await ccw.apply(old.id)).items[0].effects[0].code, 'operation-in-progress');
    await assert.rejects(ccw.plan({ task: 'detach', selected: [{ id: 'mcp:external' }] }), /operation-in-progress/);
    assert.ok((await f.read(f.stateFile)).mcpServers.external);
  } finally {
    release.resolve();
  }
  const next = await preparing;
  assert.equal((await ccw.apply(old.id)).items[0].effects[0].code, 'plan-unavailable');
  assert.equal((await ccw.apply(next.id)).state, 'done');
  assert.equal((await ccw.apply(next.id)).items[0].effects[0].code, 'plan-unavailable');
});

for (const kind of ['started', 'effect', 'finished'])
  test(`隔离 ${kind} 进度通知异常`, async t => {
    const f = await fixture(t);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    f.faults.editJson.set(f.stateFile, async () => {
      entered.resolve();
      await release.promise;
    });
    const plan = await f.ccw.plan({
      task: 'detach',
      selected: [{ id: 'plugin:active@market' }, { id: 'mcp:external' }],
    });
    let notificationsAfterFailure = 0;
    let observerFailed = false;
    let settled = false;
    const applying = f.ccw.apply(plan.id, undefined, event => {
      if (observerFailed) notificationsAfterFailure++;
      if (event.id === 'plugin:active@market' && event.kind === kind) {
        observerFailed = true;
        throw new Error('observer-failed');
      }
    });
    // 提前接收拒绝，避免未处理异常
    const outcome = applying
      .then(
        value => ({ value }),
        error => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false);
      await assert.rejects(f.ccw.plan({ task: 'install', selected: [{ id: 'settings' }] }), /operation-in-progress/);
    } finally {
      release.resolve();
    }
    const result = await outcome;
    assert.equal(result.error, undefined);
    assert.equal(result.value.state, 'done');
    assert.equal(observerFailed, true);
    assert.equal(notificationsAfterFailure, 0);
    assert.equal((await f.read(f.settingsFile)).enabledPlugins['active@market'], false);
    assert.deepEqual((await f.read(f.stateFile)).mcpServers, {});
  });

test('冻结准备中的输入草稿', async t => {
  const { f, ccw, entered, release } = await gatedFixture(t);
  const selection = { id: 'settings', fields: { language: '中文' } };
  const preparing = ccw.plan({ task: 'install', selected: [selection] });
  await entered.promise;
  selection.fields.language = 'English';
  release.resolve();
  const plan = await preparing;
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  assert.equal((await f.read(f.settingsFile)).language, '中文');
});

test('隔离异步进度通知异常', () => {
  const script = `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { createCcw } from ${JSON.stringify(new URL('../dist/ccw.js', import.meta.url).href)};
    const home = path.resolve('virtual-observer-home');
    const claudeRoot = path.join(home, '.claude');
    let settings = { enabledPlugins: { 'active@market': true } };
    const machine = { read: async () => JSON.stringify(settings), editJson: async (_file, edit) => { edit(settings); } };
    const ccw = createCcw({ machine, home, claudeRoot, cclineRoot: path.join(claudeRoot, 'ccline'), platform: process.platform });
    const plan = await ccw.plan({ task: 'detach', selected: [{ id: 'plugin:active@market' }] });
    let notifications = 0;
    const result = await ccw.apply(plan.id, undefined, async () => { notifications++; throw new Error('observer-async-failed'); });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.state, 'done'); assert.equal(notifications, 1);
    assert.equal(settings.enabledPlugins['active@market'], false);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
});

test('隔离调用方的预览与进度修改', async t => {
  const f = await fixture(t);
  const plan = await f.ccw.plan({ task: 'detach', selected: [{ id: 'mcp:external' }] });
  plan.items.length = 0;
  const result = await f.ccw.apply(plan.id, undefined, event => {
    if (event.kind === 'effect') event.effect.code = 'caller-mutation';
    if (event.kind === 'finished') {
      event.result.state = 'failed';
      event.result.effects.length = 0;
    }
  });
  assert.equal(result.state, 'done');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].state, 'done');
  assert.ok(result.items[0].effects.some(effect => effect.code === 'registration-removed'));
  assert.deepEqual((await f.read(f.stateFile)).mcpServers, {});
});

test('读取插件记录失败：保留未知状态', async t => {
  const f = await fixture(t);
  const name = 'code-simplifier@claude-plugins-official';
  await f.json(f.settingsFile, { enabledPlugins: { [name]: true } });
  const records = path.join(f.claudeRoot, 'plugins/installed_plugins.json');
  await f.write(records, '{broken');
  const view = await f.ccw.inspect();
  const plugin = view.items.find(item => item.id === `plugin:${name}`);
  assert.equal(contentRows([plugin])[0].detail, '待确认');
  assert.equal(
    plugin.facts.some(fact => fact.code === 'plugin-not-installed'),
    false,
  );
  assert.deepEqual(plugin.actions, ['detach']);
  const plan = await f.ccw.plan({ task: 'detach', selected: [{ id: plugin.id }] });
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.equal(await fs.readFile(records, 'utf8'), '{broken');
  assert.equal((await f.read(f.settingsFile)).enabledPlugins[name], false);
});

test('来源记录损坏：继续发现技能', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.home, '.ccw/sources.json'), '{broken');
  await f.write(path.join(f.claudeRoot, 'skills/external/SKILL.md'), 'skill resource');
  await f.write(path.join(f.claudeRoot, 'commands/nested/local.md'), 'command resource');
  const view = await f.ccw.inspect();
  const ids = ['skill:external', 'command:nested/local.md'];
  assert.ok(view.problems.some(problem => problem.code === 'source-metadata-unavailable'));
  for (const id of ids) assert.ok(view.items.find(item => item.id === id)?.actions.includes('detach'));
  const plan = await f.ccw.plan({ task: 'detach', selected: ids.map(id => ({ id })) });
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
});

test('失效 Claude 计划：停止依赖续跑', async t => {
  const f = await createEnv(t, { layout: 'home', seed });
  const packageName = '@anthropic-ai/claude-code';
  const npmRoot = path.join(f.root, 'npm/node_modules');
  const binary = path.join(npmRoot, packageName, 'cli.js');
  const pluginName = 'frontend-design@claude-plugins-official';
  await f.json(path.join(npmRoot, packageName, 'package.json'), { name: packageName, bin: { claude: 'cli.js' } });
  await f.write(binary, 'original program');
  const machine = f.machine({
    npm: async args => ({
      code: 0,
      failed: false,
      stdout:
        args[0] === 'root'
          ? npmRoot
          : args[0] === 'view'
            ? '"2.1.2"'
            : JSON.stringify({
                dependencies: args.at(-1) === packageName ? { [packageName]: { version: '2.1.1' } } : {},
              }),
    }),
    execute: async (_file, args) => {
      const command = args.slice(1);
      if (command[1] === 'marketplace')
        await f.json(path.join(f.claudeRoot, 'plugins/known_marketplaces.json'), {
          'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } },
        });
      if (command[1] === 'install') {
        const installPath = path.join(f.claudeRoot, 'plugins/cache', pluginName);
        await f.write(path.join(installPath, '.claude-plugin/plugin.json'), '{}');
        await f.json(path.join(f.claudeRoot, 'plugins/installed_plugins.json'), {
          plugins: { [pluginName]: [{ scope: 'user', installPath }] },
        });
        await machine.editJson(f.settingsFile, settings => {
          settings.enabledPlugins[pluginName] = true;
        });
      }
      return { code: 0, failed: false, stdout: '' };
    },
  });
  const ccw = f.ccw(machine);
  const plan = await ccw.plan({
    task: 'install',
    selected: [{ id: 'claude', maintenance: 'update' }, { id: `plugin:${pluginName}` }],
  });
  assert.ok(
    plan.items.every(item => item.problem === null),
    JSON.stringify(plan),
  );
  await f.write(binary, 'externally replaced program');
  const first = await ccw.apply(plan.id);
  if (first.remaining) await ccw.apply((await ccw.plan({ resume: first.remaining })).id);
  const commands = f.calls.filter(call => call.kind === 'execute').map(call => call.args.slice(1));
  assert.deepEqual(commands, []);
  assert.equal(first.items.find(item => item.id === `plugin:${pluginName}`).isPending, false);
  assert.equal(first.remaining, undefined);
  assert.equal((await f.read(f.settingsFile)).enabledPlugins[pluginName], undefined);
});
