import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createCcw } from '../dist/ccw.js';
import { createMachine } from '../dist/machine.js';
import { runTerminal } from '../dist/terminal.js';
import { createEnv, exists, npmOf, npmWorld, ok, versionProbe } from './env.mjs';

const asset = await fs.readFile(new URL('../assets/ccline/config.toml', import.meta.url), 'utf8');
const fixtureStyle = 'version = 2\npalette = "terminal"\nglyphs = "ascii"\n';

async function fixture(
  t,
  { installed = false, settings = {}, style, platform = process.platform, customRoot = false } = {},
) {
  // layout 'root'：claudeRoot 与约定目录分离，二进制仍按 home/.claude/ccline 推导；
  // cclineRoot 默认取约定目录，使 CCLINE_HOME 写入语义与生产一致
  const f = await createEnv(t, { layout: 'root', seed: { settings } });
  const cclineRoot = customRoot ? path.join(f.root, 'custom appearance') : path.join(f.home, '.claude/ccline');
  const binary = path.join(f.home, '.claude/ccline', platform === 'win32' ? 'ccline.exe' : 'ccline');
  const file = f.settingsFile;
  const styleFile = path.join(cclineRoot, 'config.toml');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  if (installed) await f.write(binary, 'fixture binary 2.0.1');
  if (style !== undefined) await f.write(styleFile, style);
  const state = {
    version: installed ? '2.0.1' : null,
    npmRoot: path.join(f.root, platform === 'win32' ? 'npm/node_modules' : 'npm/lib/node_modules'),
    fail: null,
    noBinary: false,
    versionOutput: 'ccline 2.0.1',
    onCommand: null,
    onExecute: null,
    corruptBinary: false,
    failSettingsRead: false,
    failAppearanceRead: false,
  };
  let settingsReadFailed = false;
  let appearanceReadFailed = false;
  const world = npmWorld({
    package: '@cometix/ccline',
    state,
    view: () => ok(JSON.stringify('2.0.1')),
    onCommand: async args => {
      if (state.onCommand) await state.onCommand(args);
    },
    failCommand: () => state.fail,
    install: async () => {
      state.version = '2.0.1';
      if (!state.noBinary) {
        await fs.writeFile(binary, 'fixture binary 2.0.1');
        // 指纹故障无法经 faults 注入（fingerprint 无钩子）；安装后把二进制换成目录，
        // 让 machine.fingerprint 确定性地抛错，落入 program-installation-unconfirmed 分支
        if (state.corruptBinary) {
          await fs.rm(binary);
          await fs.mkdir(binary);
        }
      }
      return ok();
    },
  });
  const machine = f.machine({
    npm: world.npm,
    execute: versionProbe({
      binary,
      output: () => state.versionOutput,
      before: (executable, args, options) => (state.onExecute ? state.onExecute(executable, args, options) : undefined),
    }),
    read: async (target, base) => {
      // 接入写入后的回读失败：以 calls 中的 editJson 记录为触发条件，一次性生效
      if (
        target === f.settingsFile &&
        state.failSettingsRead &&
        !settingsReadFailed &&
        f.calls.some(call => call.kind === 'editJson' && call.target === f.settingsFile)
      ) {
        settingsReadFailed = true;
        throw new Error('settings-read-failed');
      }
      // 外观写入后的回读失败：文件出现即触发（initialize 是唯一写入方），一次性生效
      if (target === styleFile && state.failAppearanceRead && !appearanceReadFailed && (await exists(styleFile))) {
        appearanceReadFailed = true;
        throw new Error('appearance-read-failed');
      }
      return base.read(target);
    },
  });
  const ccw = createCcw({ machine, home: f.home, claudeRoot: f.claudeRoot, cclineRoot, platform });
  return {
    ...f,
    cclineRoot,
    binary,
    file,
    styleFile,
    state,
    machine,
    ccw,
    readSettings: async () => JSON.parse(await fs.readFile(file, 'utf8')),
    apply: async input => {
      const plan = await ccw.plan(input);
      assert.equal(plan.items[0].problem, null);
      return ccw.apply(plan.id);
    },
  };
}

test('检查 CCometixLine：报告外观异常', async t => {
  const f = await fixture(t, {
    installed: true,
    style: 'broken = [',
    settings: { statusLine: { type: 'command', command: 'ccline' } },
  });
  const item = (await f.ccw.inspect()).items.find(item => item.id === 'ccline');
  assert.equal(item.problem, 'invalid-appearance');
  assert.ok(item.facts.some(fact => fact.code === 'program-exists'));
  assert.ok(item.actions.includes('detach'));
  assert.ok(item.actions.includes('uninstall'));
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  assert.equal(plan.items[0].problem, item.problem);
});

test('重建操作实例：保留安装事实并只续办接入', async t => {
  const f = await fixture(t);
  f.faults.editJson.set(f.file, new Error('connection-write-failed'));
  const first = await f.ccw.apply((await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] })).id);
  assert.ok(first.remaining);
  assert.equal(npmOf(f, 'install').length, 1);
  const metadataReads = npmOf(f, 'view').length;
  f.faults.editJson.delete(f.file);
  const restarted = createCcw({
    machine: f.machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform: process.platform,
  });
  const resumed = await restarted.plan({ resume: first.remaining });
  assert.equal((await restarted.apply(resumed.id)).state, 'done');
  assert.equal(npmOf(f, 'install').length, 1);
  assert.equal(npmOf(f, 'view').length, metadataReads);
  assert.equal((await f.readSettings()).statusLine.command, 'ccline');
});

test('重建操作实例：重装沿用冻结的双状态栏模板', async t => {
  const statusLine = { type: 'command', command: 'ccline', padding: 4, refreshInterval: 8 };
  const subagentStatusLine = { type: 'command', command: 'ccline', padding: 6, extra: 'keep' };
  const f = await fixture(t, { installed: true, style: fixtureStyle, settings: { statusLine, subagentStatusLine } });
  f.state.fail = 'install';
  const first = await f.apply({ task: 'install', selected: [{ id: 'ccline', maintenance: 'reinstall' }] });
  assert.equal((await f.readSettings()).subagentStatusLine, undefined);
  f.state.fail = null;
  const restarted = createCcw({
    machine: f.machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform: process.platform,
  });
  const resumed = await restarted.plan({ resume: first.remaining });
  assert.equal((await restarted.apply(resumed.id)).state, 'done');
  assert.deepEqual(await f.readSettings(), { statusLine, subagentStatusLine });
  assert.equal(npmOf(f, 'install').length, 2);
});

test('同字节重装回执丢失：重启后保持待核对且不重复派发', async t => {
  const f = await fixture(t, {
    installed: true,
    style: fixtureStyle,
    settings: { statusLine: { type: 'command', command: 'ccline', padding: 4 } },
  });
  const machine = {
    ...f.machine,
    async npm(args, options) {
      const result = await f.machine.npm(args, options);
      if (args[0] === 'install') throw new Error('receipt-lost');
      return result;
    },
  };
  const firstCcw = createCcw({
    machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform: process.platform,
  });
  const first = await firstCcw.apply(
    (await firstCcw.plan({ task: 'install', selected: [{ id: 'ccline', maintenance: 'reinstall' }] })).id,
  );
  assert.ok(first.remaining);
  const restarted = createCcw({
    machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform: process.platform,
  });
  const resumed = await restarted.plan({ resume: first.remaining });
  assert.ok(resumed.items[0].changes.some(change => change.code === 'operation-result-check'));
  assert.equal((await restarted.apply(resumed.id)).state, 'partial');
  assert.equal(npmOf(f, 'install').length, 1);
  assert.equal((await f.readSettings()).statusLine, undefined);
});

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform} 安装 CCometixLine：复制默认外观`, async t => {
    const f = await fixture(t, { platform, settings: { env: { KEEP: 'test' }, language: 'zh' } });
    const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
    assert.deepEqual(plan.items[0].changes, [
      { code: 'ccline-program-prepare', detail: '2.0.1' },
      { code: 'appearance-copy', detail: f.styleFile },
      { code: 'ccline-connect', detail: f.file },
    ]);
    assert.equal(await fs.readFile(f.file, 'utf8'), '{"env":{"KEEP":"test"},"language":"zh"}');
    assert.equal(npmOf(f, 'install').length, 0);
    const result = await f.ccw.apply(plan.id);
    assert.equal(result.state, 'done');
    assert.equal(await fs.readFile(f.styleFile, 'utf8'), asset);
    assert.deepEqual(await f.readSettings(), {
      env: { KEEP: 'test' },
      language: 'zh',
      statusLine: { type: 'command', command: 'ccline', padding: 0 },
    });
    assert.equal(await exists(f.binary), true);
    assert.equal(await exists(path.join(f.home, '.claude/settings.json')), false);
  });
}

test('安装 CCometixLine：保留已有外观', async t => {
  const f = await fixture(t, {
    installed: true,
    style: fixtureStyle,
    settings: { statusLine: { type: 'command', command: 'ccline.exe', padding: 4, refreshInterval: 8 } },
  });
  assert.equal((await f.apply({ task: 'install', selected: [{ id: 'ccline' }] })).state, 'done');
  assert.equal(await fs.readFile(f.styleFile, 'utf8'), fixtureStyle);
  assert.equal((await f.readSettings()).statusLine.padding, 4);
  assert.equal((await f.readSettings()).statusLine.refreshInterval, 8);
  assert.equal(npmOf(f, 'install').length, 0);
});

for (const customRoot of [false, true])
  test(`继续 CCometixLine 接入：复核${customRoot ? '自定义' : '默认'}目录`, async t => {
    const f = await fixture(t, { installed: true, style: fixtureStyle, customRoot });
    f.state.failSettingsRead = true;
    const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
    const first = await f.ccw.apply(plan.id);
    assert.equal(first.state, 'partial');
    assert.ok(first.remaining);
    assert.equal((await f.readSettings()).statusLine.command, 'ccline');
    const next = await f.ccw.plan({ resume: first.remaining });
    assert.deepEqual(next.items, []);
    assert.equal((await f.ccw.apply(next.id)).state, 'done');
    assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.file).length, 1);
    if (customRoot) assert.equal((await f.readSettings()).env.CCLINE_HOME, f.cclineRoot);
  });

test('继续 CCometixLine 外观：复用已写文件', async t => {
  const f = await fixture(t, { installed: true });
  f.state.failAppearanceRead = true;
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  assert.equal(await fs.readFile(f.styleFile, 'utf8'), asset);
  const next = await f.ccw.plan({ resume: first.remaining });
  assert.deepEqual(
    next.items[0].changes.map(change => change.code),
    ['ccline-connect'],
  );
  assert.equal((await f.ccw.apply(next.id)).state, 'done');
  assert.equal((await f.readSettings()).statusLine.command, 'ccline');
});

test('复核 CCometixLine 接入：保留外部替换', async t => {
  const f = await fixture(t, { installed: true, style: fixtureStyle });
  f.state.failSettingsRead = true;
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  const first = await f.ccw.apply(plan.id);
  const replacement = { type: 'command', command: 'user-statusline' };
  await fs.writeFile(f.file, JSON.stringify({ statusLine: replacement }));
  const next = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(next.id)).state, 'partial');
  assert.deepEqual((await f.readSettings()).statusLine, replacement);
  assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.file).length, 1);
});

test('复核 CCometixLine 外观：保留外部替换', async t => {
  const f = await fixture(t, { installed: true });
  f.state.failAppearanceRead = true;
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  const first = await f.ccw.apply(plan.id);
  await fs.writeFile(f.styleFile, fixtureStyle);
  const next = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(next.id)).state, 'partial');
  assert.equal(await fs.readFile(f.styleFile, 'utf8'), fixtureStyle);
  assert.equal((await f.readSettings()).statusLine, undefined);
});

test('继续 CCometixLine 重装：复用已解除入口', async t => {
  const statusLine = { type: 'command', command: 'ccline', padding: 3 };
  const f = await fixture(t, { installed: true, style: fixtureStyle, settings: { statusLine } });
  f.state.failSettingsRead = true;
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline', maintenance: 'reinstall' }] });
  const first = await f.ccw.apply(plan.id);
  assert.equal(npmOf(f, 'install').length, 0);
  const next = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(next.id)).state, 'done');
  assert.deepEqual((await f.readSettings()).statusLine, statusLine);
  assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.file).length, 2);
  assert.equal(npmOf(f, 'install').length, 1);
});

test('重装 CCometixLine：恢复双状态栏', async t => {
  const statusLine = { type: 'command', command: 'ccline', padding: 3, refreshInterval: 8 };
  const subagentStatusLine = { type: 'command', command: 'ccline', padding: 1, extra: 'keep' };
  const f = await fixture(t, { installed: true, style: fixtureStyle, settings: { statusLine, subagentStatusLine } });
  f.state.onCommand = async args => {
    if (args[0] === 'install') {
      assert.equal((await f.readSettings()).statusLine, undefined);
      assert.equal((await f.readSettings()).subagentStatusLine, undefined);
      assert.ok(args.includes('--force'));
    }
  };
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline', maintenance: 'reinstall' }] });
  assert.deepEqual(plan.items[0].changes, [
    { code: 'ccline-program-prepare', detail: '2.0.1' },
    { code: 'ccline-reinstall-connection', detail: f.file },
    { code: 'appearance-kept' },
    { code: 'ccline-subagent-restore', detail: f.file },
    { code: 'ccline-connect', detail: f.file },
  ]);
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.deepEqual(await f.readSettings(), { statusLine, subagentStatusLine });
  assert.equal(await fs.readFile(f.styleFile, 'utf8'), fixtureStyle);
});

for (const platform of ['win32', 'darwin', 'linux'])
  test(`${platform} 接入手工 CCometixLine：使用默认命令`, async t => {
    const f = await fixture(t, {
      installed: true,
      platform,
      settings: {
        statusLine: { type: 'command', command: 'ccline.exe', padding: 5 },
        subagentStatusLine: { type: 'command', command: 'ccline.exe', padding: 2 },
      },
    });
    f.state.version = null;
    f.state.fail = 'ls';
    assert.equal((await f.apply({ task: 'install', selected: [{ id: 'ccline' }] })).state, 'done');
    assert.equal((await f.readSettings()).statusLine.command, 'ccline');
    assert.equal((await f.readSettings()).statusLine.padding, 5);
    assert.equal((await f.readSettings()).subagentStatusLine.command, 'ccline');
    assert.equal((await f.readSettings()).subagentStatusLine.padding, 2);
    assert.equal(await fs.readFile(f.styleFile, 'utf8'), asset);
    assert.deepEqual(
      f.calls.filter(call => call.kind === 'npm'),
      [],
    );
  });

test('重试 CCometixLine 重装：恢复子代理设置', async t => {
  const f = await fixture(t, {
    installed: true,
    style: fixtureStyle,
    settings: {
      statusLine: { type: 'command', command: 'ccline', padding: 4 },
      subagentStatusLine: { type: 'command', command: 'ccline', padding: 6 },
    },
  });
  f.state.fail = 'install';
  const first = await f.apply({ task: 'install', selected: [{ id: 'ccline', maintenance: 'reinstall' }] });
  assert.equal(first.state, 'partial');
  assert.equal((await f.readSettings()).subagentStatusLine, undefined);
  f.state.fail = null;
  const next = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(next.id)).state, 'done');
  assert.equal((await f.readSettings()).statusLine.padding, 4);
  assert.equal((await f.readSettings()).subagentStatusLine.padding, 6);
});

// 「继续 CCometixLine 复核」三处用例的共同序幕：装配 fixture、注入 npm-ls 单次中断、apply 至 partial
async function interruptedReinstall(t, options = {}) {
  const { installed = true, settings, maintenance = 'reinstall' } = options;
  const f = await fixture(t, { installed, ...(settings ? { settings } : {}) });
  let sawInstall = false;
  let interrupted = false;
  f.state.onCommand = async args => {
    if (args[0] === 'install') sawInstall = true;
    if (args[0] === 'ls' && sawInstall && !interrupted) {
      interrupted = true;
      throw new Error('npm-inspection-failed');
    }
  };
  const first = await f.apply({
    task: 'install',
    selected: [{ id: 'ccline', ...(maintenance ? { maintenance } : {}) }],
  });
  assert.equal(first.state, 'partial');
  return { f, first };
}

for (const [action, label] of [
  ['install', '安装'],
  ['update', '更新'],
  ['reinstall', '重装'],
])
  test(`继续 CCometixLine ${label}：仅复核程序`, async t => {
    const { f, first } = await interruptedReinstall(t, {
      installed: action !== 'install',
      settings: { statusLine: { type: 'command', command: 'ccline' } },
      maintenance: action === 'install' ? undefined : action,
    });
    assert.ok(first.remaining);
    const next = await f.ccw.plan({ resume: first.remaining });
    assert.ok(
      !next.items
        .flatMap(item => item.changes)
        .some(change => ['ccline-program-prepare', 'ccline-program-update'].includes(change.code)),
    );
    assert.equal((await f.ccw.apply(next.id)).state, 'done');
    assert.equal(npmOf(f, 'install').length, 1);
  });

test('切换 CCometixLine npm 根：阻止原更新', async t => {
  const f = await fixture(t, { installed: true });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline', maintenance: 'update' }] });
  assert.equal(plan.items[0].problem, null);
  f.state.npmRoot = path.join(f.root, 'other/node_modules');
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.items[0].effects.at(-1).code, 'program-scope-unconfirmed');
  assert.equal(npmOf(f, 'install').length, 0);
});

for (const platform of ['win32', 'darwin', 'linux'])
  test(`${platform} 安装 CCometixLine：固定 npm 前缀`, async t => {
    const f = await fixture(t, { platform });
    assert.equal((await f.apply({ task: 'install', selected: [{ id: 'ccline' }] })).state, 'done');
    assert.ok(
      f.calls
        .find(call => call.kind === 'npm' && call.target === 'install')
        .args.includes(`--prefix=${path.join(f.root, 'npm')}`),
    );
  });

test('继续 CCometixLine 复核：保护外部替换', async t => {
  const { f, first } = await interruptedReinstall(t);
  await fs.writeFile(f.binary, 'externally replaced binary');
  const next = await f.ccw.plan({ resume: first.remaining });
  const result = await f.ccw.apply(next.id);
  assert.equal(result.state, 'partial');
  assert.equal(result.items[0].effects.at(-1).code, 'program-changed');
  assert.equal(npmOf(f, 'install').length, 1);
});

test('继续 CCometixLine 复核：拒绝前缀漂移', async t => {
  const { f, first } = await interruptedReinstall(t);
  f.state.npmRoot = path.join(f.root, 'other/node_modules');
  const next = await f.ccw.plan({ resume: first.remaining });
  const result = await f.ccw.apply(next.id);
  assert.equal(result.state, 'partial');
  assert.equal(result.items[0].effects.at(-1).code, 'program-scope-unconfirmed');
  assert.equal(npmOf(f, 'install').length, 1);
});

test('保存 CCometixLine 安装快照失败：停止旧计划', async t => {
  const f = await fixture(t, { installed: true, settings: { statusLine: { type: 'command', command: 'ccline' } } });
  f.state.corruptBinary = true;
  const first = await f.apply({ task: 'install', selected: [{ id: 'ccline', maintenance: 'reinstall' }] });
  assert.equal(first.state, 'partial');
  assert.equal(first.items[0].effects.at(-1).code, 'program-installation-unconfirmed');
  assert.ok(first.remaining);
  assert.equal((await f.readSettings()).statusLine, undefined);
  assert.equal(npmOf(f, 'install').length, 1);
});

test('配置 CCometixLine：使用自定义目录', async t => {
  const f = await fixture(t, { customRoot: true, settings: { env: { TOKEN: 'fixture-only' } } });
  assert.equal((await f.apply({ task: 'install', selected: [{ id: 'ccline' }] })).state, 'done');
  assert.equal(await fs.readFile(f.styleFile, 'utf8'), asset);
  assert.deepEqual((await f.readSettings()).env, { TOKEN: 'fixture-only', CCLINE_HOME: f.cclineRoot });
  assert.equal(await exists(path.join(path.dirname(f.binary), 'config.toml')), false);
});

test('准备 CCometixLine：标记状态栏替换', async t => {
  const settings = { statusLine: { type: 'command', command: 'other-statusline' } };
  const f = await fixture(t, { customRoot: true, settings });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  assert.deepEqual(plan.items[0].changes, [
    { code: 'ccline-program-prepare', detail: '2.0.1' },
    { code: 'appearance-copy', detail: f.styleFile },
    { code: 'ccline-statusline-replace', detail: f.file },
    { code: 'ccline-root-configure', detail: f.cclineRoot },
  ]);
  assert.deepEqual(await f.readSettings(), settings);
});

test('读取 CCometixLine：沿用已配置目录', async t => {
  const f = await fixture(t, { installed: true });
  const custom = path.join(f.root, 'from settings');
  await fs.writeFile(f.file, JSON.stringify({ env: { CCLINE_HOME: custom } }));
  assert.equal((await f.apply({ task: 'install', selected: [{ id: 'ccline' }] })).state, 'done');
  assert.equal(await fs.readFile(path.join(custom, 'config.toml'), 'utf8'), asset);
  assert.equal(await exists(f.styleFile), false);
});

test('更新 CCometixLine：保留外观设置', async t => {
  const f = await fixture(t, {
    installed: true,
    style: fixtureStyle,
    settings: { statusLine: { command: 'another' }, keep: 1 },
  });
  const before = await fs.readFile(f.file, 'utf8');
  assert.equal((await f.apply({ task: 'install', selected: [{ id: 'ccline', maintenance: 'update' }] })).state, 'done');
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  assert.equal(await fs.readFile(f.styleFile, 'utf8'), fixtureStyle);
});

test('解除残留 CCometixLine：跳过程序检查', async t => {
  const f = await fixture(t, { settings: { statusLine: { type: 'command', command: 'ccline' }, keep: true } });
  f.state.fail = 'ls';
  assert.equal((await f.apply({ task: 'detach', selected: [{ id: 'ccline' }] })).state, 'done');
  assert.deepEqual(await f.readSettings(), { keep: true });
  assert.equal(f.calls.filter(call => call.kind === 'npm').length, 0);
});

test('解除 CCometixLine：保留程序与外观', async t => {
  const f = await fixture(t, {
    installed: true,
    style: fixtureStyle,
    settings: {
      statusLine: { type: 'command', command: 'ccline' },
      subagentStatusLine: { type: 'command', command: 'ccline.exe' },
      keep: true,
    },
  });
  const models = path.join(f.cclineRoot, 'models.toml');
  await fs.writeFile(models, 'fixture models');
  assert.equal((await f.apply({ task: 'detach', selected: [{ id: 'ccline' }] })).state, 'done');
  assert.deepEqual(await f.readSettings(), { keep: true });
  assert.equal(f.state.version, '2.0.1');
  assert.equal(await exists(f.binary), true);
  assert.equal(f.calls.filter(call => call.kind === 'npm').length, 0);
  assert.equal(await fs.readFile(f.styleFile, 'utf8'), fixtureStyle);
  assert.equal(await fs.readFile(models, 'utf8'), 'fixture models');
});

test('探测 npm 失败：仍可解除 CCometixLine', async t => {
  const f = await fixture(t, { installed: true, settings: { statusLine: { type: 'command', command: 'ccline' } } });
  f.state.fail = 'ls';
  const item = (await f.ccw.inspect()).items.find(item => item.id === 'ccline');
  assert.ok(item.problem);
  assert.ok(item.actions.includes('detach'));
  const npmCount = () => f.calls.filter(call => call.kind === 'npm').length;
  const before = npmCount();
  const result = await f.apply({ task: 'detach', selected: [{ id: 'ccline' }] });
  assert.equal(result.state, 'done');
  assert.ok(result.items[0].effects.some(item => item.code === 'disconnected'));
  assert.equal(npmCount(), before);
  assert.equal((await f.readSettings()).statusLine, undefined);
  assert.equal(await fs.readFile(f.binary, 'utf8'), 'fixture binary 2.0.1');
});

test('解除状态栏：保护外部修改', async t => {
  const f = await fixture(t, { settings: { statusLine: { type: 'command', command: 'ccline' } } });
  const plan = await f.ccw.plan({ task: 'detach', selected: [{ id: 'ccline' }] });
  await fs.writeFile(f.file, JSON.stringify({ statusLine: { type: 'command', command: 'ccline' }, keep: 'new' }));
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.deepEqual(await f.readSettings(), { keep: 'new' });
  await fs.writeFile(f.file, JSON.stringify({ statusLine: { type: 'command', command: 'ccline' } }));
  const next = await f.ccw.plan({ task: 'detach', selected: [{ id: 'ccline' }] });
  await fs.writeFile(f.file, JSON.stringify({ statusLine: { command: 'user-new-command' } }));
  assert.equal((await f.ccw.apply(next.id)).state, 'failed');
  assert.deepEqual((await f.readSettings()).statusLine, { command: 'user-new-command' });
});

test('安装 CCometixLine 缺少程序：保留配置', async t => {
  const f = await fixture(t);
  f.state.noBinary = true;
  const result = await f.apply({ task: 'install', selected: [{ id: 'ccline' }] });
  assert.equal(result.state, 'partial');
  assert.ok(result.items[0].effects.some(item => item.code === 'program-not-ready'));
  assert.deepEqual(await f.readSettings(), {});
  assert.equal(await exists(f.styleFile), false);
});

test('保存外观失败：保留程序结果', async t => {
  const f = await fixture(t, { settings: { statusLine: { command: 'original' } } });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  assert.equal(plan.items[0].problem, null);
  // 外观保存失败：初始化无法写入时保留程序结果；以占位目录使外观路径不可写读
  await fs.mkdir(f.styleFile, { recursive: true });
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'partial');
  assert.ok(result.items[0].effects.some(item => item.code === 'program-ready'));
  assert.deepEqual((await f.readSettings()).statusLine, { command: 'original' });
});

test('重复执行 CCometixLine：拒绝消费旧计划', async t => {
  const f = await fixture(t);
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  await f.ccw.inspect();
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.equal((await f.ccw.apply(plan.id)).state, 'failed');
  assert.equal(npmOf(f, 'install').length, 1);
});

test('读取旧版或无效外观：拒绝覆盖', async t => {
  for (const style of ['not valid = [', 'version = 1\n']) {
    const f = await fixture(t, { style });
    assert.notEqual((await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] })).items[0].problem, null);
    assert.equal(await fs.readFile(f.styleFile, 'utf8'), style);
    assert.equal(npmOf(f, 'install').length, 0);
  }
});

test('更新 CCometixLine：禁止降级', async t => {
  const f = await fixture(t, { installed: true });
  f.state.version = '2.1.0';
  assert.equal(
    (await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline', maintenance: 'update' }] })).items[0].problem,
    'newer-version-preserved',
  );
});

test('取消 CCometixLine：保留已完成步骤', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  const first = await f.ccw.apply(plan.id, controller.signal);
  assert.equal(first.state, 'cancelled');
  assert.equal(f.state.version, null);
  const nextController = new AbortController();
  f.state.onCommand = async args => {
    if (args[0] === 'install') nextController.abort();
  };
  const next = await f.ccw.plan({ resume: first.remaining });
  const result = await f.ccw.apply(next.id, nextController.signal);
  assert.equal(result.state, 'cancelled');
  assert.ok(result.items[0].effects.some(item => item.code === 'package-command-completed'));
  assert.deepEqual(await f.readSettings(), {});
});

test('写入链接配置：保留共享目标', async t => {
  const f = await fixture(t);
  const external = path.join(f.root, 'external.json');
  await fs.writeFile(external, '{"keep":true}');
  await fs.unlink(f.file);
  try {
    await fs.symlink(external, f.file, 'file');
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('OS 不允许测试进程创建文件链接');
      return;
    }
    throw error;
  }
  assert.equal(
    (await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] })).items[0].problem,
    'not-regular-file',
  );
  assert.equal(await fs.readFile(external, 'utf8'), '{"keep":true}');
});

test('安装 CCometixLine：贯通终端操作', async t => {
  const f = await fixture(t);
  const choices = [0, 1, 4];
  const titles = [];
  await runTerminal(f.ccw, {
    wait: (_title, work) => work(new AbortController().signal),
    handoff: work => work(),
    show() {},
    async select(page, change) {
      const index = page.rows.findIndex(row => row.label.startsWith('CCometixLine'));
      change({ kind: 'toggle', index });
      return { kind: 'submit', index: page.rows.length };
    },
    async choose(title, items) {
      titles.push(title);
      const value = choices.shift();
      assert.ok(value < items.length);
      return value;
    },
  });
  assert.equal(choices.length, 0);
  assert.equal(titles.filter(title => typeof title === 'string' && title.startsWith('变更预览')).length, 0);
  assert.ok(titles.some(title => typeof title !== 'string' && title.title === '运行结果 · 完成'));
  assert.equal(await fs.readFile(f.styleFile, 'utf8'), asset);
});

test('接入 CCometixLine：阻止配置根变化', async t => {
  const f = await fixture(t);
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  await fs.writeFile(f.file, JSON.stringify({ env: { CCLINE_HOME: path.join(f.root, 'different') } }));
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'partial');
  assert.equal(result.items[0].effects.at(-1).code, 'connection-changed');
  assert.equal((await f.readSettings()).statusLine, undefined);
});

test('重复确认 CCometixLine：仅执行一次', async t => {
  const f = await fixture(t);
  let release;
  const pending = new Promise(resolve => {
    release = resolve;
  });
  let entered;
  const started = new Promise(resolve => {
    entered = resolve;
  });
  f.state.onCommand = async args => {
    if (args[0] === 'install') {
      entered();
      await pending;
    }
  };
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  const first = f.ccw.apply(plan.id);
  await started;
  const second = await f.ccw.apply(plan.id);
  assert.equal(second.items[0].effects[0].code, 'operation-in-progress');
  release();
  assert.equal((await first).state, 'done');
  assert.equal(npmOf(f, 'install').length, 1);
});

test('取消 CCometixLine 配置：保留就绪程序', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  const events = [];
  const result = await f.ccw.apply(plan.id, controller.signal, event => {
    events.push(event);
    if (event.kind === 'effect' && event.effect.code === 'program-ready') controller.abort();
  });
  assert.equal(result.state, 'cancelled');
  assert.ok(result.remaining);
  assert.ok(result.items[0].effects.some(effect => effect.code === 'program-ready'));
  assert.deepEqual(await f.readSettings(), {});
  assert.equal(await exists(f.styleFile), false);
  assert.equal(events.at(-1).kind, 'finished');
  assert.equal(events.at(-1).result.state, 'cancelled');
});

test('复核 CCometixLine 版本：限时并支持取消', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let options;
  f.state.onExecute = (file, args, received) => {
    assert.equal(file, f.binary);
    assert.deepEqual(args, ['--version']);
    options = received;
    controller.abort();
    return { code: null, stdout: '', failed: true };
  };
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  const result = await f.ccw.apply(plan.id, controller.signal);
  assert.equal(options?.timeoutMs, 5000);
  assert.equal(options?.signal, controller.signal);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.items[0].effects.at(-1).code, 'cancelled');
  assert.equal(await exists(f.styleFile), false);
});

test('取消 CCometixLine 重装：保留恢复设置', async t => {
  const statusLine = { type: 'command', command: 'ccline', padding: 4 };
  const subagentStatusLine = { type: 'command', command: 'ccline', padding: 6 };
  const f = await fixture(t, { installed: true, style: fixtureStyle, settings: { statusLine, subagentStatusLine } });
  const controller = new AbortController();
  const first = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline', maintenance: 'reinstall' }] });
  const result = await f.ccw.apply(first.id, controller.signal, event => {
    if (event.kind === 'effect' && event.effect.code === 'disconnected') controller.abort();
  });
  assert.equal(result.state, 'cancelled');
  assert.deepEqual(await f.readSettings(), {});
  assert.equal(npmOf(f, 'install').length, 0);
  await f.ccw.inspect();
  await assert.rejects(f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] }), /unfinished-operation/);
  const next = await f.ccw.plan({ resume: result.remaining });
  assert.ok(
    next.items[0].changes.some(change => change.code === 'ccline-subagent-restore' && change.detail === f.file),
  );
  assert.equal((await f.ccw.apply(first.id)).items[0].effects[0].code, 'plan-unavailable');
  assert.equal((await f.ccw.apply(next.id)).state, 'done');
  assert.deepEqual(await f.readSettings(), { statusLine, subagentStatusLine });
});

test('执行 npm：保留参数字面值', async t => {
  const f = await createEnv(t);
  const cli = path.join(f.root, 'npm-cli.js');
  await f.write(cli, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const machine = createMachine({ ...process.env, npm_execpath: cli }, f.root);
  const result = await machine.npm(['--fixture', 'literal;echo', '$(no-command)', 'a b']);
  assert.equal(result.code, 0);
  assert.equal(result.failed, false);
  assert.deepEqual(JSON.parse(result.stdout), ['--fixture', 'literal;echo', '$(no-command)', 'a b']);
});

for (const [label, settings, expected] of [
  ['未装配套插件', undefined, 'ccline-companion-missing'],
  ['已装配套插件', { enabledPlugins: { 'cometix@ccline': true } }, 'ccline-companion-present'],
])
  test(`配套插件在场性可见：${label}`, async t => {
    const f = await fixture(t, { installed: true, ...(settings ? { settings } : {}) });
    const item = (await f.ccw.inspect()).items.find(entry => entry.id === 'ccline');
    assert.ok(
      item.facts.some(fact => fact.code === expected),
      expected,
    );
  });
