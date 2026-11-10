import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { runTerminal } from '../dist/terminal.js';
import { HOME_TITLE } from '../dist/render.js';
import { createEnv, npmWorld, ok, wait } from './env.mjs';

test('启动恢复先展示未执行工作，确认冻结预览后才写入', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English', keep: true } } });
  const machine = f.machine();
  await f.ccw(machine).plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
  let recovered = false;
  let confirmed = false;
  await runTerminal(f.ccw(machine), {
    wait,
    show() {},
    async choose(title, choices) {
      if (typeof title === 'string' && title.startsWith('未完成任务')) {
        assert.match(title, /未执行.*模型配置/);
        assert.deepEqual(choices, ['继续任务', '重新检查', '重新预览', '放弃任务', '退出']);
        assert.equal((await f.read(f.settingsFile)).language, 'English');
        recovered = true;
        return 0;
      }
      if (typeof title === 'string' && title.startsWith('变更预览')) {
        assert.equal(recovered, true);
        assert.match(title, /编辑 模型配置/);
        assert.ok(title.includes(f.settingsFile));
        assert.deepEqual(choices, ['确认安装', '返回修改']);
        assert.equal((await f.read(f.settingsFile)).language, 'English');
        confirmed = true;
        return 0;
      }
      if (title === HOME_TITLE) return 4;
      assert.equal(confirmed, true);
      assert.equal((await f.read(f.settingsFile)).language, '中文');
      return 1;
    },
  });
  assert.equal(confirmed, true);
  assert.equal((await f.read(f.settingsFile)).keep, true);
});

test('无效恢复记录显示可理解原因并阻止开始另一份任务', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English' } } });
  await f.write(`${f.home}/.ccw/operation.json`, '{broken');
  let blocked = false;
  await runTerminal(f.ccw(f.machine()), {
    wait,
    async choose(title, choices) {
      assert.match(title, /无法读取未完成任务/);
      assert.match(title, /任务记录无效/);
      assert.deepEqual(choices, ['重新检查', '退出']);
      blocked = true;
      return 1;
    },
  });
  assert.equal(blocked, true);
  assert.equal((await f.read(f.settingsFile)).language, 'English');
});

test('重新预览只解除接入的任务：保留原意图，不改成卸载程序', async t => {
  const f = await createEnv(t, { seed: { settings: { statusLine: { type: 'command', command: 'ccline' } } } });
  await f.write(path.join(f.cclineRoot, process.platform === 'win32' ? 'ccline.exe' : 'ccline'), 'fixture ccline');
  const machine = f.machine({
    npm: npmWorld({ package: '@cometix/ccline', npmRoot: path.join(f.root, 'npm/node_modules'), version: '2.0.1' }).npm,
    execute: async () => ok('ccline 2.0.1'),
  });
  await f.ccw(machine).plan({ task: 'detach', selected: [{ id: 'ccline' }] });
  let restored = false;
  const abort = new AbortController();
  await runTerminal(
    f.ccw(machine),
    {
      wait,
      async choose(title) {
        if (title.startsWith('未完成任务')) return 2;
        assert.match(title, /^重新预览/);
        return 0;
      },
      async select(page) {
        assert.equal(page.rows[0].checked, true);
        assert.match(page.rows[0].detail, /仅解除接入/);
        restored = true;
        abort.abort();
        return { kind: 'cancel', index: 0 };
      },
    },
    abort.signal,
  );
  assert.equal(restored, true);
});

test('恢复只补输缺失的凭据，确认前不写入，密钥不进入显示与任务记录', async t => {
  const secret = 'fixture-terminal-unsaved-secret';
  const f = await createEnv(t, { seed: { settings: { keep: true } } });
  const machine = f.machine();
  await f
    .ccw(machine)
    .plan({
      task: 'install',
      selected: [{ id: 'settings', fields: { mode: 'api', baseUrl: 'https://gateway.example.test', secret } }],
    });
  let forms = 0;
  let confirmed = false;
  const views = [];
  await runTerminal(f.ccw(machine), {
    wait,
    show(view) {
      views.push(view);
    },
    async form(title, fields, validate) {
      views.push({ title, fields });
      assert.equal(fields.length, 1);
      assert.equal(fields[0].label, '模型配置 · API Key');
      assert.equal(fields[0].secret, true);
      assert.equal(fields[0].value, '');
      assert.equal(validate({})?.field, fields[0].key);
      assert.equal(validate({ [fields[0].key]: secret }), null);
      forms++;
      return { [fields[0].key]: secret };
    },
    async choose(title) {
      views.push(title);
      if (typeof title === 'string' && title.startsWith('未完成任务')) return 0;
      if (typeof title === 'string' && title.startsWith('变更预览')) {
        assert.deepEqual(await f.read(f.settingsFile), { keep: true });
        confirmed = true;
        return 0;
      }
      if (title === HOME_TITLE) return 4;
      assert.equal(confirmed, true);
      assert.equal((await f.read(f.settingsFile)).env.ANTHROPIC_API_KEY, secret);
      return 1;
    },
  });
  assert.equal(forms, 1);
  assert.equal(JSON.stringify(views).includes(secret), false);
  assert.equal((await fs.readFile(path.join(f.home, '.ccw/operation.json'), 'utf8')).includes(secret), false);
});

test('未知结果可重新检查，退出前始终不执行变更', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English' } } });
  const machine = f.machine();
  await f.ccw(machine).plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
  await f.json(f.settingsFile, { language: 'external value' });
  let checks = 0;
  await runTerminal(f.ccw(machine), {
    wait,
    async choose(title) {
      assert.match(title, /^未完成任务/);
      assert.match(title, /待核对 · 模型配置/);
      assert.match(title, /目标已变化/);
      return checks++ ? 4 : 1;
    },
  });
  assert.equal(checks, 2);
  assert.equal((await f.read(f.settingsFile)).language, 'external value');
  assert.equal(
    f.calls.some(call => call.kind === 'editJson'),
    false,
  );
});

test('部分失败仍可确认独立工作，放弃任务保留已完成结果', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English' } } });
  const machine = f.machine();
  await f
    .ccw(machine)
    .plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }, { id: 'unknown' }] });
  let completed = false;
  const ccw = f.ccw(machine);
  await runTerminal(ccw, {
    wait,
    show() {},
    async choose(title) {
      if (typeof title === 'object') {
        assert.equal((await f.read(f.settingsFile)).language, '中文');
        assert.match(title.summary, /完成 1/);
        completed = true;
        return 1;
      }
      if (title.startsWith('未完成任务')) {
        if (completed) {
          assert.match(title, /已完成 · 模型配置/);
          assert.match(title, /未完成 · unknown/);
          return 3;
        }
        return 0;
      }
      if (title.startsWith('变更预览')) {
        assert.match(title, /模型配置/);
        assert.match(title, /unknown/);
        assert.equal((await f.read(f.settingsFile)).language, 'English');
        return 0;
      }
      if (title.startsWith('放弃任务')) {
        assert.match(title, /已完成的安装与设置会保留/);
        return 0;
      }
      assert.equal(title, HOME_TITLE);
      return 4;
    },
  });
  assert.equal(completed, true);
  assert.equal(await ccw.recovery(), undefined);
  assert.equal((await f.read(f.settingsFile)).language, '中文');
});

test('新计划记录保存失败：展示原因并保留编辑入口，不派发变更', async t => {
  const f = await createEnv(t, { seed: { settings: { language: 'English' } } });
  const base = f.machine({ npm: async () => ok('{}') });
  const machine = {
    ...base,
    async replaceFile(file, ...args) {
      if (file === path.join(f.home, '.ccw/operation.json')) throw new Error('fixture-journal-denied');
      return base.replaceFile(file, ...args);
    },
  };
  let homes = 0;
  let selections = 0;
  let explained = false;
  await runTerminal(f.ccw(machine), {
    wait,
    async choose(title, choices) {
      if (title === HOME_TITLE) return homes++ ? 4 : 0;
      if (title === '默认输出语言') return 0;
      if (title === '安装失败') {
        assert.deepEqual(choices, ['返回', '查看详情']);
        return explained ? 0 : 1;
      }
      assert.match(title, /任务记录/);
      assert.match(title, /读取或保存/);
      explained = true;
      return 0;
    },
    async select(page) {
      selections++;
      if (selections === 1) return { kind: 'open', index: page.rows.findIndex(row => row.label === '默认输出语言') };
      return { kind: selections === 2 ? 'submit' : 'cancel', index: page.rows.length };
    },
  });
  assert.equal(explained, true);
  assert.equal((await f.read(f.settingsFile)).language, 'English');
  assert.equal(
    f.calls.some(call => call.kind === 'editJson'),
    false,
  );
});
