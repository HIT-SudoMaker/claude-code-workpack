import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { runTerminal } from './terminal-test.mjs';
import { createEnv, exists, ok } from './env.mjs';

const revision = 'a'.repeat(40);
const verdict = work => Promise.race([work, new Promise(resolve => setTimeout(() => resolve('still-waiting'), 150))]);

async function fixture(t, overrides = {}) {
  const f = await createEnv(t);
  // 场景响应语义经 overrides 提供；缺省 execute 沿用原装配：任何命令固定返回 Git 修订
  const base = f.machine({
    execute: overrides.execute ?? (async () => ok(revision)),
  });
  const machine = {
    ...base,
    source: overrides.source ?? (async () => [{ path: 'one/SKILL.md', data: Buffer.from('skill') }]),
  };
  const ccw = f.ccw(machine, { platform: process.platform });
  return { ...f, machine, ccw };
}

async function cancelledPreparationCase(t, { hook, release }) {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const abort = new AbortController();
  t.after(() => {
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
  const { home, ccw } = await fixture(
    t,
    hook === 'source'
      ? {
          async source(_repository, _revision, _folder, options) {
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

test('取消技能准备：终止 Git 查询', t => cancelledPreparationCase(t, { hook: 'execute', release: ok(revision) }));

test('取消技能获取：释放准备计划', t => cancelledPreparationCase(t, { hook: 'source', release: [] }));

test('取消安装准备：禁止执行安装', async t => {
  const abort = new AbortController();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const waits = [];
  t.after(() => {
    abort.abort();
    release.resolve({ id: 'late', items: [], problem: null });
  });
  const item = {
    id: 'skill-set:ssre2',
    title: 'HIT-SudoMaker/SSRE2',
    kind: 'skill',
    canInstall: true,
    facts: [],
    actions: ['install'],
  };
  const running = runTerminal(
    {
      async inspect() {
        return { items: [item], problems: [] };
      },
      async plan(_request, signal) {
        entered.resolve();
        signal?.addEventListener('abort', () => release.reject(new Error('cancelled')), { once: true });
        return release.promise;
      },
      async apply() {
        assert.fail('cancelled preparation must not apply');
      },
    },
    {
      async choose() {
        return 0;
      },
      show() {},
      async select(_page, change) {
        change({ kind: 'toggle', index: 0 });
        return { kind: 'submit', index: 1 };
      },
      async wait(title, work, signal) {
        waits.push(title);
        try {
          return await work(signal ?? abort.signal);
        } catch (error) {
          if (signal?.aborted) return null;
          throw error;
        }
      },
    },
    abort.signal,
  ).then(() => 'stopped');
  await entered.promise;
  abort.abort();
  assert.equal(await verdict(running), 'stopped');
  assert.ok(waits.includes('准备安装'));
});

test('准备技能：报告获取步骤', async t => {
  const events = [];
  const { home, ccw } = await fixture(t, {
    async execute(_file, _args, options) {
      assert.ok(options.timeoutMs <= 15_000);
      return ok(revision);
    },
    async source(_repository, _revision, _directory, options) {
      assert.equal(options.timeoutMs, 120_000);
      return [{ path: 'one/SKILL.md', data: Buffer.from('skill') }];
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

test('安装技能：隔离准备信号', async t => {
  const { home, ccw } = await fixture(t);
  const abort = new AbortController();
  const plan = await ccw.plan({ task: 'install', selected: [{ id: 'skill-set:ssre2' }] }, abort.signal);
  assert.equal(plan.items[0].problem, null);
  abort.abort();
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  assert.equal(await fs.readFile(path.join(home, '.claude/skills/one/SKILL.md'), 'utf8'), 'skill');
});

test('并行准备：限制两项并保留进度归属和结果顺序', async t => {
  let active = 0;
  let peak = 0;
  const events = [];
  const pause = async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 8));
    active--;
  };
  const { ccw } = await fixture(t, {
    async execute() {
      await pause();
      return ok(revision);
    },
    async source(repository, _revision, folder) {
      await pause();
      return [
        {
          path: folder.endsWith('ssre2-design')
            ? 'SKILL.md'
            : `${repository.includes('mattpocock') ? 'matt-member' : 'ssre-member'}/SKILL.md`,
          data: Buffer.from('skill'),
        },
      ];
    },
  });
  const ids = ['skill-set:ssre2', 'skill-set:mattpocock', 'skill:ssre2-design'];
  const plan = await ccw.plan({ task: 'install', selected: ids.map(id => ({ id })) }, undefined, event =>
    events.push(event),
  );
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

test('重复选择：准备前拒绝且不读取来源', async t => {
  let metadataCalls = 0;
  let sourceCalls = 0;
  const { ccw } = await fixture(t, {
    async execute() {
      metadataCalls++;
      return ok(revision);
    },
    async source() {
      sourceCalls++;
      return [{ path: 'one/SKILL.md', data: Buffer.from('skill') }];
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

test('取消并行准备：等待在途工作结束并停止后续项', async t => {
  const controller = new AbortController();
  const entered = Promise.withResolvers();
  const events = [];
  let calls = 0;
  let active = 0;
  t.after(() => controller.abort());
  const { ccw } = await fixture(t, {
    async execute(_file, _args, options) {
      active++;
      if (++calls === 2) entered.resolve();
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('gate-timeout')), 2000);
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
