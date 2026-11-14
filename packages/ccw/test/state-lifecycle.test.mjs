import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { createTestEnvironment } from './test-environment.mjs';
import { createRunPresentation } from '../dist/render.js';

const quietNpm = () => ({ code: 0, failed: false, stdout: '{}' });
const seed = {
  settings: { enabledPlugins: { 'github@claude-plugins-official': true, 'serena@claude-plugins-official': true } },
};

async function createLifecycleScenario(testContext) {
  const workspace = await createTestEnvironment(testContext, { seed });
  return {
    ...workspace,
    ccw: workspace.ccw(workspace.machine({ npm: quietNpm })),
  };
}

async function createGatedLifecycleScenario(testContext) {
  const workspace = await createTestEnvironment(testContext, { seed });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let block = false;
  const ccw = workspace.ccw(
    workspace.machine({
      npm: quietNpm,
      read: async (file, base) => {
        if (file === workspace.settingsFile && block) {
          block = false;
          entered.resolve();
          await release.promise;
        }
        return base.read(file);
      },
    }),
  );
  return {
    workspace,
    ccw,
    entered,
    release,
    pauseSettingsReads() {
      block = true;
    },
  };
}

// 准备与结果快照
test('冻结准备中的输入草稿', async testContext => {
  const { workspace, ccw, entered, release, pauseSettingsReads } = await createGatedLifecycleScenario(testContext);
  const selection = { id: 'settings', fields: { language: '中文' } };
  pauseSettingsReads();
  const preparing = ccw.plan({ task: 'install', selected: [selection] });
  await entered.promise;
  selection.fields.language = 'English';
  release.resolve();
  const plan = await preparing;
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  assert.equal((await workspace.read(workspace.settingsFile)).language, '中文');
});

test('隔离调用方的预览与进度修改', async testContext => {
  const scenario = await createLifecycleScenario(testContext);
  const plan = await scenario.ccw.plan({
    task: 'uninstall',
    selected: [{ id: 'plugin:serena@claude-plugins-official' }],
  });
  plan.items.length = 0;
  const result = await scenario.ccw.apply(plan.id, undefined, event => {
    if (event.kind === 'effect') event.effect.code = 'caller-mutation';
    if (event.kind === 'finished') {
      event.result.state = 'failed';
      event.result.effects.length = 0;
    }
  });
  assert.equal(result.state, 'done');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].state, 'done');
  assert.ok(result.items[0].effects.some(effect => effect.code === 'plugin-disabled'));
  assert.equal((await scenario.read(scenario.settingsFile)).enabledPlugins['serena@claude-plugins-official'], false);
});

// 计划生命周期与并发保护
test('准备新计划：拒绝并发与旧计划', async testContext => {
  const { workspace, ccw, entered, release, pauseSettingsReads } = await createGatedLifecycleScenario(testContext);
  const old = await ccw.plan({ task: 'uninstall', selected: [{ id: 'plugin:serena@claude-plugins-official' }] });
  pauseSettingsReads();
  const preparing = ccw.plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
  await entered.promise;
  try {
    assert.equal((await ccw.apply(old.id)).items[0].effects[0].code, 'operation-in-progress');
    await assert.rejects(
      ccw.plan({ task: 'uninstall', selected: [{ id: 'plugin:serena@claude-plugins-official' }] }),
      /operation-in-progress/,
    );
    assert.equal((await workspace.read(workspace.settingsFile)).enabledPlugins['serena@claude-plugins-official'], true);
  } finally {
    release.resolve();
  }
  const next = await preparing;
  assert.equal((await ccw.apply(old.id)).items[0].effects[0].code, 'plan-unavailable');
  assert.equal((await ccw.apply(next.id)).state, 'done');
  assert.equal((await ccw.apply(next.id)).items[0].effects[0].code, 'plan-unavailable');
});

test('新实例不能应用旧实例的内存计划', async testContext => {
  const workspace = await createTestEnvironment(testContext, { seed });
  const machine = workspace.machine({ npm: quietNpm });
  const first = workspace.ccw(machine);
  const plan = await first.plan({ task: 'uninstall', selected: [{ id: 'plugin:serena@claude-plugins-official' }] });
  const restarted = workspace.ccw(machine);
  const result = await restarted.apply(plan.id);
  assert.equal(result.items[0].effects[0].code, 'plan-unavailable');
  assert.equal((await workspace.read(workspace.settingsFile)).enabledPlugins['serena@claude-plugins-official'], true);
});

// 观察者失败隔离
for (const kind of ['started', 'effect', 'finished'])
  test(`隔离 ${kind} 进度通知异常`, async testContext => {
    const scenario = await createLifecycleScenario(testContext);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let settingsWrites = 0;
    scenario.faults.editJson.set(scenario.settingsFile, async () => {
      if (++settingsWrites !== 2) return;
      entered.resolve();
      await release.promise;
    });
    const plan = await scenario.ccw.plan({
      task: 'uninstall',
      selected: [{ id: 'plugin:github@claude-plugins-official' }, { id: 'plugin:serena@claude-plugins-official' }],
    });
    let notificationsAfterFailure = 0;
    let observerFailed = false;
    let settled = false;
    const applying = scenario.ccw.apply(plan.id, undefined, event => {
      if (observerFailed) notificationsAfterFailure++;
      if (event.id === 'plugin:github@claude-plugins-official' && event.kind === kind) {
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
      await assert.rejects(
        scenario.ccw.plan({ task: 'install', selected: [{ id: 'settings' }] }),
        /operation-in-progress/,
      );
    } finally {
      release.resolve();
    }
    const result = await outcome;
    assert.equal(result.error, undefined);
    assert.equal(result.value.state, 'done');
    assert.equal(observerFailed, true);
    assert.equal(notificationsAfterFailure, 0);
    assert.equal((await scenario.read(scenario.settingsFile)).enabledPlugins['github@claude-plugins-official'], false);
    assert.equal((await scenario.read(scenario.settingsFile)).enabledPlugins['serena@claude-plugins-official'], false);
  });

test('隔离异步进度通知异常', () => {
  const script = `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import os from 'node:os';
    import fs from 'node:fs/promises';
    import { createMachine } from ${JSON.stringify(new URL('../dist/machine.js', import.meta.url).href)};
    import { createCcw } from ${JSON.stringify(new URL('../dist/ccw.js', import.meta.url).href)};
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ccw-observer-'));
    const claudeRoot = path.join(home, '.claude');
    let settings = { enabledPlugins: { 'github@claude-plugins-official': true } };
    const machine = createMachine({}, home);
    await fs.mkdir(claudeRoot, { recursive: true });
    await fs.writeFile(path.join(claudeRoot, 'settings.json'), JSON.stringify(settings));
    const ccw = createCcw({ machine, home, claudeRoot, cclineRoot: path.join(claudeRoot, 'ccline'), platform: process.platform });
    const plan = await ccw.plan({ task: 'uninstall', selected: [{ id: 'plugin:github@claude-plugins-official' }] });
    let notifications = 0;
    const result = await ccw.apply(plan.id, undefined, async () => { notifications++; throw new Error('observer-async-failed'); });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.state, 'done'); assert.equal(notifications, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(claudeRoot, 'settings.json'))).enabledPlugins['github@claude-plugins-official'], false);
    await fs.rm(home, { recursive: true, force: true });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
});

// 取消与已发生效果
test('预先取消准备后释放操作互斥', async testContext => {
  const scenario = await createLifecycleScenario(testContext);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    scenario.ccw.plan({ task: 'uninstall', selected: [{ id: 'plugin:serena@claude-plugins-official' }] }, abort.signal),
    /cancelled/,
  );
  const plan = await scenario.ccw.plan({
    task: 'uninstall',
    selected: [{ id: 'plugin:serena@claude-plugins-official' }],
  });
  assert.equal((await scenario.ccw.apply(plan.id)).state, 'done');
});

test('取消保留此前成功与失败，只停止未执行项目', async testContext => {
  const scenario = await createLifecycleScenario(testContext);
  const plan = await scenario.ccw.plan({
    task: 'uninstall',
    selected: [
      { id: 'constructor' },
      { id: 'plugin:github@claude-plugins-official' },
      { id: 'plugin:serena@claude-plugins-official' },
    ],
  });
  assert.equal(plan.items[0].problem, 'unknown-selection');
  const abort = new AbortController();
  const progress = createRunPresentation(plan);
  const events = [];
  let stopped;
  const result = await scenario.ccw.apply(plan.id, abort.signal, event => {
    events.push(event.kind + ':' + event.id);
    const view = progress.progress(event);
    if (event.kind === 'checked' && event.id === 'plugin:serena@claude-plugins-official') stopped = view.rows[2].status;
    if (event.kind === 'started' && event.id === 'plugin:serena@claude-plugins-official') abort.abort();
  });
  assert.match(stopped, /已停止/);
  assert.ok(
    events.indexOf('checked:plugin:serena@claude-plugins-official') <
      events.indexOf('finished:plugin:serena@claude-plugins-official'),
  );
  assert.equal(result.state, 'cancelled');
  assert.deepEqual(
    result.items.map(item => item.state),
    ['failed', 'done', 'cancelled'],
  );
  assert.equal((await scenario.read(scenario.settingsFile)).enabledPlugins['github@claude-plugins-official'], false);
  assert.equal((await scenario.read(scenario.settingsFile)).enabledPlugins['serena@claude-plugins-official'], true);
  assert.ok(!result.items[1].effects.some(effect => effect.code === 'cancelled'));
  const view = createRunPresentation(plan).result(result);
  assert.match(view.summary, /完成 1.*失败 1.*已停止 1/);
  assert.match(view.rows[0].status, /失败/);
});

test('写入已生效时取消：核验成功项，不继续写入', async testContext => {
  const workspace = await createTestEnvironment(testContext, { seed });
  const abort = new AbortController();
  const base = workspace.machine({ npm: quietNpm });
  const ccw = workspace.ccw({
    ...base,
    async editJson(file, edit) {
      await base.editJson(file, edit);
      if (file === workspace.settingsFile) abort.abort();
    },
  });
  const plan = await ccw.plan({
    task: 'uninstall',
    selected: [{ id: 'plugin:github@claude-plugins-official' }, { id: 'plugin:serena@claude-plugins-official' }],
  });
  const result = await ccw.apply(plan.id, abort.signal);
  assert.deepEqual(
    result.items.map(item => item.state),
    ['done', 'cancelled'],
  );
  assert.equal((await workspace.read(workspace.settingsFile)).enabledPlugins['github@claude-plugins-official'], false);
  assert.equal((await workspace.read(workspace.settingsFile)).enabledPlugins['serena@claude-plugins-official'], true);
});
