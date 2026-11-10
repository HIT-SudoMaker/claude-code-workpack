import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createCcw } from '../dist/ccw.js';
import { createEnv, exists, fail, npmOf, ok } from './env.mjs';

const PACKAGE = '@cometix/ccline';

async function fixture(
  t,
  {
    platform = process.platform,
    packageInstalled = true,
    binaryInstalled = true,
    settings = { statusLine: { type: 'command', command: 'ccline', padding: 4 } },
  } = {},
) {
  // layout 'home'：home/root/home、二进制按 home/.claude/ccline 推导与原 fixture 一致；
  // 外观根保留独立目录，使 CCometixLine 用户数据与 Claude 配置树分离
  const f = await createEnv(t, { layout: 'home', seed: { settings } });
  const cclineRoot = path.join(f.root, 'custom appearance');
  const npmRoot = path.join(f.root, 'npm/node_modules');
  const binary = path.join(f.home, '.claude/ccline', platform === 'win32' ? 'ccline.exe' : 'ccline');
  const settingsFile = f.settingsFile;
  const readSettings = async () => JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  await f.write(path.join(cclineRoot, 'config.toml'), 'version = 2\npalette = "user"\n');
  await f.write(path.join(cclineRoot, 'models.toml'), 'user models');
  await f.write(path.join(cclineRoot, 'palettes/custom.toml'), 'user palette');
  if (binaryInstalled) await f.write(binary, 'known binary');
  if (packageInstalled) await f.json(path.join(npmRoot, PACKAGE, 'package.json'), { name: PACKAGE, version: '2.0.1' });
  const state = {
    version: packageInstalled ? '2.0.1' : null,
    npmRoot,
    npmUnavailable: false,
    npmMissing: false,
    failUninstall: false,
    removeDespiteFailure: false,
    versionOutput: 'ccline 2.0.1',
    copies: [],
    afterUninstall: null,
    afterLsFailures: 0,
    failSettingsRead: false,
  };
  let settingsReadFailed = false;
  const machine = f.machine({
    npm: async args => {
      if (state.npmMissing) return { code: null, stdout: '', failed: true, reason: 'npm-not-found' };
      if (args[0] === 'root') return ok(state.npmRoot);
      if (args[0] === 'ls') {
        if (state.npmUnavailable) return { code: null, stdout: '', failed: true };
        if (state.afterLsFailures-- > 0) return fail();
        return ok(
          JSON.stringify({
            dependencies:
              args.at(-1) === PACKAGE && state.version !== null ? { [PACKAGE]: { version: state.version } } : {},
          }),
        );
      }
      if (args[0] === 'uninstall') {
        assert.equal(args.at(-1), PACKAGE);
        assert.equal((await readSettings()).statusLine?.command === 'ccline', false);
        if (!state.failUninstall || state.removeDespiteFailure) {
          state.version = null;
          await fs.rm(path.join(npmRoot, PACKAGE), { recursive: true, force: true });
        }
        if (state.afterUninstall) await state.afterUninstall();
        return state.failUninstall ? fail() : ok();
      }
      throw new Error(`unexpected npm ${args[0]}`);
    },
    execute: async (executable, args) =>
      executable === binary && args[0] === '--version' ? ok(state.versionOutput) : fail(),
    locate: async command => (command === 'ccline' ? state.copies : []),
    processes: async () => [],
    read: async (target, base) => {
      // 接入解除后的回读失败：以 calls 中的 editJson 记录为触发条件，一次性生效
      if (
        target === settingsFile &&
        state.failSettingsRead &&
        !settingsReadFailed &&
        f.calls.some(call => call.kind === 'editJson' && call.target === settingsFile)
      ) {
        settingsReadFailed = true;
        throw new Error('settings-read-failed');
      }
      return base.read(target);
    },
  });
  const ccw = createCcw({ machine, home: f.home, claudeRoot: f.claudeRoot, cclineRoot, platform });
  const plan = async () => {
    const prepared = await ccw.plan({ task: 'uninstall', selected: [{ id: 'ccline' }] });
    assert.equal(prepared.items[0].problem, null, JSON.stringify(prepared));
    return prepared;
  };
  const apply = async (signal, progress) => ccw.apply((await plan()).id, signal, progress);
  return {
    ...f,
    cclineRoot,
    npmRoot,
    binary,
    readSettings,
    state,
    machine,
    ccw,
    plan,
    apply,
  };
}

for (const platform of ['win32', 'darwin', 'linux'])
  test(`${platform} 卸载 CCometixLine：保留用户数据`, async t => {
    const f = await fixture(t, {
      platform,
      settings: {
        statusLine: { type: 'command', command: 'ccline' },
        subagentStatusLine: { type: 'command', command: 'ccline.exe' },
        keep: true,
      },
    });
    await f.write(path.join(path.dirname(f.binary), 'keep.txt'), 'unrelated home file');
    const other = path.join(f.root, 'other install/ccline');
    await f.write(other, 'another binary');
    f.state.copies = [other];
    const item = (await f.ccw.inspect()).items.find(value => value.id === 'ccline');
    assert.ok(item.actions.includes('uninstall'));
    const result = await f.apply();
    assert.equal(result.state, 'done', JSON.stringify(result));
    assert.deepEqual(await f.readSettings(), { keep: true });
    assert.equal(f.state.version, null);
    assert.equal(await exists(f.binary), false);
    assert.equal(await fs.readFile(path.join(path.dirname(f.binary), 'keep.txt'), 'utf8'), 'unrelated home file');
    assert.equal(await fs.readFile(path.join(f.cclineRoot, 'config.toml'), 'utf8'), 'version = 2\npalette = "user"\n');
    assert.equal(await fs.readFile(path.join(f.cclineRoot, 'models.toml'), 'utf8'), 'user models');
    assert.equal(await fs.readFile(path.join(f.cclineRoot, 'palettes/custom.toml'), 'utf8'), 'user palette');
    assert.equal(await fs.readFile(other, 'utf8'), 'another binary');
    assert.ok(result.items[0].effects.some(effect => effect.code === 'program-other-copies-kept'));
    assert.equal(npmOf(f, 'uninstall').length, 1);
  });

test('卸载手工 CCometixLine：跳过 npm', async t => {
  const f = await fixture(t, { packageInstalled: false });
  f.state.versionOutput = 'CCometixLine 1.6.0';
  assert.ok((await f.ccw.inspect()).items.find(value => value.id === 'ccline').actions.includes('uninstall'));
  assert.equal((await f.apply()).state, 'done');
  assert.equal(await exists(f.binary), false);
  assert.equal(npmOf(f, 'uninstall').length, 0);
});

test('重建操作实例：卸载只继续尚未删除的二进制', async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  const first = await f.apply(abort.signal, event => {
    if (event.kind === 'effect' && event.effect.code === 'package-removed') abort.abort();
  });
  assert.equal(first.state, 'cancelled');
  assert.equal(await exists(f.binary), true);
  const restarted = createCcw({
    machine: f.machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform: process.platform,
  });
  const resumed = await restarted.plan({ resume: first.remaining });
  assert.ok(
    !resumed.items[0].changes.some(change => change.code === 'program-uninstall' && change.detail.includes('npm')),
  );
  assert.equal((await restarted.apply(resumed.id)).state, 'done');
  assert.equal(npmOf(f, 'uninstall').length, 1);
  assert.equal(await exists(f.binary), false);
  assert.equal(await fs.readFile(path.join(f.cclineRoot, 'models.toml'), 'utf8'), 'user models');
});

test('继续 CCometixLine 卸载：复核已解除入口', async t => {
  const f = await fixture(t, { packageInstalled: false });
  f.state.failSettingsRead = true;
  const plan = await f.plan();
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  assert.equal((await f.readSettings()).statusLine, undefined);
  const next = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(next.id)).state, 'done');
  assert.equal(await exists(f.binary), false);
  assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length, 1);
});

test('卸载 CCometixLine：保留异常外观目录', async t => {
  const f = await fixture(t, {
    packageInstalled: false,
    settings: { statusLine: { type: 'command', command: 'ccline' }, env: { CCLINE_HOME: 'relative-appearance' } },
  });
  const result = await f.apply();
  assert.equal(result.state, 'partial');
  assert.equal((await f.readSettings()).statusLine, undefined);
  assert.equal((await f.readSettings()).env.CCLINE_HOME, 'relative-appearance');
  assert.equal(await fs.readFile(f.binary, 'utf8'), 'known binary');
});

test('检查 home CCometixLine：保留 npm 缺失证据', async t => {
  const f = await fixture(t, { packageInstalled: false, settings: {} });
  f.state.npmMissing = true;
  const item = (await f.ccw.inspect()).items.find(value => value.id === 'ccline');
  assert.equal(item.problem, 'npm-not-found');
  assert.ok(item.facts.some(fact => fact.code === 'program-exists'));
  assert.ok(item.actions.includes('uninstall'));
});

for (const connected of [false, true])
  test(`卸载${connected ? '已接入' : '无接入'} CCometixLine：跳过缺失 npm`, async t => {
    const f = await fixture(t, {
      packageInstalled: false,
      settings: connected ? { statusLine: { type: 'command', command: 'ccline' } } : {},
    });
    f.state.npmMissing = true;
    const result = await f.apply();
    assert.equal(result.state, 'done', JSON.stringify(result));
    assert.equal(await exists(f.binary), false);
    assert.equal((await f.readSettings()).statusLine, undefined);
    assert.ok(result.items[0].effects.some(effect => effect.code === 'npm-not-found' && effect.state === 'kept'));
    assert.equal(npmOf(f, 'uninstall').length, 0);
  });

test('检查 home CCometixLine：保留 npm 未知证据', async t => {
  const f = await fixture(t);
  f.state.npmUnavailable = true;
  const item = (await f.ccw.inspect()).items.find(value => value.id === 'ccline');
  assert.equal(item.problem, 'npm-inspection-failed');
  assert.ok(item.facts.some(fact => fact.code === 'program-exists'));
  assert.ok(item.actions.includes('uninstall'));
});

test('准备卸载 CCometixLine：保留配套插件', async t => {
  const f = await fixture(t, {
    settings: { statusLine: { type: 'command', command: 'ccline' }, enabledPlugins: { 'cometix@ccline': true } },
  });
  const plan = await f.plan();
  assert.deepEqual(plan.items[0].changes[0], { code: 'ccline-disconnect-before-uninstall', detail: f.settingsFile });
  assert.deepEqual(plan.items[0].changes.at(-1), { code: 'ccline-companion-kept', detail: 'cometix@ccline' });
});

test('卸载 CCometixLine：保留未知程序副本', async t => {
  const f = await fixture(t);
  f.state.versionOutput = 'unrelated program 2.0.1';
  const result = await f.apply();
  assert.equal(result.state, 'done');
  assert.equal(f.state.version, null);
  assert.equal(await fs.readFile(f.binary, 'utf8'), 'known binary');
  assert.ok(result.items[0].effects.some(effect => effect.code === 'unrecognized-program-kept'));
  assert.equal(
    result.items[0].effects.some(effect => effect.code === 'program-removed'),
    false,
  );
});

test('卸载残留 CCometixLine：仅解除状态栏', async t => {
  const f = await fixture(t, { packageInstalled: false, binaryInstalled: false });
  const result = await f.apply();
  assert.equal(result.state, 'done');
  assert.equal((await f.readSettings()).statusLine, undefined);
  assert.ok(result.items[0].effects.some(effect => effect.code === 'program-not-installed'));
  assert.equal(npmOf(f, 'uninstall').length, 0);
});

test('卸载 home CCometixLine：保留未知 npm 包', async t => {
  const f = await fixture(t);
  f.state.npmUnavailable = true;
  const result = await f.apply();
  assert.equal(result.state, 'partial');
  assert.equal((await f.readSettings()).statusLine, undefined);
  assert.equal(await exists(f.binary), false);
  assert.equal(f.state.version, '2.0.1');
  assert.ok(
    result.items[0].effects.some(effect => effect.code === 'program-removal-unconfirmed' && effect.state === 'failed'),
  );
  assert.ok(result.remaining);
  assert.equal(npmOf(f, 'uninstall').length, 0);
});

test('卸载未知 CCometixLine：保留本地文件', async t => {
  const f = await fixture(t);
  f.state.npmUnavailable = true;
  f.state.versionOutput = 'unrelated program 2.0.1';
  const result = await f.apply();
  assert.equal(result.state, 'partial');
  assert.equal(await fs.readFile(f.binary, 'utf8'), 'known binary');
  assert.ok(result.items[0].effects.some(effect => effect.code === 'unrecognized-program-kept'));
});

test('修改 home CCometixLine：阻止无 npm 卸载', async t => {
  const f = await fixture(t, { packageInstalled: false });
  f.state.npmMissing = true;
  const plan = await f.plan();
  await f.write(f.binary, 'externally replaced binary');
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.equal((await f.readSettings()).statusLine.command, 'ccline');
  assert.equal(await fs.readFile(f.binary, 'utf8'), 'externally replaced binary');
});

test('重试卸载 CCometixLine：仅处理剩余步骤', async t => {
  const f = await fixture(t);
  f.state.failUninstall = true;
  const first = await f.apply();
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  assert.equal((await f.readSettings()).statusLine, undefined);
  assert.equal(await fs.readFile(f.binary, 'utf8'), 'known binary');
  f.state.failUninstall = false;
  const replacement = { type: 'command', command: 'other-statusline' };
  await f.json(f.settingsFile, { statusLine: replacement, keep: 'new' });
  const next = await f.ccw.plan({ resume: first.remaining });
  assert.equal(
    next.items[0].changes.some(change => change.code === 'ccline-disconnect-before-uninstall'),
    false,
  );
  const result = await f.ccw.apply(next.id);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.deepEqual(await f.readSettings(), { statusLine: replacement, keep: 'new' });
  assert.equal(npmOf(f, 'uninstall').length, 2);
});

test('卸载 npm 报错：按实际状态完成', async t => {
  const f = await fixture(t);
  f.state.failUninstall = true;
  f.state.removeDespiteFailure = true;
  const result = await f.apply();
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(f.state.version, null);
  assert.equal(await exists(f.binary), false);
});

test('取消卸载 CCometixLine：保留剩余副本', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.state.afterUninstall = async () => {
    controller.abort();
  };
  const first = await f.apply(controller.signal);
  assert.equal(first.state, 'cancelled');
  assert.equal(f.state.version, null);
  assert.equal(await fs.readFile(f.binary, 'utf8'), 'known binary');
  const next = await f.ccw.plan({ resume: first.remaining });
  assert.equal(
    next.items[0].changes.some(change => change.code === 'program-uninstall' && change.detail.includes('npm')),
    false,
  );
  assert.equal((await f.ccw.apply(next.id)).state, 'done');
  assert.equal(npmOf(f, 'uninstall').length, 1);
});

test('确认卸载失败：重试仅复核', async t => {
  const f = await fixture(t);
  f.state.afterUninstall = async () => {
    f.state.afterLsFailures = 1;
  };
  const first = await f.apply();
  assert.equal(first.state, 'partial');
  assert.ok(first.items[0].effects.some(effect => effect.code === 'program-removal-unconfirmed'));
  const next = await f.ccw.plan({ resume: first.remaining });
  const result = await f.ccw.apply(next.id);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(npmOf(f, 'uninstall').length, 1);
});

test('继续卸载：认可 npm 连带删除二进制', async t => {
  const f = await fixture(t);
  f.state.afterUninstall = async () => {
    await fs.rm(f.binary, { force: true });
    f.state.afterLsFailures = 1;
  };
  const first = await f.apply();
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  assert.equal(first.items[0].isPending, true);
  const next = await f.ccw.plan({ resume: first.remaining });
  const result = await f.ccw.apply(next.id);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(await exists(f.binary), false);
  assert.ok(result.items[0].effects.some(effect => effect.code === 'program-removed' && effect.detail === f.binary));
  assert.equal(npmOf(f, 'uninstall').length, 1);
});

test('重建 CCometixLine 入口：阻止继续卸载', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const first = await f.apply(controller.signal, event => {
    if (event.kind === 'effect' && event.effect.code === 'disconnected') controller.abort();
  });
  assert.equal(first.state, 'cancelled');
  await f.json(f.settingsFile, { statusLine: { type: 'command', command: 'ccline', padding: 9 } });
  const next = await f.ccw.plan({ resume: first.remaining });
  const result = await f.ccw.apply(next.id);
  assert.equal(result.state, 'partial');
  assert.ok(result.items[0].effects.some(effect => effect.code === 'connection-changed'));
  assert.equal(npmOf(f, 'uninstall').length, 0);
  assert.equal(f.state.version, '2.0.1');
});

for (const [change, label] of [
  ['binary', '替换二进制'],
  ['prefix', '更换前缀'],
])
  test(`修改 CCometixLine 安装：阻止旧计划（${label}）`, async t => {
    const f = await fixture(t);
    const plan = await f.plan();
    if (change === 'binary') await f.write(f.binary, 'externally replaced binary');
    else f.state.npmRoot = path.join(f.root, 'another prefix');
    const result = await f.ccw.apply(plan.id);
    assert.equal(result.state, 'failed');
    assert.equal((await f.readSettings()).statusLine.command, 'ccline');
    assert.equal(npmOf(f, 'uninstall').length, 0);
  });

test('卸载链接 CCometixLine：保留共享源', async t => {
  const f = await fixture(t, { packageInstalled: false });
  const directory = path.dirname(f.binary);
  const shared = path.join(f.root, 'shared program');
  await fs.rename(directory, shared);
  await fs.symlink(shared, directory, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.apply();
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(shared, path.basename(f.binary)), 'utf8'), 'known binary');
  assert.ok(result.items[0].effects.some(effect => effect.code === 'unrecognized-program-kept'));
});
