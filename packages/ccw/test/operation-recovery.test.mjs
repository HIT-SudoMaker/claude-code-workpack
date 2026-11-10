import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { createEnv } from './env.mjs';

test('重建实例发现冻结的设置计划，确认前不修改目标', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English', custom: { keep: true } } } });
  const machine = f.machine();
  const first = f.ccw(machine);
  const plan = await first.plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
  const restarted = f.ccw(machine);
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
