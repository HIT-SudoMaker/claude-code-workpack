import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createTestEnvironment, exists, ok } from './test-environment.mjs';
import { createSkillsCliFixture } from './skills-cli-fixture.mjs';

const revision = 'a'.repeat(40);
const CANCELLATION_TIMEOUT_MS = 150;
const GATE_TIMEOUT_MS = 2_000;

async function verdict(work) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise(resolve => {
        timer = setTimeout(() => resolve('still-waiting'), CANCELLATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function createPreparationScenario(testContext, overrides = {}) {
  const workspace = await createTestEnvironment(testContext);
  const cli = createSkillsCliFixture(workspace);
  const machine = workspace.machine({
    execute: overrides.execute ?? (async () => ok(revision)),
    npm: overrides.npm ?? cli.npm,
  });
  const ccw = workspace.ccw(machine, { platform: process.platform });
  return { ...workspace, machine, ccw };
}

async function verifyCancelledPreparation(testContext, { hook, release }) {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const abort = new AbortController();
  testContext.after(() => {
    abort.abort();
    gate.resolve(release);
  });
  let receivedSignal;
  const capture = options => {
    receivedSignal = options?.signal;
    entered.resolve();
    receivedSignal?.addEventListener('abort', () => gate.reject(new Error('cancelled')), { once: true });
    return gate.promise;
  };
  const { home, ccw } = await createPreparationScenario(
    testContext,
    hook === 'source'
      ? {
          async npm(_args, options) {
            return capture(options);
          },
        }
      : {
          async execute(_file, _args, options) {
            return capture(options);
          },
        },
  );
  const preparing = ccw.plan({ task: 'install', selected: [{ id: 'skill-set:ssre2' }] }, abort.signal).then(
    () => 'late-plan',
    error => error.message,
  );
  await entered.promise;
  abort.abort();
  assert.equal(await verdict(preparing), 'cancelled');
  assert.equal(receivedSignal.aborted, true);
  assert.equal((await ccw.plan({ task: 'install', selected: [] })).problem, 'empty-selection');
  assert.equal(await exists(path.join(home, '.claude')), false);
}

// 准备进度与分组顺序
test('准备技能：报告获取步骤', async testContext => {
  const events = [];
  const { home, ccw } = await createPreparationScenario(testContext, {
    async execute(_file, _args, options) {
      assert.ok(options.timeoutMs <= 15_000);
      return ok(revision);
    },
    async npm(_args, options) {
      assert.equal(options.timeoutMs, 120_000);
      return ok('◇  Available Skills\n│    ssre2-design\n└  Use --skill <name> to install specific skills');
    },
  });
  const plan = await ccw.plan({ task: 'install', selected: [{ id: 'skill-set:ssre2' }] }, undefined, event =>
    events.push(event),
  );
  assert.equal(plan.items[0].problem, null);
  assert.deepEqual(
    events.map(event => event.stage),
    ['inspect', 'metadata', 'source'],
  );
  assert.ok(events.every(event => event.id === 'skill-set:ssre2'));
  assert.equal(await exists(path.join(home, '.claude')), false);
});

test('并行准备：限制两项并保留进度归属和结果顺序', { timeout: GATE_TIMEOUT_MS }, async testContext => {
  let active = 0;
  let peak = 0;
  const pairStarted = Promise.withResolvers();
  const release = Promise.withResolvers();
  testContext.after(() => release.resolve());
  const events = [];
  const pause = async () => {
    peak = Math.max(peak, ++active);
    if (active === 2) pairStarted.resolve();
    await release.promise;
    active--;
  };
  const { ccw } = await createPreparationScenario(testContext, {
    async execute() {
      await pause();
      return ok(revision);
    },
    async npm(args) {
      await pause();
      return ok(
        '◇  Available Skills\n│    ' +
          (args[6].endsWith('ssre2-design')
            ? 'ssre2-design'
            : args[6].includes('mattpocock')
              ? 'matt-member'
              : 'ssre-member') +
          '\n└  Use --skill <name> to install specific skills',
      );
    },
  });
  const ids = ['skill-set:ssre2', 'skill-set:mattpocock', 'skill:ssre2-design'];
  const preparing = ccw.plan({ task: 'install', selected: ids.map(id => ({ id })) }, undefined, event =>
    events.push(event),
  );
  await pairStarted.promise;
  assert.equal(events.filter(event => event.stage === 'inspect').length, 2);
  release.resolve();
  const plan = await preparing;
  assert.equal(peak, 2);
  assert.deepEqual(
    plan.items.map(item => item.id),
    ids,
  );
  assert.ok(plan.items.every(item => item.problem === null));
  for (const item of plan.items) {
    const own = events.filter(event => event.id === item.id);
    assert.deepEqual(
      own.map(event => event.stage),
      ['inspect', 'metadata', 'source'],
    );
    assert.ok(own.every(event => event.title === item.title));
  }
});

for (const task of ['install', 'uninstall'])
  test(`混合准备：Claude 先准备，${task} 预览保持分组顺序`, async testContext => {
    const events = [];
    const { ccw } = await createPreparationScenario(testContext);
    const ids = ['settings', 'claude', 'skill-set:ssre2'];
    const plan = await ccw.plan({ task, selected: ids.map(id => ({ id })) }, undefined, event => events.push(event));
    assert.equal(events[0].id, 'claude');
    assert.deepEqual(
      plan.items.map(item => item.id),
      task === 'install' ? ['claude', 'settings', 'skill-set:ssre2'] : ['settings', 'skill-set:ssre2', 'claude'],
    );
    assert.equal(plan.items.find(item => item.id === 'settings').action, task === 'install' ? 'configure' : 'detach');
  });

// 准备与执行的信号边界
test('安装技能：隔离准备信号', async testContext => {
  const { home, ccw } = await createPreparationScenario(testContext);
  const abort = new AbortController();
  const plan = await ccw.plan({ task: 'install', selected: [{ id: 'skill-set:ssre2' }] }, abort.signal);
  assert.equal(plan.items[0].problem, null);
  abort.abort();
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  assert.match(await fs.readFile(path.join(home, '.claude/skills/ssre2-design/SKILL.md'), 'utf8'), /first/);
});

// 输入冲突与通知失败
test('未知插件先由 Plugins 拒绝，不触发 Claude 或 npm 发现', async testContext => {
  const workspace = await createTestEnvironment(testContext);
  const ccw = workspace.ccw(workspace.machine());
  const plan = await ccw.plan({ task: 'install', selected: [{ id: 'plugin:not-managed' }] });
  assert.equal(plan.items[0].problem, 'unknown-selection');
  assert.deepEqual(workspace.calls, []);
});

test('Claude 设置读取失败不遮蔽程序与插件项目', async testContext => {
  const workspace = await createTestEnvironment(testContext);
  await workspace.write(workspace.settingsFile, '{broken');
  const ccw = workspace.ccw(workspace.machine({ npm: async () => ok('{}') }));
  const inspection = await ccw.inspect();
  assert.ok(inspection.items.some(item => item.id === 'claude'));
  assert.ok(inspection.items.some(item => item.id === 'plugin:serena@claude-plugins-official'));
  assert.ok(inspection.problems.some(problem => problem.code === 'invalid-settings' && problem.detail === 'settings'));
});

test('重复选择：准备前拒绝且不读取来源', async testContext => {
  let metadataCalls = 0;
  let sourceCalls = 0;
  const { ccw } = await createPreparationScenario(testContext, {
    async execute() {
      metadataCalls++;
      return ok(revision);
    },
    async npm() {
      sourceCalls++;
      return ok('');
    },
  });
  await assert.rejects(
    ccw.plan({
      task: 'install',
      selected: [{ id: 'skill-set:ssre2' }, { id: 'skill-set:ssre2' }],
    }),
    /duplicate-selection/,
  );
  assert.equal(metadataCalls, 0);
  assert.equal(sourceCalls, 0);
});

for (const asynchronous of [false, true])
  test('准备回调失败不污染计划或阻断操作：' + (asynchronous ? '异步' : '同步'), async testContext => {
    const { ccw } = await createPreparationScenario(testContext);
    let notifications = 0;
    const plan = await ccw.plan({ task: 'install', selected: [{ id: 'skill-set:ssre2' }] }, undefined, event => {
      notifications++;
      event.id = 'caller-mutation';
      event.title = 'caller-mutation';
      if (asynchronous) return Promise.reject(new Error('observer-failed'));
      throw new Error('observer-failed');
    });
    assert.equal(notifications, 1);
    assert.equal(plan.items[0].id, 'skill-set:ssre2');
    assert.equal(plan.items[0].title, 'HIT-SudoMaker/SSRE2');
    assert.equal(plan.items[0].problem, null);
    assert.equal((await ccw.apply(plan.id)).state, 'done');
  });

// 取消准备与后续恢复
test('取消技能准备：终止 Git 查询', testContext =>
  verifyCancelledPreparation(testContext, { hook: 'execute', release: ok(revision) }));

test('取消技能获取：释放准备计划', testContext =>
  verifyCancelledPreparation(testContext, { hook: 'source', release: [] }));

test('取消并行准备：等待在途工作结束并停止后续项', async testContext => {
  const controller = new AbortController();
  const entered = Promise.withResolvers();
  const events = [];
  let calls = 0;
  let active = 0;
  testContext.after(() => controller.abort());
  const { ccw } = await createPreparationScenario(testContext, {
    async execute(_file, _args, options) {
      active++;
      if (++calls === 2) entered.resolve();
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('gate-timeout')), GATE_TIMEOUT_MS);
          options.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('cancelled'));
            },
            { once: true },
          );
        });
      } finally {
        active--;
      }
    },
  });
  const pending = ccw.plan(
    {
      task: 'install',
      selected: [{ id: 'skill-set:ssre2' }, { id: 'skill-set:mattpocock' }, { id: 'skill:amirc-research' }],
    },
    controller.signal,
    event => events.push(event),
  );
  const outcome = assert.rejects(pending, /cancelled/);
  await entered.promise;
  controller.abort();
  await outcome;
  assert.equal(calls, 2);
  assert.equal(active, 0);
  assert.ok(events.every(event => event.id !== 'skill:amirc-research'));
  const next = await ccw.plan({ task: 'install', selected: [{ id: 'settings' }] });
  assert.equal(next.items[0].problem, null);
});
