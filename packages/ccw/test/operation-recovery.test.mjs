import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import fs from 'node:fs/promises';

import { createEnv } from './env.mjs';
import { createCcw } from '../dist/ccw.js';

test('旧进程遗留 JSON 锁不阻止新实例恢复已批准配置', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English', custom: true } } });
  const machine = f.machine();
  await f.ccw(machine).plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
  await f.write(`${f.settingsFile}.ccw-lock`, '');
  const restarted = f.ccw(machine);
  const recovery = await restarted.recovery();
  const plan = await restarted.plan({ resume: recovery.id });
  assert.equal((await restarted.apply(plan.id)).state, 'done');
  const settings = await f.read(f.settingsFile);
  assert.equal(settings.language, '中文');
  assert.equal(settings.custom, true);
});

for (const kind of ['settings', 'plugin', 'ccline'])
  test(`成功回执后恢复原配置：新实例保护重建的 ${kind} 字段`, async t => {
    const original = {
      language: 'English',
      enabledPlugins: { 'external@market': true },
      statusLine: { type: 'command', command: 'ccline' },
    };
    const f = await createEnv(t, { seed: { settings: original } });
    let unreadable = false;
    const machine = f.machine({
      read: (file, base) => {
        if (file === f.settingsFile && unreadable) throw new Error('fixture-read-unavailable');
        return base.read(file);
      },
      async editJson(file, edit) {
        const actual = f.machine();
        await actual.editJson(file, edit);
        if (file === f.settingsFile) unreadable = true;
      },
    });
    const first = f.ccw(machine);
    const preview = await first.plan(
      kind === 'settings'
        ? { task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] }
        : { task: 'detach', selected: [{ id: kind === 'plugin' ? 'plugin:external@market' : 'ccline' }] },
    );
    const interrupted = await first.apply(preview.id);
    assert.ok(interrupted.remaining);
    await f.json(f.settingsFile, original);
    unreadable = false;
    const writes = f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length;
    const restarted = f.ccw(machine);
    const remaining = await restarted.plan({ resume: interrupted.remaining });
    const result = await restarted.apply(remaining.id);
    assert.ok(
      result.items[0].effects.some(
        effect => effect.code === (kind === 'ccline' ? 'connection-changed' : 'target-changed'),
      ),
    );
    assert.deepEqual(await f.read(f.settingsFile), original);
    assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length, writes);
  });

test('重建实例发现冻结的设置计划，确认前不修改目标', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English', custom: { keep: true } } } });
  const machine = f.machine();
  const first = f.ccw(machine);
  const plan = await first.plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
  const restarted = f.ccw(machine);
  assert.equal((await restarted.apply(plan.id)).state, 'failed');
  assert.equal((await f.read(f.settingsFile)).language, 'English');
  const recovery = await restarted.recovery();
  assert.ok(recovery);
  assert.equal((await f.read(f.settingsFile)).language, 'English');
  const remaining = await restarted.plan({ resume: recovery.id });
  assert.equal(remaining.items[0].action, 'configure');
  assert.equal((await f.read(f.settingsFile)).language, 'English');
  assert.notEqual(remaining.id, plan.id);
  assert.equal((await restarted.apply(remaining.id)).state, 'done');
  assert.equal((await f.read(f.settingsFile)).language, '中文');
  assert.deepEqual((await f.read(f.settingsFile)).custom, { keep: true });
  assert.equal(await restarted.recovery(), undefined);
  assert.ok(await f.read(path.join(f.home, '.ccw/operation.json')));
});

test('效果已生效但回执未保存：恢复先核查且不重写或重问已保存凭据', async t => {
  const secret = 'fixture-unsaved-credential-never-journaled';
  const f = await createEnv(t, { seed: { settings: { env: { ANTHROPIC_API_KEY: 'fixture-old-credential' } } } });
  const base = f.machine();
  const journal = path.join(f.home, '.ccw/operation.json');
  let rejectReceipt = true;
  const machine = {
    ...base,
    async replaceFile(file, data, expected, markExecutable) {
      if (
        file === journal &&
        rejectReceipt &&
        Object.values(JSON.parse(Buffer.from(data).toString()).record.facts).some(fact => fact.receipt)
      ) {
        rejectReceipt = false;
        throw new Error('fixture-result-save-failed');
      }
      return base.replaceFile(file, data, expected, markExecutable);
    },
  };
  const first = f.ccw(machine);
  const plan = await first.plan({
    task: 'install',
    selected: [{ id: 'settings', fields: { mode: 'api', baseUrl: 'https://gateway.example.test', secret } }],
  });
  const outcome = await first.apply(plan.id);
  assert.notEqual(outcome.state, 'done');
  assert.equal((await f.read(f.settingsFile)).env.ANTHROPIC_API_KEY, secret);
  const persisted = await fs.readFile(journal, 'utf8');
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes('fixture-old-credential'), false);
  const restarted = f.ccw(machine);
  const recovery = await restarted.recovery();
  assert.equal(recovery.items[0].state, 'done');
  assert.deepEqual(recovery.inputs, []);
  const remaining = await restarted.plan({ resume: recovery.id });
  assert.equal((await restarted.apply(remaining.id)).state, 'done');
  assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length, 1);
});

test('未完成任务拒绝另一种任务，放弃只清除记录', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English' } } });
  const ccw = f.ccw(f.machine());
  await ccw.plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
  await assert.rejects(ccw.plan({ task: 'detach', selected: [{ id: 'settings' }] }), /unfinished-operation/);
  const recovery = await ccw.recovery();
  await ccw.abandon(recovery.id);
  assert.equal(await ccw.recovery(), undefined);
  assert.equal((await f.read(f.settingsFile)).language, 'English');
  assert.equal(
    await fs.stat(path.join(f.home, '.ccw/operation.json')).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test('恢复仅接收缺失凭据，错误重输后仍可重新输入冻结凭据', async t => {
  const secret = 'fixture-frozen-secret';
  const f = await createEnv(t, { seed: { settings: { keep: true } } });
  const machine = f.machine();
  await f.ccw(machine).plan({
    task: 'install',
    selected: [{ id: 'settings', fields: { mode: 'api', baseUrl: 'https://gateway.example.test', secret } }],
  });
  const restarted = f.ccw(machine);
  let recovery = await restarted.recovery();
  assert.deepEqual(recovery.inputs, [{ operationId: 'settings/settings', itemId: 'settings', field: 'secret' }]);
  await assert.rejects(
    restarted.plan({ resume: recovery.id, inputs: { 'settings/settings': { baseUrl: 'https://other.example.test' } } }),
    /input-unavailable/,
  );
  const wrong = await restarted.plan({ resume: recovery.id, inputs: { 'settings/settings': { secret: 'wrong' } } });
  assert.equal((await restarted.apply(wrong.id)).state, 'failed');
  assert.deepEqual(await f.read(f.settingsFile), { keep: true });
  recovery = await restarted.recovery();
  assert.deepEqual(recovery.inputs, [{ operationId: 'settings/settings', itemId: 'settings', field: 'secret' }]);
  const correct = await restarted.plan({ resume: recovery.id, inputs: { 'settings/settings': { secret } } });
  assert.equal((await restarted.apply(correct.id)).state, 'done');
  assert.equal((await f.read(f.settingsFile)).env.ANTHROPIC_API_KEY, secret);
  assert.equal((await fs.readFile(path.join(f.home, '.ccw/operation.json'), 'utf8')).includes(secret), false);
});

test('最后一个操作改变已确认目标：最终验收暂停且不重复配置', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English' } } });
  const binary = path.join(f.home, '.local/bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  await f.write(binary, 'fixture-program');
  const machine = f.machine({
    npm: async () => ({ code: 0, failed: false, stdout: '{}' }),
    async execute(_file, args) {
      if (args[0] === 'auth' && args[1] === 'login') {
        const settings = await f.read(f.settingsFile);
        await f.json(f.settingsFile, { ...settings, language: 'external replacement' });
      }
      return { code: 0, failed: false, stdout: '{"loggedIn":true}' };
    },
  });
  const ccw = f.ccw(machine);
  const plan = await ccw.plan({
    task: 'install',
    selected: [{ id: 'settings', fields: { language: '中文', mode: 'official', login: 'yes' } }],
  });
  const result = await ccw.apply(plan.id);
  assert.notEqual(result.state, 'done');
  assert.ok(result.remaining);
  assert.ok(result.items[0].effects.some(effect => effect.code === 'target-changed'));
  assert.equal((await f.read(f.settingsFile)).language, 'external replacement');
  assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length, 1);
  // 外部回到原设置也不能把已确认完成的操作重新降为可派发。
  await f.json(f.settingsFile, { language: 'English' });
  const restarted = f.ccw(machine);
  const recovery = await restarted.recovery();
  const resumed = await restarted.plan({ resume: recovery.id });
  assert.notEqual((await restarted.apply(resumed.id)).state, 'done');
  assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length, 1);
});

test('派发记录写失败阻止目标修改，重建后必须再次确认', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English' } } });
  const base = f.machine();
  const journal = path.join(f.home, '.ccw/operation.json');
  let rejectDispatch = true;
  const machine = {
    ...base,
    async replaceFile(file, data, expected, markExecutable) {
      if (
        file === journal &&
        rejectDispatch &&
        Object.values(JSON.parse(Buffer.from(data).toString()).record.facts).some(fact => fact.status === 'issued')
      ) {
        rejectDispatch = false;
        throw new Error('fixture-dispatch-save-failed');
      }
      return base.replaceFile(file, data, expected, markExecutable);
    },
  };
  const ccw = f.ccw(machine);
  const plan = await ccw.plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
  const result = await ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.equal((await f.read(f.settingsFile)).language, 'English');
  assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length, 0);
  const restarted = f.ccw(machine);
  const recovery = await restarted.recovery();
  assert.equal((await f.read(f.settingsFile)).language, 'English');
  assert.equal((await restarted.apply(plan.id)).state, 'failed');
  const remaining = await restarted.plan({ resume: recovery.id });
  assert.equal((await restarted.apply(remaining.id)).state, 'done');
});

test('损坏记录阻止计划与修改，检查仍可读取用户设置', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English' } } });
  const machine = f.machine({ npm: async () => ({ code: 0, failed: false, stdout: '{}' }) });
  const ccw = f.ccw(machine);
  const plan = await ccw.plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
  const journal = path.join(f.home, '.ccw/operation.json');
  await f.write(journal, '{broken');
  await assert.rejects(ccw.recovery(), /operation-record-invalid/);
  await assert.rejects(ccw.plan({ task: 'install', selected: [{ id: 'settings' }] }), /operation-record-invalid/);
  assert.equal((await ccw.apply(plan.id)).state, 'failed');
  assert.equal((await f.read(f.settingsFile)).language, 'English');
  assert.equal((await ccw.inspect()).items.find(item => item.id === 'settings').values.language, 'English');
  assert.equal(await fs.readFile(journal, 'utf8'), '{broken');
});

test('恢复保留原目标根，改变配置目录时暂停', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English' } } });
  const machine = f.machine();
  await f.ccw(machine).plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
  const otherRoot = path.join(f.home, '.claude-other');
  await f.json(path.join(otherRoot, 'settings.json'), { language: 'other root' });
  const restarted = createCcw({
    machine,
    home: f.home,
    claudeRoot: otherRoot,
    cclineRoot: path.join(otherRoot, 'ccline'),
    platform: process.platform,
  });
  const recovery = await restarted.recovery();
  assert.equal(recovery.items[0].state, 'unknown');
  assert.equal(recovery.items[0].problem, 'operation-context-changed');
  const plan = await restarted.plan({ resume: recovery.id });
  assert.equal((await restarted.apply(plan.id)).state, 'failed');
  assert.equal((await f.read(f.settingsFile)).language, 'English');
  assert.equal((await f.read(path.join(otherRoot, 'settings.json'))).language, 'other root');
});

test('准备失败不阻断独立设置，放弃保留已成功结果', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English' } } });
  const machine = f.machine();
  const ccw = f.ccw(machine);
  const plan = await ccw.plan({
    task: 'install',
    selected: [{ id: 'settings', fields: { language: '中文' } }, { id: 'unknown' }],
  });
  const result = await ccw.apply(plan.id);
  assert.equal(result.state, 'partial');
  assert.equal((await f.read(f.settingsFile)).language, '中文');
  await assert.rejects(ccw.plan({ task: 'install', selected: [{ id: 'settings' }] }), /unfinished-operation/);
  await ccw.abandon(result.remaining);
  assert.equal((await f.read(f.settingsFile)).language, '中文');
  const next = await ccw.plan({ task: 'install', selected: [{ id: 'settings', fields: { language: 'English' } }] });
  assert.equal((await ccw.apply(next.id)).state, 'done');
});

test('提交瞬间冻结选择：读取任务记录期间的调用方修改不改变预览', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English' } } });
  const base = f.machine();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let gate = true;
  const machine = {
    ...base,
    async read(file) {
      if (gate && file === path.join(f.home, '.ccw/operation.json')) {
        gate = false;
        entered.resolve();
        await release.promise;
      }
      return base.read(file);
    },
  };
  const ccw = f.ccw(machine);
  const selected = [{ id: 'settings', fields: { language: '中文' } }];
  const preparing = ccw.plan({ task: 'install', selected });
  await entered.promise;
  selected[0].fields.language = 'external mutation';
  release.resolve();
  const plan = await preparing;
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  assert.equal((await f.read(f.settingsFile)).language, '中文');
});

test('重复选择在准备前拒绝，并撤回旧预览的执行许可', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English' } } });
  const ccw = f.ccw(f.machine());
  const old = await ccw.plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
  await assert.rejects(
    ccw.plan({ task: 'install', selected: [{ id: 'settings' }, { id: 'settings' }] }),
    /duplicate-selection/,
  );
  assert.equal((await ccw.apply(old.id)).state, 'failed');
  assert.equal((await f.read(f.settingsFile)).language, 'English');
});
