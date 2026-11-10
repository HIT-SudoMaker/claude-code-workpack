import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createCcw } from '../dist/ccw.js';
import { HOME_TITLE } from '../dist/render.js';
import { runTerminal } from './terminal-test.mjs';
import { createEnv, fail, ok, revision } from './env.mjs';

const plugin = 'github@claude-plugins-official';
const claudePackage = '@anthropic-ai/claude-code';

async function fixture(t) {
  const f = await createEnv(t, {
    layout: 'root',
    seed: {
      settings: { env: { KEEP: 'value' }, permissions: { allow: ['Read'], deny: ['Bash(rm *)'] } },
      state: { mcpServers: { external: { command: 'keep' } } },
    },
  });
  const recordsFile = path.join(f.claudeRoot, 'plugins/installed_plugins.json');
  const npmRoot = path.join(f.root, 'npm/node_modules');
  const claude = path.join(npmRoot, claudePackage, 'cli.js');
  await f.json(path.join(npmRoot, claudePackage, 'package.json'), { bin: { claude: 'cli.js' } });
  await f.write(claude, 'fixture program');
  const state = {
    // 插件安装后的记录回读失败：执行器按需置位，读取一次性生效
    failPluginSnapshot: false,
    snapshotArmed: false,
    // 写入后回读失败：以 calls 中该文件的 editJson 记录为触发条件，一次性生效
    failReadAfterEdit: null,
    readFailed: false,
  };
  const machine = f.machine({
    processes: async () => [],
    read: async (file, base) => {
      if (
        file === state.failReadAfterEdit &&
        !state.readFailed &&
        f.calls.some(call => call.kind === 'editJson' && call.target === file)
      ) {
        state.readFailed = true;
        throw new Error('fixture-read-failed');
      }
      if (file === recordsFile && state.snapshotArmed) {
        state.snapshotArmed = false;
        throw new Error('fixture-read-failed');
      }
      return base.read(file);
    },
    npm: async args =>
      ok(
        args[0] === 'root'
          ? npmRoot
          : JSON.stringify({
              dependencies: args.at(-1) === claudePackage ? { [claudePackage]: { version: '2.1.1' } } : {},
            }),
      ),
    execute: async (file, args, options, base) => {
      if (file === process.execPath && args[0] === claude) {
        const command = args.slice(1);
        if (command[0] === 'plugin' && command[1] === 'marketplace') {
          await f.json(path.join(f.claudeRoot, 'plugins/known_marketplaces.json'), {
            'claude-plugins-official': { source: { repo: 'anthropics/claude-plugins-official' } },
          });
        } else if (command[0] === 'plugin' && command[1] === 'install') {
          const installPath = path.join(f.claudeRoot, 'plugins/cache/github');
          await fs.mkdir(installPath, { recursive: true });
          await f.json(recordsFile, { plugins: { [plugin]: [{ scope: 'user', installPath, version: '1.0.0' }] } });
          await base.editJson(f.settingsFile, settings => {
            settings.enabledPlugins = { [plugin]: true };
          });
          if (state.failPluginSnapshot) state.snapshotArmed = true;
        }
        return ok();
      }
      if (file === process.execPath && args[1] === '--version') return ok('AMIRC 0.2.0');
      return fail();
    },
  });
  const ccw = f.ccw(machine);
  const prepare = async selection => {
    const plan = await ccw.plan({ task: 'install', selected: [selection] });
    assert.equal(plan.items[0].problem, null, JSON.stringify(plan));
    return plan;
  };
  return { ...f, state, machine, ccw, recordsFile, prepare };
}

test('继续设置确认：不重复写入', async t => {
  const f = await fixture(t);
  const plan = await f.prepare({
    id: 'settings',
    fields: { mode: 'api', baseUrl: 'https://gateway.example.test', secret: 'fixture-secret', language: '中文' },
  });
  f.state.failReadAfterEdit = f.settingsFile;
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  const resumed = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(resumed.id)).state, 'done');
  assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length, 1);
  assert.equal((await f.read(f.settingsFile)).env.ANTHROPIC_API_KEY, 'fixture-secret');
});

for (const id of ['mcp:context7'])
  test(`继续 ${id} 注册确认：不重复写入`, async t => {
    const f = await fixture(t);
    const plan = await f.prepare({ id });
    f.state.failReadAfterEdit = f.stateFile;
    const first = await f.ccw.apply(plan.id);
    assert.equal(first.state, 'partial');
    assert.ok(first.remaining);
    const resumed = await f.ccw.plan({ resume: first.remaining });
    assert.ok(resumed.items[0].changes.some(change => change.code === 'mcp-registration-confirm'));
    assert.equal(
      resumed.items[0].changes.some(change => change.code === 'mcp-register'),
      false,
    );
    assert.equal((await f.ccw.apply(resumed.id)).state, 'done');
    assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.stateFile).length, 1);
    assert.deepEqual((await f.read(f.stateFile)).mcpServers.external, { command: 'keep' });
  });

test('继续 MCP 重装：复核已移除注册', async t => {
  const f = await fixture(t);
  await f.json(f.stateFile, {
    mcpServers: { context7: { type: 'http', url: 'https://custom.example.test/mcp' }, external: { command: 'keep' } },
  });
  const plan = await f.prepare({ id: 'mcp:context7', maintenance: 'reinstall' });
  f.state.failReadAfterEdit = f.stateFile;
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  assert.equal((await f.read(f.stateFile)).mcpServers.context7, undefined);
  const resumed = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(resumed.id)).state, 'done');
  assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.stateFile).length, 2);
  assert.equal((await f.read(f.stateFile)).mcpServers.context7.url, 'https://mcp.context7.com/mcp');
  assert.deepEqual((await f.read(f.stateFile)).mcpServers.external, { command: 'keep' });
});

test('恢复 MCP 重装：保护新增注册', async t => {
  const f = await fixture(t);
  await f.json(f.stateFile, {
    mcpServers: { context7: { type: 'http', url: 'https://custom.example.test/mcp' } },
  });
  const plan = await f.prepare({ id: 'mcp:context7', maintenance: 'reinstall' });
  f.state.failReadAfterEdit = f.stateFile;
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  const replacement = { command: 'user-mcp', args: [] };
  await f.json(f.stateFile, { mcpServers: { context7: replacement } });
  const resumed = await f.ccw.plan({ resume: first.remaining });
  assert.equal((await f.ccw.apply(resumed.id)).state, 'failed');
  assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.stateFile).length, 1);
  assert.deepEqual((await f.read(f.stateFile)).mcpServers.context7, replacement);
});

test('保存插件快照失败：停止旧计划', async t => {
  const f = await fixture(t);
  f.state.failPluginSnapshot = true;
  const plan = await f.prepare({ id: `plugin:${plugin}`, fields: { secret: 'fixture-secret' } });
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'partial');
  assert.equal(first.remaining, undefined);
  assert.equal(first.items[0].effects.at(-1).code, 'program-installation-unconfirmed');
  assert.equal(
    f.calls.filter(call => call.kind === 'execute' && call.args.includes('plugin') && call.args.includes('install'))
      .length,
    1,
  );
  assert.equal((await f.read(f.settingsFile)).env.GITHUB_PERSONAL_ACCESS_TOKEN, undefined);
});

test('规划插件安装：不回显凭据', async t => {
  const f = await fixture(t);
  const plan = await f.prepare({ id: `plugin:${plugin}`, fields: { secret: 'fixture-secret' } });
  const first = await f.ccw.apply(plan.id);
  assert.equal(JSON.stringify(plan).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(first).includes('fixture-secret'), false);
});

test('继续 GitHub 凭据确认：不重复写入', async t => {
  const f = await fixture(t);
  const plan = await f.prepare({ id: `plugin:${plugin}`, fields: { secret: 'fixture-secret' } });
  f.state.failReadAfterEdit = f.settingsFile;
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  const resumed = await f.ccw.plan({ resume: first.remaining });
  assert.ok(resumed.items[0].changes.some(change => change.code === 'plugin-confirm'));
  assert.equal(
    resumed.items[0].changes.some(change => change.code === 'plugin-install'),
    false,
  );
  assert.equal(
    resumed.items[0].changes.some(change => change.code === 'github-credential-configure'),
    false,
  );
  assert.equal((await f.ccw.apply(resumed.id)).state, 'done');
  assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length, 1);
  assert.equal(
    f.calls.filter(call => call.kind === 'execute' && call.args.includes('plugin') && call.args.includes('install'))
      .length,
    1,
  );
});

for (const [type, url] of [
  ['streamable-http', 'https://custom.example.test/mcp'],
  ['ws', 'wss://custom.example.test/mcp'],
])
  test(`保留 ${type} 接入：沿用已有来源`, async t => {
    const f = await fixture(t);
    const registration = { type, url, headers: { Authorization: 'Bearer fixture-secret' } };
    await f.json(f.stateFile, { mcpServers: { context7: registration } });
    const view = await f.ccw.inspect();
    assert.equal(view.items.find(item => item.id === 'mcp:context7').problem, undefined);
    const plan = await f.prepare({ id: 'mcp:context7' });
    assert.equal((await f.ccw.apply(plan.id)).state, 'done');
    assert.deepEqual((await f.read(f.stateFile)).mcpServers.context7, registration);
  });

test('修复插件载荷：恢复缺失文件', async t => {
  const f = await fixture(t);
  const id = 'code-simplifier@claude-plugins-official';
  const installPath = path.join(f.claudeRoot, 'plugins/cache', id);
  await f.json(f.recordsFile, { plugins: { [id]: [{ scope: 'user', version: '1.0.0', installPath }] } });
  const settings = await f.read(f.settingsFile);
  settings.enabledPlugins = { [id]: false };
  await f.json(f.settingsFile, settings);
  // 局部 machine 覆盖：目标 fixture 的安装应答固定 github 插件，此处按本测试插件模拟 claude CLI 安装命令
  const program = path.join(f.root, 'npm/node_modules', claudePackage, 'cli.js');
  const inner = f.machine.execute;
  f.machine.execute = async (file, args, options) => {
    if (
      file === process.execPath &&
      args[0] === program &&
      args[1] === 'plugin' &&
      args[2] === 'install' &&
      args[3] === id
    ) {
      await f.write(path.join(installPath, '.claude-plugin/plugin.json'), '{}');
      const records = await f.read(f.recordsFile);
      records.plugins[id] = [{ scope: 'user', version: '1.0.0', installPath }];
      await f.json(f.recordsFile, records);
      const current = await f.read(f.settingsFile);
      current.enabledPlugins[id] = true;
      await f.json(f.settingsFile, current);
      return ok();
    }
    return inner(file, args, options);
  };
  const plans = [];
  const results = [];
  let homes = 0;
  const ccw = {
    ...f.ccw,
    async inspect() {
      const view = await f.ccw.inspect();
      return { ...view, items: view.items.filter(item => item.id === `plugin:${id}`) };
    },
    async plan(selections) {
      plans.push(selections);
      return f.ccw.plan(selections);
    },
    async apply(...args) {
      const result = await f.ccw.apply(...args);
      results.push(result);
      return result;
    },
  };
  await runTerminal(ccw, {
    wait: (_title, work) => work(new AbortController().signal),
    show() {},
    async choose(title) {
      if (title === HOME_TITLE) return homes++ ? 4 : 0;
      return 1;
    },
    async select(page, change) {
      assert.match(page.rows[0].detail, /文件缺失/);
      change({ kind: 'toggle', index: 0 });
      return { kind: 'submit', index: 1 };
    },
  });
  assert.equal(plans[0].task, 'install');
  assert.equal(results[0].state, 'done');
  assert.ok(await fs.stat(path.join(installPath, '.claude-plugin/plugin.json')));
  assert.equal(
    f.calls.some(call => call.kind === 'execute' && call.args.includes('plugin') && call.args.includes('enable')),
    false,
  );
  assert.equal(
    f.calls.some(call => call.kind === 'execute' && call.args.includes('plugin') && call.args.includes('uninstall')),
    false,
  );
});

test('更换插件市场：阻止旧安装计划', async t => {
  const f = await fixture(t);
  const id = 'code-simplifier@claude-plugins-official';
  const markets = path.join(f.claudeRoot, 'plugins/known_marketplaces.json');
  await f.json(markets, { 'claude-plugins-official': { source: { repo: 'anthropics/claude-plugins-official' } } });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: `plugin:${id}` }] });
  assert.equal(plan.items[0].problem, null);
  await f.json(markets, { 'claude-plugins-official': { source: { repo: 'other-owner/other-market' } } });
  const beforeCalls = f.calls.length;
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.items[0].effects.at(-1).code, 'marketplace-source-conflict');
  assert.equal(
    f.calls
      .slice(beforeCalls)
      .some(call => call.kind === 'execute' && call.args.includes('plugin') && call.args.includes('install')),
    false,
  );
  assert.deepEqual(await f.read(markets), {
    'claude-plugins-official': { source: { repo: 'other-owner/other-market' } },
  });
});

test('安装 MCP：保留现有接入', async t => {
  const f = await fixture(t);
  const current = { command: 'existing context command', args: ['custom'], env: { TOKEN: 'fixture-only' } };
  await f.json(f.stateFile, { mcpServers: { context7: current, external: { command: 'keep' } } });
  const view = await f.ccw.inspect();
  assert.equal(view.items.find(item => item.id === 'mcp:external').canInstall, false);
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'mcp:context7' }] });
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.deepEqual((await f.read(f.stateFile)).mcpServers.context7, current);
});

test('重试技能安装：固定剩余成员', async t => {
  const f = await fixture(t);
  const state = { failReplaceTree: null, forbidSource: false };
  // 局部 machine 覆盖：方案载荷与修订由本测试固定应答，replaceTree 按成员基名注入写入失败
  const baseReplaceTree = f.machine.replaceTree;
  const baseExecute = f.machine.execute;
  const machine = {
    ...f.machine,
    async replaceTree(directory, files, expected, preserveAt) {
      if (state.failReplaceTree !== null && path.basename(directory) === state.failReplaceTree)
        throw new Error('fixture-write-failed');
      return baseReplaceTree(directory, files, expected, preserveAt);
    },
    async source(repository, sourceRevision, folder) {
      if (state.forbidSource) throw new Error('unexpected-source-refresh');
      if (folder === '.agents/skills' || folder === 'skills')
        return ['engineering/tdd', 'engineering/code-review'].flatMap(name => [
          { path: `${name}/SKILL.md`, data: Buffer.from(`---\nname: ${path.basename(name)}\n---\n`) },
          { path: `${name}/assets/icon.bin`, data: Uint8Array.from([0, 128, 255]) },
        ]);
      throw new Error('unexpected source');
    },
    async execute(file, args, options) {
      if (file === 'git' && args[0] === 'ls-remote') return ok(`${revision}\tHEAD\n`);
      return baseExecute(file, args, options);
    },
  };
  const ccw = createCcw({
    machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform: process.platform,
  });
  state.failReplaceTree = 'code-review';
  const plan = await ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  const first = await ccw.apply(plan.id);
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  state.failReplaceTree = null;
  state.forbidSource = true;
  const rest = await ccw.plan({ resume: first.remaining });
  const result = await ccw.apply(rest.id);
  assert.equal(result.state, 'done');
  assert.equal(
    result.items[0].effects.some(effect => effect.detail === 'tdd'),
    false,
  );
  assert.ok(await fs.readFile(path.join(f.claudeRoot, 'skills/code-review/SKILL.md')));
});

test('卸载官方插件：仅停用用户入口', async t => {
  const f = await fixture(t);
  const id = 'frontend-design@claude-plugins-official';
  const installPath = path.join(f.claudeRoot, 'plugins/cache', id);
  await f.write(path.join(installPath, '.claude-plugin/plugin.json'), '{}');
  await f.json(f.recordsFile, { plugins: { [id]: [{ scope: 'user', version: '1.0.0', installPath }] } });
  const settings = await f.read(f.settingsFile);
  settings.enabledPlugins = { [id]: true };
  await f.json(f.settingsFile, settings);
  const records = await f.read(f.recordsFile);
  const project = { scope: 'project', projectPath: '/other/project', installPath: '/other/plugin' };
  records.plugins[id].push(project);
  await f.json(f.recordsFile, records);
  f.calls.length = 0;
  const plan = await f.ccw.plan({ task: 'detach', selected: [{ id: `plugin:${id}` }] });
  assert.ok(
    plan.items.every(item => item.problem === null),
    JSON.stringify(plan),
  );
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.deepEqual((await f.read(f.recordsFile)).plugins[id], records.plugins[id]);
  assert.equal((await f.read(f.settingsFile)).enabledPlugins[id], false);
  assert.equal(
    f.calls.some(call => call.kind === 'execute' && call.args.includes('plugin')),
    false,
  );
});

test('更换插件市场：不阻止再次卸载', async t => {
  const f = await fixture(t);
  const id = 'frontend-design@claude-plugins-official';
  const settings = await f.read(f.settingsFile);
  settings.enabledPlugins = { [id]: true };
  await f.json(f.settingsFile, settings);
  await f.json(path.join(f.claudeRoot, 'plugins/known_marketplaces.json'), {
    'claude-plugins-official': { source: { repo: 'unrelated/repository' } },
  });
  assert.equal(
    (await f.ccw.plan({ task: 'install', selected: [{ id: `plugin:${id}` }] })).items[0].problem,
    'marketplace-source-conflict',
  );
  const config = await f.read(f.settingsFile);
  config.enabledPlugins[id] = true;
  await f.json(f.settingsFile, config);
  const retry = await f.ccw.plan({ task: 'detach', selected: [{ id: `plugin:${id}` }] });
  assert.ok(
    retry.items.every(item => item.problem === null),
    JSON.stringify(retry),
  );
  assert.equal((await f.ccw.apply(retry.id)).state, 'done');
});
