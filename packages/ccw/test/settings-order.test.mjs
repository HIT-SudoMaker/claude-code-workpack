import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createCcw } from '../dist/ccw.js';
import { createMachine } from '../dist/machine.js';
import { createEnv, fail, ok, pluginMarketplaceFiles, revision } from './env.mjs';

async function fixture(t, { before = {}, platform = 'win32', inheritedKeys = [], hasProgram = false } = {}) {
  const f = await createEnv(t, { layout: 'root', seed: { settings: before } });
  const base = createMachine({}, f.root);
  const binary = path.join(f.home, '.local/bin', platform === 'win32' ? 'claude.exe' : 'claude');
  if (hasProgram) await f.write(binary, 'fixture program');
  const state = {
    writes: 0,
    failReadback: false,
    rejectAfterWrite: false,
    loginFailures: 0,
    loginCalls: 0,
  };
  const machine = f.machine({
    npm: async () => ok('{}'),
    read: async (file, adapter) => {
      if (file === f.settingsFile && state.writes && state.failReadback) {
        state.failReadback = false;
        throw new Error('fixture-read-failed');
      }
      return adapter.read(file);
    },
    editJson: async (file, edit) => {
      await base.editJson(file, edit);
      if (file === f.settingsFile) {
        state.writes++;
        if (state.rejectAfterWrite) throw new Error('fixture-cleanup-failed');
      }
    },
    execute: async (file, args) => {
      if (file === binary && args[0] === 'auth') {
        if (args[1] === 'login') {
          state.loginCalls++;
          if (state.loginFailures > 0) {
            state.loginFailures--;
            return fail();
          }
          return ok();
        }
        if (args[1] === 'status') return ok('{"loggedIn":true}');
      }
      return fail();
    },
  });
  const ccw = createCcw({
    machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform,
    inheritedKeys,
  });
  const prepare = async (fields = {}, task = 'install', maintenance) => {
    const plan = await ccw.plan({
      task,
      selected: [{ id: 'settings', fields, ...(maintenance ? { maintenance } : {}) }],
    });
    assert.equal(plan.items[0].problem, null, JSON.stringify(plan));
    return plan;
  };
  const apply = async (fields = {}, task = 'install') => ccw.apply((await prepare(fields, task)).id);
  const contents = () => fs.readFile(f.settingsFile, 'utf8');
  return { ...f, ccw, state, prepare, apply, contents };
}

test('保存 API 配置：按平台和模型顺序写入', async t => {
  const f = await fixture(t);
  const before = await f.contents();
  await f.ccw.inspect();
  const plan = await f.prepare({
    mode: 'api',
    baseUrl: ' https://gateway.example.test ',
    secret: ' fixture-key-A ',
    model: ' fixture-main ',
    fable: 'fixture-fable',
    opus: 'fixture-opus',
    sonnet: 'fixture-sonnet',
    haiku: 'fixture-haiku',
    language: 'Simplified Chinese',
    outputStyle: 'Explanatory',
  });
  assert.equal(await f.contents(), before);
  assert.equal(f.state.writes, 0);
  assert.equal(JSON.stringify(plan).includes('fixture-key-A'), false);
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'done');
  assert.equal(JSON.stringify(result).includes('fixture-key-A'), false);
  assert.equal(f.state.writes, 1);
  const after = await f.read(f.settingsFile);
  assert.deepEqual(after, {
    permissions: { defaultMode: 'bypassPermissions' },
    attribution: { commit: '', pr: '', sessionUrl: false },
    language: 'Simplified Chinese',
    outputStyle: 'Explanatory',
    env: {
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_INSTALLATION_CHECKS: '1',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      ANTHROPIC_API_KEY: 'fixture-key-A',
      ANTHROPIC_MODEL: 'fixture-main',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'fixture-fable',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'fixture-opus',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-haiku',
    },
  });
  assert.deepEqual(Object.keys(after), ['permissions', 'attribution', 'language', 'outputStyle', 'env']);
  assert.deepEqual(Object.keys(after.env), [
    'DISABLE_TELEMETRY',
    'DISABLE_ERROR_REPORTING',
    'DISABLE_INSTALLATION_CHECKS',
    'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
    'CLAUDE_CODE_USE_POWERSHELL_TOOL',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CODE_ATTRIBUTION_HEADER',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ]);
  assert.equal(await f.contents(), `${JSON.stringify(after, null, 2)}\n`);
});

test('重复保存配置：输出字节保持一致', async t => {
  const f = await fixture(t, {
    before: { USER_B: { z: 1, a: 2 }, model: 'fixture-root', USER_A: [2, 1] },
  });
  const fields = { mode: 'api', baseUrl: 'https://gateway.example.test', secret: 'fixture-key', model: 'fixture-main' };
  assert.equal((await f.apply(fields)).state, 'done');
  const first = await f.contents();
  assert.equal((await f.apply(fields)).state, 'done');
  assert.equal(await f.contents(), first);
  assert.equal(f.state.writes, 1);
});

for (const { platform, baseUrl, header } of [
  { platform: 'win32', baseUrl: undefined, header: false },
  { platform: 'linux', baseUrl: 'https://api.anthropic.com', header: false },
  { platform: 'darwin', baseUrl: 'https://gateway.example.test', header: true },
  { platform: 'linux', baseUrl: 'https://API.ANTHROPIC.COM:443/path', header: false },
  { platform: 'linux', baseUrl: 'not a URL', header: false },
  { platform: 'darwin', baseUrl: 'https://user:fixture-secret@gateway.example.test', header: false },
  { platform: 'linux', baseUrl: 'https://gateway.example.test?key=fixture-secret', header: false },
])
  test(`补齐默认配置：${platform} ${baseUrl ?? '无地址'}`, async t => {
    const f = await fixture(t, {
      platform,
      before: { env: baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: baseUrl } },
    });
    assert.equal((await f.apply()).state, 'done');
    const after = await f.read(f.settingsFile);
    assert.deepEqual(after, {
      permissions: { defaultMode: 'bypassPermissions' },
      attribution: { commit: '', pr: '', sessionUrl: false },
      env: {
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_INSTALLATION_CHECKS: '1',
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
        ...(platform === 'win32' ? { CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' } : {}),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ...(header ? { CLAUDE_CODE_ATTRIBUTION_HEADER: '0' } : {}),
        ...(baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: baseUrl }),
      },
    });
  });

test('整理已有配置：保留未知值和嵌套顺序', async t => {
  const before = {
    USER_TOP_B: { z: 0, a: [{ z: 2, a: 1 }, false, 0, ''] },
    model: 'fixture-root-model',
    env: {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-haiku',
      ANTHROPIC_MODEL: 'fixture-main',
      USER_ENV_Z: { z: 2, a: 1 },
      ANTHROPIC_AUTH_TOKEN: 'fixture-token',
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '0',
      DISABLE_TELEMETRY: '',
      USER_ENV_A: [3, 1, 2],
      CLAUDE_CODE_ATTRIBUTION_HEADER: null,
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: 0,
      DISABLE_ERROR_REPORTING: false,
      DISABLE_INSTALLATION_CHECKS: 'fixture-user-value',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      ANTHROPIC_API_KEY: 'fixture-key',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Fixture: custom',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-sonnet',
      ANTHROPIC_DEFAULT_MODEL: 'fixture-fallback',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'fixture-opus',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'fixture-fable',
    },
    autoCompactWindow: null,
    apiKeyHelper: 'fixture-helper',
    permissions: { deny: ['fixture:z', 'fixture:a'], allow: ['fixture:b', 'fixture:a'] },
    USER_TOP_A: [{ z: 'keep', a: 'keep' }, false, 0, ''],
    enabledPlugins: { 'fixture-b@fixture': false, 'fixture-a@fixture': true },
    statusLine: { padding: 0, command: 'fixture-status', type: 'command' },
    outputStyle: 'Concise',
    attribution: { sessionUrl: false, pr: 'fixture-pr', commit: '' },
    language: 'English',
    defaultShell: 'fixture-shell',
    includeCoAuthoredBy: false,
    autoCompactEnabled: false,
    $schema: 'https://example.test/fixture-schema',
  };
  const f = await fixture(t, { before });
  assert.equal((await f.apply({ language: 'English' })).state, 'done');
  const after = await f.read(f.settingsFile);
  assert.deepEqual(after, {
    ...before,
    permissions: { ...before.permissions, defaultMode: 'bypassPermissions' },
    env: { ...before.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  });
  assert.deepEqual(Object.keys(after), [
    '$schema',
    'defaultShell',
    'permissions',
    'includeCoAuthoredBy',
    'attribution',
    'language',
    'outputStyle',
    'statusLine',
    'enabledPlugins',
    'autoCompactEnabled',
    'autoCompactWindow',
    'USER_TOP_B',
    'USER_TOP_A',
    'apiKeyHelper',
    'env',
    'model',
  ]);
  assert.deepEqual(Object.keys(after.env), [
    'DISABLE_TELEMETRY',
    'DISABLE_ERROR_REPORTING',
    'DISABLE_INSTALLATION_CHECKS',
    'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
    'CLAUDE_CODE_USE_POWERSHELL_TOOL',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CODE_ATTRIBUTION_HEADER',
    'USER_ENV_Z',
    'USER_ENV_A',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ]);
  assert.equal(JSON.stringify(after.USER_TOP_B), '{"z":0,"a":[{"z":2,"a":1},false,0,""]}');
  assert.equal(
    JSON.stringify(after.permissions),
    '{"deny":["fixture:z","fixture:a"],"allow":["fixture:b","fixture:a"],"defaultMode":"bypassPermissions"}',
  );
  assert.equal(JSON.stringify(after.statusLine), '{"padding":0,"command":"fixture-status","type":"command"}');
  assert.equal(JSON.stringify(after.enabledPlugins), '{"fixture-b@fixture":false,"fixture-a@fixture":true}');
  assert.equal(JSON.stringify(after.attribution), '{"sessionUrl":false,"pr":"fixture-pr","commit":""}');
});

test('整理自身属性：保留原型同名键', async t => {
  const before = JSON.parse(
    '{"__proto__":{"z":2,"a":1},"model":"fixture-root","env":{"__proto__":{"z":3,"a":1},"constructor":[3,1],"ANTHROPIC_MODEL":"fixture-main","toString":false},"constructor":null}',
  );
  const f = await fixture(t, { before });
  assert.equal((await f.apply()).state, 'done');
  const after = await f.read(f.settingsFile);
  assert.equal(Object.getPrototypeOf(after), Object.prototype);
  assert.equal(Object.getPrototypeOf(after.env), Object.prototype);
  assert.equal(Object.hasOwn(after, '__proto__'), true);
  assert.equal(Object.hasOwn(after.env, '__proto__'), true);
  assert.deepEqual(after.__proto__, { z: 2, a: 1 });
  assert.deepEqual(after.env.__proto__, { z: 3, a: 1 });
  assert.equal(after.constructor, null);
  assert.deepEqual(after.env.constructor, [3, 1]);
  assert.equal(after.env.toString, false);
  assert.deepEqual(Object.keys(after), ['permissions', 'attribution', '__proto__', 'constructor', 'env', 'model']);
  assert.deepEqual(Object.keys(after.env), [
    'DISABLE_TELEMETRY',
    'DISABLE_ERROR_REPORTING',
    'DISABLE_INSTALLATION_CHECKS',
    'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
    'CLAUDE_CODE_USE_POWERSHELL_TOOL',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    '__proto__',
    'constructor',
    'toString',
    'ANTHROPIC_MODEL',
  ]);
});

test('补齐默认配置：跳过继承名称', async t => {
  const f = await fixture(t, {
    inheritedKeys: ['DISABLE_TELEMETRY', 'CLAUDE_CODE_USE_POWERSHELL_TOOL', 'CLAUDE_CODE_ATTRIBUTION_HEADER'],
    before: {
      env: { ANTHROPIC_BASE_URL: 'https://gateway.example.test', ANTHROPIC_API_KEY: 'fixture-key' },
      includeCoAuthoredBy: true,
    },
  });
  assert.equal((await f.apply({ language: 'English' })).state, 'done');
  assert.deepEqual(await f.read(f.settingsFile), {
    includeCoAuthoredBy: true,
    permissions: { defaultMode: 'bypassPermissions' },
    language: 'English',
    env: {
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_INSTALLATION_CHECKS: '1',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      ANTHROPIC_API_KEY: 'fixture-key',
    },
  });
});

for (const attribution of [null, false, 0, '', { pr: 'fixture-pr' }])
  test(`保留 attribution：${JSON.stringify(attribution)}`, async t => {
    const f = await fixture(t, { before: { attribution } });
    assert.equal((await f.apply()).state, 'done');
    assert.deepEqual((await f.read(f.settingsFile)).attribution, attribution);
  });

test('删除编辑字段：保留 root model 和 helper', async t => {
  const f = await fixture(t, {
    before: {
      model: 'fixture-root-keep',
      outputStyle: 'Learning',
      language: 'English',
      apiKeyHelper: 'fixture-helper',
      env: {
        USER_ENV_B: 'keep',
        ANTHROPIC_MODEL: 'fixture-main-delete',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-sonnet-delete',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'fixture-fable-keep',
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60',
      },
    },
  });
  assert.equal((await f.apply({ model: '   ', sonnet: '', language: '', outputStyle: '' })).state, 'done');
  const after = await f.read(f.settingsFile);
  assert.deepEqual(after, {
    permissions: { defaultMode: 'bypassPermissions' },
    attribution: { commit: '', pr: '', sessionUrl: false },
    apiKeyHelper: 'fixture-helper',
    env: {
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_INSTALLATION_CHECKS: '1',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60',
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      USER_ENV_B: 'keep',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'fixture-fable-keep',
    },
    model: 'fixture-root-keep',
  });
  assert.deepEqual(Object.keys(after), ['permissions', 'attribution', 'apiKeyHelper', 'env', 'model']);
});

for (const { token, expected } of [
  { token: 'fixture-token', expected: 'token' },
  { token: '', expected: 'key' },
  { token: null, expected: 'key' },
])
  test(`读取本地认证提示：${JSON.stringify(token)}`, async t => {
    const f = await fixture(t, {
      before: {
        model: 'fixture-root-hidden',
        apiKeyHelper: 'fixture-helper-hidden',
        env: { ANTHROPIC_API_KEY: 'fixture-key-hidden', ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: 'fixture-env' },
      },
    });
    const before = await f.contents();
    const view = await f.ccw.inspect();
    const item = view.items.find(item => item.id === 'settings');
    assert.deepEqual(item.values, { auth: expected, model: 'fixture-env' });
    for (const hidden of ['fixture-root-hidden', 'fixture-helper-hidden', 'fixture-key-hidden', 'fixture-token'])
      assert.equal(JSON.stringify(view).includes(hidden), false);
    assert.equal(await f.contents(), before);
    assert.equal(f.state.writes, 0);
  });

for (const { auth, secret, expected } of [
  { auth: 'token', secret: ' fixture-new-token ', expected: { ANTHROPIC_AUTH_TOKEN: 'fixture-new-token' } },
  { auth: 'key', secret: ' fixture-new-key ', expected: { ANTHROPIC_API_KEY: 'fixture-new-key' } },
  { auth: 'token', secret: '', expected: { ANTHROPIC_AUTH_TOKEN: ' fixture-old-token ' } },
  { auth: 'key', secret: undefined, expected: { ANTHROPIC_API_KEY: ' fixture-old-key ' } },
])
  test(`选择 API 凭据：${auth} ${secret?.trim() || '保留'}`, async t => {
    const f = await fixture(t, {
      before: {
        model: 'fixture-root-keep',
        apiKeyHelper: 'fixture-helper',
        env: {
          ANTHROPIC_BASE_URL: 'https://gateway.example.test',
          ANTHROPIC_API_KEY: ' fixture-old-key ',
          ANTHROPIC_AUTH_TOKEN: ' fixture-old-token ',
        },
      },
    });
    assert.equal((await f.apply({ mode: 'api', auth, ...(secret !== undefined ? { secret } : {}) })).state, 'done');
    const after = await f.read(f.settingsFile);
    assert.deepEqual(after, {
      permissions: { defaultMode: 'bypassPermissions' },
      attribution: { commit: '', pr: '', sessionUrl: false },
      env: {
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_INSTALLATION_CHECKS: '1',
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
        CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        ANTHROPIC_BASE_URL: 'https://gateway.example.test',
        ...expected,
      },
      model: 'fixture-root-keep',
    });
  });

for (const task of ['detach', 'install'])
  test(`清理本地连接：${task === 'detach' ? '解除' : '官方模式'}`, async t => {
    const f = await fixture(t, {
      before: {
        model: 'fixture-root-keep',
        apiKeyHelper: 'fixture-helper',
        language: 'English',
        permissions: { allow: ['fixture:b', 'fixture:a'] },
        env: {
          ANTHROPIC_BASE_URL: 'https://gateway.example.test',
          ANTHROPIC_API_KEY: 'fixture-key',
          ANTHROPIC_AUTH_TOKEN: 'fixture-token',
          ANTHROPIC_MODEL: 'fixture-main',
          ANTHROPIC_DEFAULT_FABLE_MODEL: 'fixture-fable',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'fixture-opus',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-sonnet',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-haiku',
          USER_ENV_B: 'keep-b',
          CLAUDE_CODE_USE_BEDROCK: '1',
          USER_ENV_A: 'keep-a',
          ANTHROPIC_CUSTOM_HEADERS: 'X-Fixture: demo',
          ANTHROPIC_DEFAULT_MODEL: 'fixture-fallback',
          DISABLE_INSTALLATION_CHECKS: '0',
          CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70',
          CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        },
      },
    });
    assert.equal((await f.apply(task === 'install' ? { mode: 'official' } : {}, task)).state, 'done');
    const after = await f.read(f.settingsFile);
    assert.deepEqual(after, {
      permissions:
        task === 'install'
          ? { allow: ['fixture:b', 'fixture:a'], defaultMode: 'bypassPermissions' }
          : { allow: ['fixture:b', 'fixture:a'] },
      ...(task === 'install' ? { attribution: { commit: '', pr: '', sessionUrl: false } } : {}),
      language: 'English',
      env: {
        ...(task === 'install'
          ? {
              DISABLE_TELEMETRY: '1',
              DISABLE_ERROR_REPORTING: '1',
              CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            }
          : {}),
        DISABLE_INSTALLATION_CHECKS: '0',
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70',
        USER_ENV_B: 'keep-b',
        CLAUDE_CODE_USE_BEDROCK: '1',
        USER_ENV_A: 'keep-a',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        ANTHROPIC_CUSTOM_HEADERS: 'X-Fixture: demo',
        ANTHROPIC_DEFAULT_MODEL: 'fixture-fallback',
      },
      model: 'fixture-root-keep',
    });
    assert.deepEqual(
      Object.keys(after.env),
      task === 'install'
        ? [
            'DISABLE_TELEMETRY',
            'DISABLE_ERROR_REPORTING',
            'DISABLE_INSTALLATION_CHECKS',
            'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
            'CLAUDE_CODE_USE_POWERSHELL_TOOL',
            'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
            'CLAUDE_CODE_ATTRIBUTION_HEADER',
            'USER_ENV_B',
            'CLAUDE_CODE_USE_BEDROCK',
            'USER_ENV_A',
            'ANTHROPIC_CUSTOM_HEADERS',
            'ANTHROPIC_DEFAULT_MODEL',
          ]
        : [
            'DISABLE_INSTALLATION_CHECKS',
            'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
            'CLAUDE_CODE_ATTRIBUTION_HEADER',
            'USER_ENV_B',
            'CLAUDE_CODE_USE_BEDROCK',
            'USER_ENV_A',
            'ANTHROPIC_CUSTOM_HEADERS',
            'ANTHROPIC_DEFAULT_MODEL',
          ],
    );
  });

test('解除 helper：保留空 env 容器', async t => {
  const f = await fixture(t, { before: { apiKeyHelper: 'fixture-helper' } });
  assert.equal((await f.apply({}, 'detach')).state, 'done');
  assert.deepEqual(await f.read(f.settingsFile), { env: {} });
});

test('处理模式后模型字段：保留显式写入次序', async t => {
  const f = await fixture(t, { before: { env: { ANTHROPIC_MODEL: 'fixture-old' } } });
  assert.equal((await f.apply({ mode: 'official', model: ' fixture-explicit ' })).state, 'done');
  assert.equal((await f.read(f.settingsFile)).env.ANTHROPIC_MODEL, 'fixture-explicit');
});

for (const fields of [{ model: 'fixture-new' }, { model: '' }, { mode: 'official' }])
  test(`拒绝继承字段冲突：${JSON.stringify(fields)}`, async t => {
    const f = await fixture(t, { inheritedKeys: ['ANTHROPIC_MODEL'] });
    const before = await f.contents();
    const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'settings', fields }] });
    assert.equal(plan.items[0].problem, 'inherited-configuration-conflict');
    assert.equal((await f.ccw.apply(plan.id)).state, 'failed');
    assert.equal(f.state.writes, 0);
    assert.equal(await f.contents(), before);
  });

test('拒绝目标漂移：不写入排序和默认值', async t => {
  const f = await fixture(t, { before: { env: { ANTHROPIC_MODEL: 'fixture-old', USER_A: 'keep' } } });
  const plan = await f.prepare({ model: 'fixture-requested' });
  await f.json(f.settingsFile, { env: { ANTHROPIC_MODEL: 'fixture-external', USER_A: 'keep' } });
  const before = await f.contents();
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.items[0].effects.at(-1).code, 'target-changed');
  assert.equal(f.state.writes, 0);
  assert.equal(await f.contents(), before);
});

test('拒绝 helper 漂移：保护新增调用入口', async t => {
  const f = await fixture(t);
  const plan = await f.prepare({ mode: 'official' });
  await f.json(f.settingsFile, { apiKeyHelper: 'fixture-new-helper' });
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.items[0].effects.at(-1).code, 'target-changed');
  assert.deepEqual(await f.read(f.settingsFile), { apiKeyHelper: 'fixture-new-helper' });
  assert.equal(f.state.writes, 0);
});

test('合并并发未知字段：保留新默认偏好', async t => {
  const f = await fixture(t);
  const plan = await f.prepare({ model: 'fixture-main' });
  await f.json(f.settingsFile, {
    USER_NEW: { z: 0, a: 1 },
    includeCoAuthoredBy: true,
    env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60', USER_NEW: [2, 1] },
  });
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.deepEqual(await f.read(f.settingsFile), {
    permissions: { defaultMode: 'bypassPermissions' },
    includeCoAuthoredBy: true,
    USER_NEW: { z: 0, a: 1 },
    env: {
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_INSTALLATION_CHECKS: '1',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60',
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      USER_NEW: [2, 1],
      ANTHROPIC_MODEL: 'fixture-main',
    },
  });
});

test('继续保存后确认：保留排序且不重复写入', async t => {
  const f = await fixture(t, { before: { model: 'fixture-root', USER_B: 'keep' } });
  const plan = await f.prepare({ mode: 'api', baseUrl: 'https://gateway.example.test', secret: 'fixture-key' });
  f.state.failReadback = true;
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  assert.equal(first.items[0].effects[0].code, 'settings-saved');
  assert.equal(first.items[0].effects.at(-1).code, 'fixture-read-failed');
  const saved = await f.contents();
  assert.deepEqual(Object.keys(JSON.parse(saved)), ['permissions', 'attribution', 'USER_B', 'env', 'model']);
  await f.json(f.settingsFile, { ...JSON.parse(saved), USER_LATER: ['keep'] });
  const later = await f.contents();
  const resumed = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(resumed.id)).state, 'done');
  assert.equal(f.state.writes, 1);
  assert.equal(await f.contents(), later);
});

test('继续保存后确认：拒绝已保存目标漂移', async t => {
  const f = await fixture(t);
  const plan = await f.prepare({ model: 'fixture-requested' });
  f.state.failReadback = true;
  const first = await f.ccw.apply(plan.id);
  assert.ok(first.remaining);
  const changed = await f.read(f.settingsFile);
  changed.env.ANTHROPIC_MODEL = 'fixture-later';
  await f.json(f.settingsFile, changed);
  const later = await f.contents();
  const resumed = await f.ccw.plan({ resume: first.remaining });
  const result = await f.ccw.apply(resumed.id);
  assert.equal(result.state, 'partial');
  assert.equal(result.items[0].effects.at(-1).code, 'target-changed');
  assert.equal(f.state.writes, 1);
  assert.equal(await f.contents(), later);
});

test('继续官方登录：保留已保存配置', async t => {
  const f = await fixture(t, { hasProgram: true, before: { env: { ANTHROPIC_API_KEY: 'fixture-key' } } });
  const plan = await f.prepare({ mode: 'official', login: 'yes' });
  f.state.loginFailures = 1;
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  assert.deepEqual(
    first.items[0].effects.map(effect => effect.code),
    ['settings-saved', 'login-failed'],
  );
  const saved = await f.contents();
  const resumed = await f.ccw.plan({ resume: first.remaining });
  const result = await f.ccw.apply(resumed.id);
  assert.equal(result.state, 'done');
  assert.deepEqual(
    result.items[0].effects.map(effect => effect.code),
    ['settings-saved', 'logged-in'],
  );
  assert.equal(f.state.writes, 1);
  assert.equal(f.state.loginCalls, 2);
  assert.equal(await f.contents(), saved);
});

test('单独登录：保留配置字节', async t => {
  const f = await fixture(t, {
    hasProgram: true,
    before: { model: 'fixture-root', USER_A: true, language: 'English' },
  });
  const before = await f.contents();
  const plan = await f.prepare({}, 'install', 'login');
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.loginCalls, 1);
  assert.equal(await f.contents(), before);
});

test('适配器写后拒绝：核查已生效配置后继续登录', async t => {
  const f = await fixture(t, {
    hasProgram: true,
    before: { env: { ANTHROPIC_API_KEY: 'fixture-key' }, apiKeyHelper: 'fixture-helper' },
  });
  const plan = await f.prepare({ mode: 'official', login: 'yes' });
  f.state.rejectAfterWrite = true;
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'done');
  assert.equal(first.remaining, undefined);
  assert.deepEqual(
    first.items[0].effects.map(effect => effect.code),
    ['settings-saved', 'logged-in'],
  );
  assert.equal(f.state.writes, 1);
  const committed = await f.read(f.settingsFile);
  assert.equal(committed.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(committed.apiKeyHelper, undefined);
  await f.json(f.settingsFile, { ...committed, USER_LATER: { keep: true } });
  const later = await f.contents();
  f.state.rejectAfterWrite = false;
  const result = await f.apply({ mode: 'official' });
  assert.equal(result.state, 'done');
  assert.equal(f.state.writes, 1);
  assert.equal(f.state.loginCalls, 1);
  assert.equal(await f.contents(), later);
});

test('保存默认配置：保留显式设置', async t => {
  const f = await fixture(t, { platform: 'linux', inheritedKeys: ['DISABLE_ERROR_REPORTING'] });
  const initial = {
    env: {
      DISABLE_TELEMETRY: '',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '65',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '1',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      KEEP: 'yes',
    },
    attribution: { commit: 'team', pr: 'team' },
    permissions: { allow: ['Read'], deny: ['Bash(rm *)'], ask: ['Write'] },
  };
  await f.write(f.settingsFile, JSON.stringify(initial));
  for (let repeat = 0; repeat < 2; repeat++) assert.equal((await f.apply({}, 'install')).state, 'done');
  assert.deepEqual(await f.read(f.settingsFile), {
    ...initial,
    permissions: { ...initial.permissions, defaultMode: 'bypassPermissions' },
    env: { ...initial.env, DISABLE_INSTALLATION_CHECKS: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  });
});

test('并发修改默认偏好：保留新值', async t => {
  const f = await fixture(t, { platform: 'linux' });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'settings' }] });
  await f.write(
    f.settingsFile,
    JSON.stringify({ includeCoAuthoredBy: true, env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60' } }),
  );
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.deepEqual(await f.read(f.settingsFile), {
    permissions: { defaultMode: 'bypassPermissions' },
    includeCoAuthoredBy: true,
    env: {
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_INSTALLATION_CHECKS: '1',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });
});

for (const baseUrl of ['https://api.anthropic.com', 'https://gateway.example.test'])
  test(`补齐缓存兼容：${baseUrl}`, async t => {
    const f = await fixture(t, { platform: 'linux' });
    const result = await f.apply({ mode: 'api', baseUrl, secret: 'fixture-key' });
    assert.equal(result.state, 'done');
    const settings = await f.read(f.settingsFile);
    assert.equal(settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER, baseUrl.includes('gateway') ? '0' : undefined);
    assert.equal(settings.permissions.defaultMode, 'bypassPermissions');
    assert.equal(settings.env.DISABLE_INSTALLATION_CHECKS, '1');
    assert.equal(settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    await f.write(f.settingsFile, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-key' } }));
    assert.equal((await f.apply({}, 'detach')).state, 'done');
    assert.deepEqual(await f.read(f.settingsFile), { env: {} });
  });

test('保存 Claude 配置失败：保留就绪程序', async t => {
  const f = await fixture(t);
  // 手写局部 machine 覆盖：settings-order 最小机器补齐 claude npm 世界与 plugin CLI 应答（对应 full-flow fixture 的相关切面）
  const npmRoot = path.join(f.root, 'npm/node_modules');
  const binary = path.join(npmRoot, '@anthropic-ai/claude-code', 'cli.js');
  const packages = new Map();
  const base = createMachine({}, f.root);
  const programMachine = f.machine({
    npm: async args => {
      const last = args.at(-1);
      if (args[0] === 'root') return ok(npmRoot);
      if (args[0] === 'ls')
        return ok(
          JSON.stringify({ dependencies: packages.has(last) ? { [last]: { version: packages.get(last) } } : {} }),
        );
      if (args[0] === 'view') return ok(JSON.stringify(args[1]?.endsWith('@stable') ? '2.1.318' : '2.9.999'));
      if (args[0] === 'install') {
        const split = last.lastIndexOf('@');
        const name = last.slice(0, split);
        packages.set(name, last.slice(split + 1));
        await f.write(
          path.join(npmRoot, name, 'package.json'),
          JSON.stringify({ name, version: last.slice(split + 1), bin: { claude: 'cli.js' } }),
        );
        await f.write(binary, 'claude fixture');
        return ok();
      }
      throw new Error(`Unexpected npm command ${args[0]}`);
    },
    execute: async (executable, originalArgs) => {
      if (executable === 'git') return ok(`${revision}\tHEAD\n`);
      const args = [...originalArgs];
      if (args[0]?.endsWith('cli.js')) args.shift();
      if (args[0] === '--version') return ok(`${packages.get('@anthropic-ai/claude-code')} (Claude Code)`);
      if (args[0] === 'plugin') {
        if (args[1] === 'marketplace') {
          await f.write(
            path.join(f.claudeRoot, 'plugins/known_marketplaces.json'),
            JSON.stringify({
              'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } },
            }),
          );
          return ok();
        }
        const id = args[2];
        const config = await f.read(f.settingsFile);
        config.enabledPlugins ??= {};
        const file = path.join(f.claudeRoot, 'plugins/installed_plugins.json');
        const records = await f.read(file).catch(() => ({}));
        records.version = 2;
        records.plugins ??= {};
        const installPath = path.join(f.claudeRoot, 'plugins/cache', id);
        await f.write(path.join(installPath, '.claude-plugin/plugin.json'), '{}');
        records.plugins[id] = [{ scope: 'user', version: '1.0.0', installPath, gitCommitSha: revision }];
        await f.write(file, JSON.stringify(records));
        config.enabledPlugins[id] = true;
        await f.write(f.settingsFile, JSON.stringify(config));
        return ok();
      }
      throw new Error(`Unexpected command: ${executable} ${args.join(' ')}`);
    },
    editJson: async (file, edit) => {
      return base.editJson(file, document => {
        edit(document);
        if (f.state.failEditJson && document.env?.DISABLE_TELEMETRY === '1') throw new Error('settings-write-failed');
      });
    },
  });
  const machine = { ...programMachine, source: async () => pluginMarketplaceFiles() };
  const ccw = createCcw({
    machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform: 'win32',
  });
  const apply = async input => {
    const plan = await ccw.plan(input);
    assert.ok(
      plan.items.every(item => item.problem === null),
      JSON.stringify(plan),
    );
    return ccw.apply(plan.id);
  };
  f.state.failEditJson = true;
  const result = await apply({
    task: 'install',
    selected: [{ id: 'claude' }, { id: 'plugin:code-simplifier@claude-plugins-official' }],
  });
  assert.equal(result.state, 'partial');
  assert.equal(result.items[1].state, 'done');
  assert.ok(result.remaining);
  f.state.failEditJson = false;
  const installs = f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length;
  assert.equal((await apply({ resume: result.remaining })).state, 'done');
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, installs);
  assert.equal((await f.read(f.settingsFile)).env.DISABLE_TELEMETRY, '1');
});

test('切换官方连接：隐藏凭据并保留偏好', async t => {
  const f = await fixture(t);
  await f.write(
    f.settingsFile,
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://u:secret-url@example.test?token=secret-query',
        ANTHROPIC_AUTH_TOKEN: 'secret-token',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'custom',
        KEEP: 'value',
      },
      language: 'zh',
      apiKeyHelper: 'old-helper',
    }),
  );
  const view = await f.ccw.inspect();
  assert.equal(JSON.stringify(view).includes('secret-'), false);
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'settings', fields: { mode: 'official' } }] });
  assert.equal(JSON.stringify(plan).includes('secret-'), false);
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.deepEqual(await f.read(f.settingsFile), {
    permissions: { defaultMode: 'bypassPermissions' },
    attribution: { commit: '', pr: '', sessionUrl: false },
    language: 'zh',
    env: {
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_INSTALLATION_CHECKS: '1',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      KEEP: 'value',
    },
  });
});
