import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { HOME_TITLE } from '../dist/render.js';
import { runTerminal } from '../dist/terminal.js';
import { attribution, createEnv, wait } from './env.mjs';

const defaultEnv = {
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_INSTALLATION_CHECKS: '1',
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
  CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

async function fixture(t, initial = {}) {
  const f = await createEnv(t, { layout: 'root', seed: { settings: initial } });
  const native = path.join(f.root, '.local/bin/claude.exe');
  await fs.mkdir(path.dirname(native), { recursive: true });
  await fs.writeFile(native, 'fixture');
  const loginCalls = [];
  const state = { failLogin: false };
  const machine = f.machine({
    locate: async command => (command === 'claude' ? [native] : []),
    npm: async args => ({
      code: 0,
      failed: false,
      stdout: args[0] === 'root' ? path.join(f.root, 'npm') : '{"dependencies":{}}',
    }),
    execute: async (_executable, args, options) => {
      if (args[0] === 'auth') {
        if (args[1] === 'login' && state.failLogin) return { code: 1, failed: false, stdout: '' };
        loginCalls.push({
          args,
          isInteractive: options?.isInteractive,
          settings: JSON.parse(await fs.readFile(f.settingsFile, 'utf8')),
        });
        return { code: 0, failed: false, stdout: '{"loggedIn":true}' };
      }
      return { code: 0, failed: false, stdout: '' };
    },
  });
  const core = f.ccw(machine, { platform: 'win32' });
  const ccw = {
    ...core,
    async inspect() {
      const view = await core.inspect();
      return { ...view, items: view.items.filter(item => item.id === 'settings') };
    },
  };
  return {
    ...f,
    machine,
    ccw,
    loginCalls,
    state,
    read: async () => JSON.parse(await fs.readFile(f.settingsFile, 'utf8')),
  };
}

test('重试官方登录：保留已保存配置', async t => {
  const f = await fixture(t, { env: { ANTHROPIC_API_KEY: 'fixture-old' } });
  f.state.failLogin = true;
  const plan = await f.ccw.plan({
    task: 'install',
    selected: [{ id: 'settings', fields: { mode: 'official', login: 'yes', language: 'English' } }],
  });
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  assert.equal((await f.read()).language, 'English');
  assert.equal((await f.read()).env.ANTHROPIC_API_KEY, undefined);
  // 只统计业务写入：最近执行日志（last-run.json）在每次 apply 后都会尽力写入，与本测试意图无关
  const business = call => call.kind === 'editJson' && call.target !== path.join(f.home, '.ccw', 'last-run.json');
  const writes = f.calls.filter(business).length;
  f.state.failLogin = false;
  const rest = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(rest.id)).state, 'done');
  assert.equal(f.calls.filter(business).length, writes);
});

const pick = (choices, label) => {
  const index = choices.findIndex(choice => choice === label || choice.startsWith(`${label}  `));
  assert.notEqual(index, -1, `缺少选项 ${label}`);
  return index;
};

for (const [condition, fields, problem] of [
  ['空配置', {}, 'api-fields-required'],
  ['缺少地址', { secret: 'fixture-key' }, 'base-url-required'],
  ['空白地址', { baseUrl: '   ', secret: 'fixture-key' }, 'base-url-required'],
  ['缺少密钥', { baseUrl: 'https://gateway.example.test' }, 'credential-required'],
  ['空白密钥', { baseUrl: 'https://gateway.example.test', secret: '   ' }, 'credential-required'],
  ['无效地址', { baseUrl: 'not-a-url', secret: 'fixture-key' }, 'invalid-base-url'],
])
  test(`校验 API 配置：拒绝${condition}`, async t => {
    const f = await fixture(t, { theme: 'keep' });
    const plan = await f.ccw.plan({
      task: 'install',
      selected: [{ id: 'settings', fields: { mode: 'api', ...fields } }],
    });
    assert.equal(plan.items[0].problem, problem);
    assert.equal((await f.ccw.apply(plan.id)).state, 'failed');
    assert.deepEqual(await f.read(), { theme: 'keep' });
  });

test('提交 API 草稿：校验通过后保存', async t => {
  const f = await fixture(t);
  let opened = false;
  let forms = 0;
  await runTerminal(f.ccw, {
    wait,
    show() {},
    handoff: work => work(),
    async select(page) {
      if (!opened) {
        opened = true;
        return { kind: 'open', index: 0 };
      }
      assert.equal(forms, 1);
      assert.equal(page.submitLabel, '开始安装（1 项）');
      assert.deepEqual(await f.read(), {});
      return { kind: 'submit', index: page.rows.length };
    },
    async choose(title) {
      if (typeof title !== 'string') return 1;
      if (title === HOME_TITLE) return opened ? 4 : 0;
      if (title === '模型配置') return 1;
      assert.fail('不应打开字段菜单：' + title);
    },
    async form(title, fields, validate) {
      forms++;
      assert.equal(title, '第三方 API');
      assert.equal(fields[1].secret, true);
      const values = Object.fromEntries(fields.map(field => [field.key, field.value]));
      assert.deepEqual(validate(values), {
        message: '请补全连接项',
        field: 'baseUrl',
        detail: '保存配置失败：缺少 Base URL 和 API Key\n代码：api-fields-required',
      });
      values.baseUrl = 'https://gateway.example.test';
      assert.deepEqual(validate(values), {
        message: '请填写密钥',
        field: 'secret',
        detail: '保存配置失败：缺少 API Key\n代码：credential-required',
      });
      values.secret = 'fixture-key';
      assert.equal(validate(values), null);
      return values;
    },
  });
  assert.equal((await f.read()).env.ANTHROPIC_API_KEY, 'fixture-key');
});

test('编辑 API 草稿：禁止回填凭据', async t => {
  const initial = { env: { ANTHROPIC_BASE_URL: 'https://existing.example.test', ANTHROPIC_API_KEY: 'existing-key' } };
  const f = await fixture(t, initial);
  let forms = 0;
  await runTerminal(f.ccw, {
    wait,
    show() {},
    async select(page) {
      assert.deepEqual(await f.read(), initial);
      return forms < 2 ? { kind: 'open', index: 0 } : { kind: 'submit', index: page.rows.length };
    },
    async choose(title) {
      if (typeof title !== 'string') return 1;
      if (title === HOME_TITLE) return forms ? 4 : 0;
      if (title === '模型配置') return 1;
      assert.fail(title);
    },
    async form(_title, fields, validate) {
      assert.deepEqual(
        fields.slice(0, 2).map(field => field.placeholder),
        ['必填', '必填'],
      );
      assert.equal(fields[1].secret, true);
      const values = Object.fromEntries(fields.map(field => [field.key, field.value]));
      if (forms++ === 0) {
        assert.equal(values.baseUrl, '');
        assert.equal(values.secret, '');
        assert.equal(validate(values).message, '请补全连接项');
        values.baseUrl = 'https://new.example.test';
        assert.equal(validate(values).message, '请填写密钥');
        values.secret = 'new-key';
        assert.equal(validate(values), null);
        return values;
      }
      assert.equal(values.baseUrl, 'https://new.example.test');
      assert.equal(values.secret, 'new-key');
      return null;
    },
  });
  assert.equal((await f.read()).env.ANTHROPIC_BASE_URL, 'https://new.example.test');
  assert.equal((await f.read()).env.ANTHROPIC_API_KEY, 'new-key');
});

test('修改模型：保留连接字段', async t => {
  const initial = { env: { ANTHROPIC_BASE_URL: 'https://existing.example.test', ANTHROPIC_API_KEY: 'existing-key' } };
  const f = await fixture(t, initial);
  const plan = await f.ccw.plan({
    task: 'install',
    selected: [{ id: 'settings', fields: { mode: 'api', model: 'custom-model' } }],
  });
  assert.equal(plan.items[0].problem, null);
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.deepEqual((await f.read()).env, {
    ...initial.env,
    ...defaultEnv,
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    ANTHROPIC_MODEL: 'custom-model',
  });
});

for (const preference of [
  { language: '中文', languageValue: 'Simplified Chinese', style: '解释型 · Explanatory', styleValue: 'Explanatory' },
  { language: '英文', languageValue: 'English', style: '简洁型 · Concise', styleValue: 'Concise' },
])
  test(`保存模型配置：${preference.language}偏好`, async t => {
    const f = await fixture(t, { theme: 'keep' });
    const screens = [];
    const values = [
      'https://gateway.example.test',
      'fixture-secret',
      'gateway-main[1m]',
      'gateway-fable',
      'gateway-opus[1m]',
      'gateway-sonnet',
      'gateway-haiku',
    ];
    const rows = ['模型配置', '默认输出语言', '输出风格'];
    let selects = 0;
    let forms = 0;
    await runTerminal(f.ccw, {
      wait,
      show(text) {
        screens.push(text);
      },
      handoff: work => work(),
      async select(page) {
        const choices = page.rows.map(row => row.label);
        for (const row of rows) pick(choices, row);
        if (selects < rows.length) return { kind: 'open', index: pick(choices, rows[selects++]) };
        assert.equal((await f.read()).env, undefined);
        assert.equal(page.submitLabel, '开始安装（1 项）');
        return { kind: 'submit', index: choices.length };
      },
      async choose(title, choices, defaultIndex) {
        screens.push(title, ...choices);
        if (typeof title !== 'string') return 1;
        if (title === HOME_TITLE) return selects ? 4 : 0;
        if (title === '模型配置') {
          assert.deepEqual(choices, ['官方登录', '第三方 API', '返回']);
          return 1;
        }
        if (title === '默认输出语言') {
          assert.equal(defaultIndex, 0);
          assert.deepEqual(choices, ['中文', '英文', '返回']);
          return pick(choices, preference.language);
        }
        if (title === '输出风格') {
          assert.equal(defaultIndex, 3);
          assert.deepEqual(choices, [
            '默认型 · Default',
            '主动型 · Proactive',
            '简洁型 · Concise',
            '解释型 · Explanatory',
            '学习型 · Learning',
            '返回',
          ]);
          return pick(choices, preference.style);
        }
        assert.fail(`不应多一层菜单：${title}`);
      },
      async form(title, fields, validate) {
        forms++;
        screens.push(title);
        assert.deepEqual(
          fields.map(field => field.label),
          ['Base URL', 'API Key', 'Default Model', 'Fable', 'Opus', 'Sonnet', 'Haiku'],
        );
        assert.deepEqual(
          fields.slice(2).map(field => field.placeholder),
          Array(5).fill('选填，可添加 [1m]'),
        );
        assert.equal(fields[1].secret, true);
        const result = Object.fromEntries(fields.map((field, index) => [field.key, values[index]]));
        assert.equal(validate(result), null);
        return result;
      },
    });
    assert.equal(forms, 1);
    assert.equal(screens.join('\n').includes('fixture-secret'), false);
    assert.deepEqual(await f.read(), {
      theme: 'keep',
      permissions: { defaultMode: 'bypassPermissions' },
      language: preference.languageValue,
      outputStyle: preference.styleValue,
      attribution,
      env: {
        ...defaultEnv,
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        ANTHROPIC_BASE_URL: values[0],
        ANTHROPIC_API_KEY: values[1],
        ANTHROPIC_MODEL: values[2],
        ANTHROPIC_DEFAULT_FABLE_MODEL: values[3],
        ANTHROPIC_DEFAULT_OPUS_MODEL: values[4],
        ANTHROPIC_DEFAULT_SONNET_MODEL: values[5],
        ANTHROPIC_DEFAULT_HAIKU_MODEL: values[6],
      },
    });
  });

test('登录官方账号：清除第三方连接', async t => {
  const f = await fixture(t, {
    env: {
      ANTHROPIC_API_KEY: 'stored-secret',
      ANTHROPIC_BASE_URL: 'https://old.example.test',
      ANTHROPIC_MODEL: 'old-model',
      KEEP: 'yes',
    },
    language: 'English',
    outputStyle: 'Learning',
  });
  let opened = false;
  let inHandoff = false;
  await runTerminal(f.ccw, {
    wait,
    show() {},
    async handoff(work) {
      inHandoff = true;
      const result = await work();
      inHandoff = false;
      return result;
    },
    async select(page) {
      const choices = page.rows.map(row => row.label);
      if (!opened) {
        opened = true;
        return { kind: 'open', index: pick(choices, '模型配置') };
      }
      assert.equal(f.loginCalls.length, 0);
      assert.equal((await f.read()).env.ANTHROPIC_API_KEY, 'stored-secret');
      return { kind: 'submit', index: choices.length };
    },
    async choose(title, choices) {
      assert.equal(inHandoff, false);
      assert.equal(`${title}${choices}`.includes('stored-secret'), false);
      if (typeof title !== 'string') return 1;
      if (title === HOME_TITLE) return opened ? 4 : 0;
      if (title === '模型配置') return pick(choices, '官方登录');
      assert.fail(`不应多一层菜单：${title}`);
    },
  });
  assert.deepEqual(
    f.loginCalls.filter(call => call.args[1] === 'login').map(call => call.args),
    [['auth', 'login']],
  );
  assert.ok(f.loginCalls.some(call => call.args[1] === 'status'));
  assert.equal(f.loginCalls[0].isInteractive, true);
  assert.deepEqual(f.loginCalls[0].settings.env, { KEEP: 'yes', ...defaultEnv });
  assert.deepEqual(await f.read(), {
    permissions: { defaultMode: 'bypassPermissions' },
    env: { KEEP: 'yes', ...defaultEnv },
    attribution,
    language: 'English',
    outputStyle: 'Learning',
  });
});

test('取消 API 编辑：保留语言草稿', async t => {
  const initial = {
    env: {
      ANTHROPIC_AUTH_TOKEN: 'stored-secret',
      ANTHROPIC_BASE_URL: 'https://existing.example.test',
      ANTHROPIC_MODEL: 'custom[1m]',
    },
    outputStyle: 'Custom Style',
  };
  const f = await fixture(t, initial);
  let selects = 0;
  await runTerminal(f.ccw, {
    wait,
    show() {},
    handoff: work => work(),
    async form() {
      return null;
    },
    async select(page) {
      const choices = page.rows.map(row => row.label);
      const selected = page.rows.flatMap((row, index) => (row.checked ? [index] : []));
      if (selects++ === 0) return { kind: 'open', index: pick(choices, '默认输出语言') };
      assert.deepEqual(selected, [pick(choices, '默认输出语言')]);
      return selects === 2
        ? { kind: 'open', index: pick(choices, '模型配置') }
        : { kind: 'submit', index: choices.length };
    },
    async choose(title, choices) {
      if (typeof title !== 'string') return 1;
      if (title === HOME_TITLE) return selects ? 4 : 0;
      if (title === '默认输出语言') return pick(choices, '中文');
      if (title === '模型配置') return pick(choices, '第三方 API');
      assert.fail(`不应多一层菜单：${title}`);
    },
  });
  assert.deepEqual(await f.read(), {
    ...initial,
    permissions: { defaultMode: 'bypassPermissions' },
    env: { ...initial.env, ...defaultEnv, CLAUDE_CODE_ATTRIBUTION_HEADER: '0' },
    attribution,
    language: 'Simplified Chinese',
  });
});
