import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createMachine } from '../dist/machine.js';
import { createTestEnvironment, fail, ok } from './test-environment.mjs';

const DEFAULT_ROOT = { autoUpdatesChannel: 'stable', skipDangerousModePermissionPrompt: true };

const BASE_ENV = {
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_INSTALLATION_CHECKS: '1',
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

async function createSettingsScenario(
  testContext,
  { before = {}, platform = 'win32', inheritedKeys = [], hasProgram = false } = {},
) {
  const workspace = await createTestEnvironment(testContext, { layout: 'root', seed: { settings: before } });
  const base = createMachine({}, workspace.root);
  const binary = path.join(workspace.home, '.local/bin', platform === 'win32' ? 'claude.exe' : 'claude');
  if (hasProgram) await workspace.write(binary, 'fixture program');
  const state = {
    writes: 0,
    rejectAfterWrite: false,
    loginCalls: 0,
  };
  const machine = workspace.machine({
    npm: async () => ok('{}'),
    editJson: async (file, edit) => {
      await base.editJson(file, edit);
      if (file === workspace.settingsFile) {
        state.writes++;
        if (state.rejectAfterWrite) throw new Error('fixture-cleanup-failed');
      }
    },
    execute: async (file, args) => {
      if (file === binary && args[0] === 'auth') {
        if (args[1] === 'login') {
          state.loginCalls++;
          return ok();
        }
        if (args[1] === 'status') return ok('{"loggedIn":true}');
      }
      return fail();
    },
  });
  const ccw = workspace.ccw(machine, { platform, inheritedKeys });
  const prepare = async (fields = {}, task = 'install') => {
    const plan = await ccw.plan({
      task,
      selected: [{ id: 'settings', fields }],
    });
    assert.equal(plan.items[0].problem, null, JSON.stringify(plan));
    return plan;
  };
  const apply = async (fields = {}, task = 'install') => ccw.apply((await prepare(fields, task)).id);
  const contents = () => fs.readFile(workspace.settingsFile, 'utf8');
  return { ...workspace, ccw, state, prepare, apply, contents };
}

// 常见配置流程
for (const { token, expected } of [
  { token: 'fixture-token', expected: 'token' },
  { token: '', expected: 'key' },
  { token: null, expected: 'key' },
])
  test(`读取本地认证提示：${JSON.stringify(token)}`, async testContext => {
    const scenario = await createSettingsScenario(testContext, {
      before: {
        model: 'fixture-root-hidden',
        apiKeyHelper: 'fixture-helper-hidden',
        env: { ANTHROPIC_API_KEY: 'fixture-key-hidden', ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: 'fixture-env' },
      },
    });
    const before = await scenario.contents();
    const view = await scenario.ccw.inspect();
    const item = view.items.find(item => item.id === 'settings');
    assert.deepEqual(item.values, { mode: 'api', auth: expected, model: 'fixture-env' });
    for (const hidden of ['fixture-root-hidden', 'fixture-helper-hidden', 'fixture-key-hidden', 'fixture-token'])
      assert.equal(JSON.stringify(view).includes(hidden), false);
    assert.equal(await scenario.contents(), before);
    assert.equal(scenario.state.writes, 0);
  });

test('保存 API 配置：按平台和模型顺序写入', async testContext => {
  const scenario = await createSettingsScenario(testContext);
  const before = await scenario.contents();
  await scenario.ccw.inspect();
  const plan = await scenario.prepare({
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
  assert.equal(await scenario.contents(), before);
  assert.equal(scenario.state.writes, 0);
  assert.equal(JSON.stringify(plan).includes('fixture-key-A'), false);
  const result = await scenario.ccw.apply(plan.id);
  assert.equal(result.state, 'done');
  assert.equal(JSON.stringify(result).includes('fixture-key-A'), false);
  assert.equal(scenario.state.writes, 1);
  const after = await scenario.read(scenario.settingsFile);
  assert.deepEqual(after, {
    ...DEFAULT_ROOT,
    permissions: { defaultMode: 'bypassPermissions' },
    attribution: { commit: '', pr: '', sessionUrl: false },
    language: 'Simplified Chinese',
    outputStyle: 'Explanatory',
    env: {
      ...BASE_ENV,
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
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
  assert.deepEqual(Object.keys(after), [
    'permissions',
    'attribution',
    'language',
    'outputStyle',
    ...Object.keys(DEFAULT_ROOT),
    'env',
  ]);
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
  assert.equal(await scenario.contents(), `${JSON.stringify(after, null, 2)}\n`);
});

for (const { auth, secret, expected } of [
  { auth: 'token', secret: ' fixture-new-token ', expected: { ANTHROPIC_AUTH_TOKEN: 'fixture-new-token' } },
  { auth: 'key', secret: ' fixture-new-key ', expected: { ANTHROPIC_API_KEY: 'fixture-new-key' } },
  { auth: 'token', secret: '', expected: { ANTHROPIC_AUTH_TOKEN: ' fixture-old-token ' } },
  { auth: 'key', secret: undefined, expected: { ANTHROPIC_API_KEY: ' fixture-old-key ' } },
])
  test(`选择 API 凭据：${auth} ${secret?.trim() || '保留'}`, async testContext => {
    const scenario = await createSettingsScenario(testContext, {
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
    assert.equal(
      (await scenario.apply({ mode: 'api', auth, ...(secret !== undefined ? { secret } : {}) })).state,
      'done',
    );
    const after = await scenario.read(scenario.settingsFile);
    assert.deepEqual(after, {
      ...DEFAULT_ROOT,
      permissions: { defaultMode: 'bypassPermissions' },
      attribution: { commit: '', pr: '', sessionUrl: false },
      env: {
        ...BASE_ENV,
        CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        ANTHROPIC_BASE_URL: 'https://gateway.example.test',
        ...expected,
      },
      model: 'fixture-root-keep',
    });
  });

test('切换官方连接：隐藏凭据并保留偏好', async testContext => {
  const scenario = await createSettingsScenario(testContext);
  await scenario.json(scenario.settingsFile, {
    env: {
      ANTHROPIC_BASE_URL: 'https://u:secret-url@example.test?token=secret-query',
      ANTHROPIC_AUTH_TOKEN: 'secret-token',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'custom',
      KEEP: 'value',
    },
    language: 'zh',
    apiKeyHelper: 'old-helper',
  });
  const view = await scenario.ccw.inspect();
  assert.equal(JSON.stringify(view).includes('secret-'), false);
  const plan = await scenario.ccw.plan({
    task: 'install',
    selected: [{ id: 'settings', fields: { mode: 'official' } }],
  });
  assert.equal(JSON.stringify(plan).includes('secret-'), false);
  assert.equal((await scenario.ccw.apply(plan.id)).state, 'done');
  assert.deepEqual(await scenario.read(scenario.settingsFile), {
    ...DEFAULT_ROOT,
    permissions: { defaultMode: 'bypassPermissions' },
    attribution: { commit: '', pr: '', sessionUrl: false },
    language: 'zh',
    env: {
      ...BASE_ENV,
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
      KEEP: 'value',
    },
  });
});

test('处理模式后模型字段：保留显式写入次序', async testContext => {
  const scenario = await createSettingsScenario(testContext, { before: { env: { ANTHROPIC_MODEL: 'fixture-old' } } });
  assert.equal((await scenario.apply({ mode: 'official', model: ' fixture-explicit ' })).state, 'done');
  assert.equal((await scenario.read(scenario.settingsFile)).env.ANTHROPIC_MODEL, 'fixture-explicit');
});

for (const task of ['uninstall', 'install'])
  test(`清理本地连接：${task === 'uninstall' ? '解除' : '官方模式'}`, async testContext => {
    const scenario = await createSettingsScenario(testContext, {
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
    assert.equal((await scenario.apply(task === 'install' ? { mode: 'official' } : {}, task)).state, 'done');
    const after = await scenario.read(scenario.settingsFile);
    assert.deepEqual(after, {
      ...(task === 'install' ? DEFAULT_ROOT : {}),
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

test('解除 helper：保留空 env 容器', async testContext => {
  const scenario = await createSettingsScenario(testContext, { before: { apiKeyHelper: 'fixture-helper' } });
  assert.equal((await scenario.apply({}, 'uninstall')).state, 'done');
  assert.deepEqual(await scenario.read(scenario.settingsFile), { env: {} });
});

test('重复保存配置：输出字节保持一致', async testContext => {
  const scenario = await createSettingsScenario(testContext, {
    before: { USER_B: { z: 1, a: 2 }, model: 'fixture-root', USER_A: [2, 1] },
  });
  const fields = { mode: 'api', baseUrl: 'https://gateway.example.test', secret: 'fixture-key', model: 'fixture-main' };
  assert.equal((await scenario.apply(fields)).state, 'done');
  const first = await scenario.contents();
  assert.equal((await scenario.apply(fields)).state, 'done');
  assert.equal(await scenario.contents(), first);
  assert.equal(scenario.state.writes, 1);
});

// 默认值、已有内容与并发变更
for (const { platform, baseUrl, header } of [
  { platform: 'win32', baseUrl: undefined, header: false },
  { platform: 'linux', baseUrl: 'https://api.anthropic.com', header: false },
  { platform: 'darwin', baseUrl: 'https://gateway.example.test', header: true },
  { platform: 'linux', baseUrl: 'https://API.ANTHROPIC.COM:443/path', header: false },
  { platform: 'linux', baseUrl: 'not a URL', header: false },
  { platform: 'darwin', baseUrl: 'https://user:fixture-secret@gateway.example.test', header: false },
  { platform: 'linux', baseUrl: 'https://gateway.example.test?key=fixture-secret', header: false },
])
  test(`补齐默认配置：${platform} ${baseUrl ?? '无地址'}`, async testContext => {
    const scenario = await createSettingsScenario(testContext, {
      platform,
      before: { env: baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: baseUrl } },
    });
    assert.equal((await scenario.apply()).state, 'done');
    const after = await scenario.read(scenario.settingsFile);
    assert.deepEqual(after, {
      ...DEFAULT_ROOT,
      permissions: { defaultMode: 'bypassPermissions' },
      attribution: { commit: '', pr: '', sessionUrl: false },
      env: {
        ...BASE_ENV,
        ...(platform === 'win32' ? { CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' } : {}),
        ...(header ? { CLAUDE_CODE_ATTRIBUTION_HEADER: '0' } : {}),
        ...(baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: baseUrl }),
      },
    });
  });

for (const baseUrl of ['https://api.anthropic.com', 'https://gateway.example.test'])
  test(`补齐缓存兼容：${baseUrl}`, async testContext => {
    const scenario = await createSettingsScenario(testContext, { platform: 'linux' });
    const result = await scenario.apply({ mode: 'api', baseUrl, secret: 'fixture-key' });
    assert.equal(result.state, 'done');
    const settings = await scenario.read(scenario.settingsFile);
    assert.equal(settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER, baseUrl.includes('gateway') ? '0' : undefined);
    assert.equal(settings.permissions.defaultMode, 'bypassPermissions');
    assert.equal(settings.env.DISABLE_INSTALLATION_CHECKS, '1');
    assert.equal(settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    await scenario.json(scenario.settingsFile, { env: { ANTHROPIC_API_KEY: 'fixture-key' } });
    assert.equal((await scenario.apply({}, 'uninstall')).state, 'done');
    assert.deepEqual(await scenario.read(scenario.settingsFile), { env: {} });
  });

test('保存默认配置：保留显式设置', async testContext => {
  const scenario = await createSettingsScenario(testContext, {
    platform: 'linux',
    inheritedKeys: ['DISABLE_ERROR_REPORTING'],
  });
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
  await scenario.json(scenario.settingsFile, initial);
  for (let repeat = 0; repeat < 2; repeat++) assert.equal((await scenario.apply({}, 'install')).state, 'done');
  assert.deepEqual(await scenario.read(scenario.settingsFile), {
    ...DEFAULT_ROOT,
    ...initial,
    permissions: { ...initial.permissions, defaultMode: 'bypassPermissions' },
    env: { ...initial.env, DISABLE_INSTALLATION_CHECKS: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  });
});

test('补齐默认配置：跳过继承名称', async testContext => {
  const scenario = await createSettingsScenario(testContext, {
    inheritedKeys: ['DISABLE_TELEMETRY', 'CLAUDE_CODE_USE_POWERSHELL_TOOL', 'CLAUDE_CODE_ATTRIBUTION_HEADER'],
    before: {
      env: { ANTHROPIC_BASE_URL: 'https://gateway.example.test', ANTHROPIC_API_KEY: 'fixture-key' },
      includeCoAuthoredBy: true,
    },
  });
  assert.equal((await scenario.apply({ language: 'English' })).state, 'done');
  assert.deepEqual(await scenario.read(scenario.settingsFile), {
    ...DEFAULT_ROOT,
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
  test(`保留 attribution：${JSON.stringify(attribution)}`, async testContext => {
    const scenario = await createSettingsScenario(testContext, { before: { attribution } });
    assert.equal((await scenario.apply()).state, 'done');
    assert.deepEqual((await scenario.read(scenario.settingsFile)).attribution, attribution);
  });

test('删除编辑字段：保留 root model 和 helper', async testContext => {
  const scenario = await createSettingsScenario(testContext, {
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
  assert.equal((await scenario.apply({ model: '   ', sonnet: '', language: '', outputStyle: '' })).state, 'done');
  const after = await scenario.read(scenario.settingsFile);
  assert.deepEqual(after, {
    ...DEFAULT_ROOT,
    permissions: { defaultMode: 'bypassPermissions' },
    attribution: { commit: '', pr: '', sessionUrl: false },
    apiKeyHelper: 'fixture-helper',
    env: {
      ...BASE_ENV,
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60',
      USER_ENV_B: 'keep',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'fixture-fable-keep',
    },
    model: 'fixture-root-keep',
  });
  assert.deepEqual(Object.keys(after), [
    'permissions',
    'attribution',
    ...Object.keys(DEFAULT_ROOT),
    'apiKeyHelper',
    'env',
    'model',
  ]);
});

test('整理已有配置：保留未知值和嵌套顺序', async testContext => {
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
  const scenario = await createSettingsScenario(testContext, { before });
  assert.equal((await scenario.apply({ language: 'English' })).state, 'done');
  const after = await scenario.read(scenario.settingsFile);
  assert.deepEqual(after, {
    ...DEFAULT_ROOT,
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
    ...Object.keys(DEFAULT_ROOT),
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

test('整理自身属性：保留原型同名键', async testContext => {
  const before = JSON.parse(
    '{"__proto__":{"z":2,"a":1},"model":"fixture-root","env":{"__proto__":{"z":3,"a":1},"constructor":[3,1],"ANTHROPIC_MODEL":"fixture-main","toString":false},"constructor":null}',
  );
  const scenario = await createSettingsScenario(testContext, { before });
  assert.equal((await scenario.apply()).state, 'done');
  const after = await scenario.read(scenario.settingsFile);
  assert.equal(Object.getPrototypeOf(after), Object.prototype);
  assert.equal(Object.getPrototypeOf(after.env), Object.prototype);
  assert.equal(Object.hasOwn(after, '__proto__'), true);
  assert.equal(Object.hasOwn(after.env, '__proto__'), true);
  assert.deepEqual(after.__proto__, { z: 2, a: 1 });
  assert.deepEqual(after.env.__proto__, { z: 3, a: 1 });
  assert.equal(after.constructor, null);
  assert.deepEqual(after.env.constructor, [3, 1]);
  assert.equal(after.env.toString, false);
  assert.deepEqual(Object.keys(after), [
    'permissions',
    'attribution',
    ...Object.keys(DEFAULT_ROOT),
    '__proto__',
    'constructor',
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
    '__proto__',
    'constructor',
    'toString',
    'ANTHROPIC_MODEL',
  ]);
});

test('合并并发未知字段：保留新默认偏好', async testContext => {
  const scenario = await createSettingsScenario(testContext);
  const plan = await scenario.prepare({ model: 'fixture-main' });
  await scenario.json(scenario.settingsFile, {
    USER_NEW: { z: 0, a: 1 },
    includeCoAuthoredBy: true,
    env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60', USER_NEW: [2, 1] },
  });
  assert.equal((await scenario.ccw.apply(plan.id)).state, 'done');
  assert.deepEqual(await scenario.read(scenario.settingsFile), {
    ...DEFAULT_ROOT,
    permissions: { defaultMode: 'bypassPermissions' },
    includeCoAuthoredBy: true,
    USER_NEW: { z: 0, a: 1 },
    env: {
      ...BASE_ENV,
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60',
      USER_NEW: [2, 1],
      ANTHROPIC_MODEL: 'fixture-main',
    },
  });
});

test('并发修改默认偏好：保留新值', async testContext => {
  const scenario = await createSettingsScenario(testContext, { platform: 'linux' });
  const plan = await scenario.ccw.plan({ task: 'install', selected: [{ id: 'settings' }] });
  await scenario.json(scenario.settingsFile, {
    includeCoAuthoredBy: true,
    env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60' },
  });
  assert.equal((await scenario.ccw.apply(plan.id)).state, 'done');
  assert.deepEqual(await scenario.read(scenario.settingsFile), {
    ...DEFAULT_ROOT,
    permissions: { defaultMode: 'bypassPermissions' },
    includeCoAuthoredBy: true,
    env: {
      ...BASE_ENV,
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60',
    },
  });
});

// 预览后的冲突保护
for (const fields of [{ model: 'fixture-new' }, { model: '' }, { mode: 'official' }])
  test(`拒绝继承字段冲突：${JSON.stringify(fields)}`, async testContext => {
    const scenario = await createSettingsScenario(testContext, { inheritedKeys: ['ANTHROPIC_MODEL'] });
    const before = await scenario.contents();
    const plan = await scenario.ccw.plan({ task: 'install', selected: [{ id: 'settings', fields }] });
    assert.equal(plan.items[0].problem, 'inherited-configuration-conflict');
    assert.equal((await scenario.ccw.apply(plan.id)).state, 'failed');
    assert.equal(scenario.state.writes, 0);
    assert.equal(await scenario.contents(), before);
  });

test('拒绝目标漂移：不写入排序和默认值', async testContext => {
  const scenario = await createSettingsScenario(testContext, {
    before: { env: { ANTHROPIC_MODEL: 'fixture-old', USER_A: 'keep' } },
  });
  const plan = await scenario.prepare({ model: 'fixture-requested' });
  await scenario.json(scenario.settingsFile, { env: { ANTHROPIC_MODEL: 'fixture-external', USER_A: 'keep' } });
  const before = await scenario.contents();
  const result = await scenario.ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.items[0].effects.at(-1).code, 'target-changed');
  assert.equal(scenario.state.writes, 0);
  assert.equal(await scenario.contents(), before);
});

test('拒绝 helper 漂移：保护新增调用入口', async testContext => {
  const scenario = await createSettingsScenario(testContext);
  const plan = await scenario.prepare({ mode: 'official' });
  await scenario.json(scenario.settingsFile, { apiKeyHelper: 'fixture-new-helper' });
  const result = await scenario.ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.items[0].effects.at(-1).code, 'target-changed');
  assert.deepEqual(await scenario.read(scenario.settingsFile), { apiKeyHelper: 'fixture-new-helper' });
  assert.equal(scenario.state.writes, 0);
});

// 写入已生效时的失败恢复
test('适配器写后拒绝：立即核查已生效配置后继续登录', async testContext => {
  const scenario = await createSettingsScenario(testContext, {
    hasProgram: true,
    before: { env: { ANTHROPIC_API_KEY: 'fixture-key' }, apiKeyHelper: 'fixture-helper' },
  });
  const plan = await scenario.prepare({ mode: 'official', login: 'yes' });
  scenario.state.rejectAfterWrite = true;
  const result = await scenario.ccw.apply(plan.id);
  assert.equal(result.state, 'done');
  assert.deepEqual(
    result.items[0].effects.map(effect => effect.code),
    ['settings-saved', 'logged-in'],
  );
  assert.equal(scenario.state.writes, 1);
  const committed = await scenario.read(scenario.settingsFile);
  assert.equal(committed.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(committed.apiKeyHelper, undefined);
  await scenario.json(scenario.settingsFile, { ...committed, USER_LATER: { keep: true } });
  const later = await scenario.contents();
  scenario.state.rejectAfterWrite = false;
  assert.equal((await scenario.apply({ mode: 'official' })).state, 'done');
  assert.equal(scenario.state.writes, 1);
  assert.equal(scenario.state.loginCalls, 1);
  assert.equal(await scenario.contents(), later);
});
