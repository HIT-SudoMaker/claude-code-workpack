import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { HOME_TITLE } from '../dist/render.js';
import { runTerminal } from './terminal-test.mjs';
import {
  npmConfig,
  attribution,
  createEnv,
  exists,
  fail,
  ok,
  pluginMarketplaceFiles,
  releaseContract,
  revision,
} from './env.mjs';

const defaultEnv = {
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_INSTALLATION_CHECKS: '1',
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

async function fixture(t, { platform = process.platform } = {}) {
  // layout 'root'：状态文件按 claudeRoot/.claude.json 派生；cclineRoot 仍取 home/.claude/ccline，与活动配置根分离
  const f = await createEnv(t, {
    layout: 'root',
    seed: {
      settings: {},
      state: { projects: { untouched: { mcpServers: { projectOnly: { command: 'keep' } } } } },
    },
  });
  const cclineRoot = path.join(f.home, '.claude/ccline');
  const npmRoot = path.join(f.root, 'npm/node_modules');
  const settings = f.settingsFile;
  const stateFile = f.stateFile;
  const native = path.join(f.home, '.local/bin', platform === 'win32' ? 'claude.exe' : 'claude');
  const uv = path.join(f.home, '.local/bin', platform === 'win32' ? 'uv.exe' : 'uv');
  const officeNative =
    platform === 'win32'
      ? path.join(f.home, 'AppData/Local/OfficeCli/officecli.exe')
      : path.join(f.home, '.local/bin/officecli');
  const officeAsset = `officecli-${platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'}-${process.arch}${platform === 'win32' ? '.exe' : ''}`;
  const officePayload = Buffer.from('OfficeCLI native fixture');
  const officeDigest = createHash('sha256').update(officePayload).digest('hex');
  const release = releaseContract({
    tag: 'v1.0.123',
    asset: officeAsset,
    digest: officeDigest,
    revision,
    also: url => {
      if (url.includes('pypi.org')) return JSON.stringify({ info: { version: '1.2.3' } });
    },
  });
  const officeRelease = release.release;
  const toolsBin = path.join(f.root, 'tools bin');
  const packages = new Map();
  const state = {
    fail: '',
    stableVersion: '2.1.318',
    nativeVersion: '2.1.318',
    fetchResponse: null, // 整体替换 fetchText 响应
    npmDelay: 0, // npm 探测延迟（毫秒），用于并发测量
    npmActive: 0,
    npmPeak: 0,
    onNpm: null, // npm 调用钩子（可返回阻塞 promise）
    pluginHelp: null, // 重装探针应答（null＝支持 --keep-data 的正常帮助输出）
  };
  const readJson = async file => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  };
  await f.write(uv, 'uv fixture');
  const base = f.machine({
    locate: async command => {
      if (command === 'claude')
        return await fs.stat(native).then(
          () => [native],
          () => [],
        );
      if (command === 'officecli') {
        const binary = packages.has('@officecli/officecli')
          ? path.join(npmRoot, '@officecli/officecli/vendor', platform === 'win32' ? 'officecli.exe' : 'officecli')
          : officeNative;
        return await fs.stat(binary).then(
          () => [binary],
          () => [],
        );
      }
      if (command === 'uv') return [uv];
      return [];
    },
    processes: async () => [],
    npm: async (args, options) => {
      state.npmActive++;
      state.npmPeak = Math.max(state.npmPeak, state.npmActive);
      try {
        if (state.npmDelay) await new Promise(resolve => setTimeout(resolve, state.npmDelay));
        if (state.onNpm) await state.onNpm(args, options);
        const last = args.at(-1);
        if (state.fail === `npm:${args[0]}`) return fail();
        if (args[0] === 'config') return npmConfig(args);
        if (args[0] === 'root') return ok(npmRoot);
        if (args[0] === 'ls')
          return ok(
            JSON.stringify({ dependencies: packages.has(last) ? { [last]: { version: packages.get(last) } } : {} }),
          );
        if (args[0] === 'view')
          return ok(
            JSON.stringify(
              args[1].includes('officecli')
                ? '1.0.123'
                : args[1].includes('claude-code')
                  ? args[1].endsWith('@stable')
                    ? state.stableVersion
                    : '2.9.999'
                  : '2.0.1',
            ),
          );
        if (args[0] === 'install') {
          const split = last.lastIndexOf('@');
          const name = last.slice(0, split);
          const version = last.slice(split + 1);
          packages.set(name, version);
          await f.write(
            path.join(npmRoot, name, 'package.json'),
            JSON.stringify({ name, version, bin: { claude: 'cli.js' } }),
          );
          await f.write(
            name === '@cometix/ccline'
              ? path.join(cclineRoot, platform === 'win32' ? 'ccline.exe' : 'ccline')
              : path.join(
                  npmRoot,
                  name,
                  name === '@officecli/officecli' ? `vendor/officecli${platform === 'win32' ? '.exe' : ''}` : 'cli.js',
                ),
            'binary fixture',
          );
          return ok();
        }
        throw new Error(`Unexpected npm command ${args[0]}`);
      } finally {
        state.npmActive--;
      }
    },
    execute: async (executable, originalArgs) => {
      const args = [...originalArgs];
      if (executable === path.join(cclineRoot, platform === 'win32' ? 'ccline.exe' : 'ccline')) {
        assert.deepEqual(args, ['--version']);
        return ok('ccline 2.0.1');
      }
      if (executable === officeNative || executable.includes(`${path.sep}@officecli${path.sep}officecli${path.sep}`)) {
        assert.deepEqual(args, ['--version']);
        return ok('OfficeCLI 1.0.123');
      }
      if (args[0]?.endsWith('cli.js')) args.shift();
      if (executable === 'git') return ok(`${revision}\tHEAD\n`);
      if (executable === uv) {
        if (args[1] === 'list')
          return ok(
            await fs.stat(path.join(toolsBin, platform === 'win32' ? 'serena.exe' : 'serena')).then(
              () => 'serena-agent v1.2.3\n- serena',
              () => '',
            ),
          );
        if (args[1] === 'dir') return ok(toolsBin);
        if (args[1] === 'install') {
          await f.write(path.join(toolsBin, platform === 'win32' ? 'serena.exe' : 'serena'), 'serena fixture');
          return ok();
        }
      }
      if (executable === path.join(toolsBin, platform === 'win32' ? 'serena.exe' : 'serena')) return ok();
      if (executable === native || args[0] === 'plugin' || args[0] === '--version') {
        if (args[0] === '--version')
          return ok(
            `${executable === native ? state.nativeVersion : (packages.get('@anthropic-ai/claude-code') ?? state.nativeVersion)} (Claude Code)`,
          );
        if (args[0] === 'install') {
          state.nativeVersion = args[1];
          await f.write(native, 'updated native fixture');
          await f.write(path.join(f.home, '.local/share/claude/versions/1'), 'updated native fixture');
          return ok();
        }
        if (args[1] === 'marketplace') {
          await f.write(
            path.join(f.claudeRoot, 'plugins/known_marketplaces.json'),
            JSON.stringify({
              'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } },
            }),
          );
          return ok();
        }
        if (args[1] === 'uninstall' && args[2] === '--help')
          return state.pluginHelp ? state.pluginHelp() : ok('  --keep-data  Keep plugin data when uninstalling\n');
        if (args[1] === 'uninstall') {
          const id = args[2];
          const config = await readJson(settings);
          const file = path.join(f.claudeRoot, 'plugins/installed_plugins.json');
          const records = await readJson(file);
          if (records.plugins) delete records.plugins[id];
          if (config.enabledPlugins) delete config.enabledPlugins[id];
          await f.write(file, JSON.stringify(records));
          await f.write(settings, JSON.stringify(config));
          return ok();
        }
        const id = args[2];
        const config = await readJson(settings);
        config.enabledPlugins ??= {};
        const file = path.join(f.claudeRoot, 'plugins/installed_plugins.json');
        const records = await readJson(file);
        records.version = 2;
        records.plugins ??= {};
        const installPath = path.join(f.claudeRoot, 'plugins/cache', id);
        await f.write(path.join(installPath, '.claude-plugin/plugin.json'), '{}');
        records.plugins[id] = [{ scope: 'user', version: '1.0.0', installPath, gitCommitSha: revision }];
        config.enabledPlugins[id] = true;
        await f.write(file, JSON.stringify(records));
        await f.write(settings, JSON.stringify(config));
        return ok();
      }
      throw new Error(`Unexpected command: ${executable}`);
    },
  });
  const machine = {
    ...base,
    userPathContains: async () => true,
    async ensureUserPath() {},
    async fetchBytes(url) {
      assert.equal(url, officeRelease + officeAsset);
      return officePayload;
    },
    async fetchText(url) {
      f.calls.push({ kind: 'fetch', target: url });
      if (state.fetchResponse !== null) return state.fetchResponse;
      return release.fetchText(url);
    },
    async source(repository, commit, folder) {
      if (folder === '.') return pluginMarketplaceFiles();
      if (folder === '.agents/skills' || folder === 'skills')
        return (
          repository.includes('mattpocock')
            ? ['engineering/tdd', 'engineering/code-review']
            : ['ssre2-design', 'ssre2-review']
        ).flatMap(name => [
          { path: `${name}/SKILL.md`, data: Buffer.from(`---\nname: ${path.basename(name)}\n---\n`) },
          { path: `${name}/assets/icon.bin`, data: Uint8Array.from([0, 128, 255]) },
        ]);
      return [
        { path: 'SKILL.md', data: Buffer.from(`---\nname: ${path.basename(folder)}\n---\nSee reference/details.md`) },
        { path: 'reference/details.md', data: Buffer.from('independent reference bytes') },
        { path: 'assets/icon.bin', data: Uint8Array.from([0, 128, 255]) },
      ];
    },
  };
  const ccw = f.ccw(machine, { cclineRoot, platform });
  const apply = async input => {
    const plan = await ccw.plan(input);
    assert.ok(
      plan.items.every(item => item.problem === null),
      JSON.stringify(plan),
    );
    return ccw.apply(plan.id);
  };
  return {
    ...f,
    native,
    settings,
    stateFile,
    machine,
    ccw,
    state,
    packages,
    readJson,
    apply,
  };
}

test('安装完整套件：写入活动配置根', async t => {
  const f = await fixture(t);
  const selections = [
    { id: 'claude' },
    {
      id: 'settings',
      fields: {
        mode: 'api',
        baseUrl: 'https://example.test/api',
        secret: 'fixture-secret',
        model: 'fixture-model',
        language: '中文',
      },
    },
    ...['code-simplifier', 'frontend-design', 'github', 'mcp-server-dev', 'skill-creator'].map(name => ({
      id: `plugin:${name}@claude-plugins-official`,
    })),
    { id: 'mcp:context7' },
    { id: 'mcp:serena' },
    { id: 'skill-set:ssre2' },
    { id: 'skill-set:mattpocock' },
    { id: 'officecli' },
    { id: 'ccline' },
  ];
  const plan = await f.ccw.plan({ task: 'install', selected: selections });
  assert.ok(
    plan.items.every(item => item.problem === null),
    JSON.stringify(plan),
  );
  for (const value of ['fixture-secret', 'https://example.test/api', 'fixture-model'])
    assert.equal(JSON.stringify(plan).includes(value), false);
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'done', JSON.stringify(result));
  const settings = await f.readJson(f.settings);
  assert.equal(settings.env.ANTHROPIC_API_KEY, 'fixture-secret');
  assert.equal(Object.keys(settings.enabledPlugins).length, 5);
  assert.equal(settings.statusLine.command, 'ccline');
  const state = await f.readJson(f.stateFile);
  assert.equal(state.mcpServers.serena.args.includes('--project-from-cwd'), true);
  assert.equal(state.projects.untouched.mcpServers.projectOnly.command, 'keep');
  for (const name of ['ssre2-design', 'ssre2-review', 'tdd', 'code-review', 'officecli'])
    assert.deepEqual(
      await fs.readFile(path.join(f.claudeRoot, 'skills', name, 'assets/icon.bin')),
      Buffer.from([0, 128, 255]),
    );
  assert.equal(
    await fs.stat(path.join(f.home, '.agents')).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.equal(
    f.calls.some(call => call.kind === 'execute' && call.args[0] === 'mcp' && ['list', 'get'].includes(call.args[1])),
    false,
  );
});

test('重装插件：保留数据证据未知时阻断', async t => {
  const f = await fixture(t);
  const setup = await f.apply({
    task: 'install',
    selected: [{ id: 'claude' }, { id: 'plugin:github@claude-plugins-official' }],
  });
  assert.equal(setup.state, 'done', JSON.stringify(setup));
  for (const probe of [fail(), { code: 0, stdout: '', failed: true }]) {
    f.state.pluginHelp = () => probe;
    const blocked = await f.ccw.plan({
      task: 'install',
      selected: [{ id: 'plugin:github@claude-plugins-official', maintenance: 'reinstall' }],
    });
    assert.equal(blocked.items[0].problem, 'plugin-keep-data-unconfirmed');
  }
});

test('重装插件：只在证明支持保留数据时执行', async t => {
  const f = await fixture(t);
  const setup = await f.apply({
    task: 'install',
    selected: [{ id: 'claude' }, { id: 'plugin:github@claude-plugins-official' }],
  });
  assert.equal(setup.state, 'done', JSON.stringify(setup));
  for (const [probe, change, hasFlag] of [[null, 'plugin-keep-data', true]]) {
    f.state.pluginHelp = probe;
    f.calls.length = 0;
    const plan = await f.ccw.plan({
      task: 'install',
      selected: [{ id: 'plugin:github@claude-plugins-official', maintenance: 'reinstall' }],
    });
    assert.equal(plan.items[0].problem, null, JSON.stringify(plan));
    assert.ok(plan.items[0].changes.some(entry => entry.code === change));
    const result = await f.ccw.apply(plan.id);
    assert.equal(result.state, 'done', JSON.stringify(result));
    const uninstalls = f.calls.filter(
      call => call.kind === 'execute' && call.args.includes('uninstall') && !call.args.includes('--help'),
    );
    assert.equal(uninstalls.length, 1);
    assert.equal(uninstalls[0].args.includes('--keep-data'), hasFlag);
  }
});

test('显示安装进度：区分失败与跳过', async t => {
  const f = await fixture(t, { platform: 'win32' });
  const screens = [];
  let homes = 0;
  let resultView;
  let detailView;
  let openedDetails = false;
  f.state.fail = 'npm:install';
  f.state.fetchResponse = '<html>installer unavailable</html>';
  const selected = ['Claude Code', 'GitHub', 'Context7'];
  await runTerminal(f.ccw, {
    wait: (_title, work) => work(new AbortController().signal),
    async handoff() {
      assert.fail('普通安装不能暂停整个 TUI');
    },
    show(text) {
      screens.push(text);
    },
    async select(page, change) {
      for (const name of selected)
        change({ kind: 'toggle', index: page.rows.findIndex(row => row.label.startsWith(name)) });
      return { kind: 'submit', index: page.rows.length };
    },
    async choose(title) {
      if (title === HOME_TITLE) return homes++ ? 4 : 0;
      if (title === '选择结果') return 0;
      if (typeof title === 'string' && title.startsWith('未完成任务')) return 4;
      assert.equal(typeof title, 'object');
      if (title.title === '结果详情') {
        detailView = title;
        return 0;
      }
      resultView = title;
      assert.equal(title.title, '运行结果 · 部分完成');
      assert.match(title.summary, /完成 1 · 失败 1 · 跳过 1/);
      if (!openedDetails) {
        openedDetails = true;
        return 2;
      }
      return 1;
    },
  });
  assert.ok(
    screens.some(
      view =>
        view.summary === '处理 0/3 · 完成 0 · 失败 0 · 跳过 0' &&
        view.rows.some(row => row.id === 'claude' && row.symbol === '▶' && row.status === '执行中'),
    ),
  );
  const summary = screens.at(-1);
  assert.equal(summary.summary, '处理 3/3 · 完成 1 · 失败 1 · 跳过 1');
  assert.deepEqual(
    summary.rows.map(row => [row.symbol, row.status, row.title]),
    [
      ['✕', '安装失败', 'Claude Code'],
      ['○', '已跳过', 'GitHub'],
      ['✔', '完成', 'Context7'],
    ],
  );
  assert.ok(summary.rows.every(row => row.details.length === 0));
  assert.ok(detailView.rows[0].details.some(detail => detail.text.includes('installer-unavailable')));
  assert.deepEqual(
    resultView.rows.map(row => [row.symbol, row.status, row.title]),
    summary.rows.map(row => [row.symbol, row.status, row.title]),
  );
  assert.equal((await f.readJson(f.stateFile)).mcpServers.context7.type, 'http');
});
test('显示技能安装项：仅列整套入口', async t => {
  const f = await fixture(t);
  let home = 0;
  await runTerminal(f.ccw, {
    wait: (_title, work) => work(new AbortController().signal),
    async choose() {
      return home++ ? 4 : 0;
    },
    async select(page, change) {
      const skills = page.rows.filter(row => row.group === 'Skills');
      assert.deepEqual(
        skills.map(row => row.label),
        ['AMIRC Research Skill', 'Matt Pocock/Skills', 'HIT-SudoMaker/SSRE2'],
      );
      assert.equal(page.rows.filter(row => row.group === 'Plugins').length, 5);
      assert.doesNotMatch(JSON.stringify(page), /工程技能|科学设计|科学审查|ssre2-design|ssre2-review/);
      assert.doesNotMatch(JSON.stringify(change({ kind: 'all' })), /→ 更新|→ 重装/);
      return { kind: 'cancel', index: 0 };
    },
  });
});

test('执行卸载：沿用产品与成员名称', async t => {
  const f = await fixture(t);
  await f.apply({ task: 'install', selected: [{ id: 'mcp:context7' }, { id: 'skill-set:ssre2' }] });
  const selected = ['Context7', 'ssre2-design'];
  let homes = 0;
  let results = 0;
  await runTerminal(f.ccw, {
    wait: (_title, work) => work(new AbortController().signal),
    show() {},
    async select(page, change) {
      for (const name of selected) {
        const index = page.rows.findIndex(row => row.label === name);
        assert.ok(index >= 0, `缺少卸载项：${name}`);
        change({ kind: 'toggle', index });
      }
      return { kind: 'submit', index: page.rows.length };
    },
    async choose(title) {
      if (typeof title === 'string') {
        if (title === HOME_TITLE) return homes++ ? 4 : 2;
        assert.ok(title.startsWith('变更预览'));
        for (const name of selected) assert.ok(title.includes(` ${name}\n`));
        return 0;
      }
      results++;
      assert.deepEqual(
        title.rows.map(row => row.title),
        selected,
      );
      return 1;
    },
  });
  assert.equal(results, 1);
});

test('识别手工 Claude：保留程序版本根', async t => {
  const f = await fixture(t);
  await f.write(f.native, 'manual binary');
  await f.write(path.join(f.home, '.local/share/claude/versions/keep'), 'different file');
  const item = (await f.ccw.inspect()).items.find(item => item.kind === 'claude');
  assert.ok(item.id.includes(':manual:'));
  assert.equal(item.actions.includes('uninstall'), false);
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: item.id }] });
  assert.equal(plan.items[0].problem, 'channel-not-supported');
  assert.equal((await f.ccw.apply(plan.id)).state, 'failed');
  assert.equal(await fs.readFile(f.native, 'utf8'), 'manual binary');
  assert.equal(await fs.readFile(path.join(f.home, '.local/share/claude/versions/keep'), 'utf8'), 'different file');
  assert.equal(
    f.calls.some(call => call.kind === 'npm' && call.target === 'uninstall'),
    false,
  );
});

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform} 安装 Claude：固定 npm 版本`, async t => {
    const f = await fixture(t, { platform });
    await f.write(f.settings, '{"language":"zh"}');
    const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
    const preparedFetches = f.calls.filter(call => call.kind === 'fetch').length;
    assert.equal((await f.ccw.apply(plan.id)).state, 'done');
    assert.equal(f.calls.filter(call => call.kind === 'fetch').length, preparedFetches);
    assert.ok(
      f.calls.some(
        call =>
          call.kind === 'npm' &&
          call.target === 'install' &&
          call.args.at(-1) === '@anthropic-ai/claude-code@2.1.318' &&
          call.args.includes('--include=optional'),
      ),
    );
    assert.equal(
      f.calls.some(call => call.target === 'cmd.exe' || call.target === 'powershell.exe'),
      false,
    );
    const item = (await f.ccw.inspect()).items.find(item => item.kind === 'claude');
    assert.ok(item.id.includes(':npm:'));
    const installedSettings = await f.readJson(f.settings);
    assert.deepEqual(installedSettings, {
      language: 'zh',
      permissions: { defaultMode: 'bypassPermissions' },
      attribution,
      env: { ...defaultEnv, ...(platform === 'win32' ? { CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' } : {}) },
    });
    const removal = await f.ccw.plan({ task: 'uninstall', selected: [{ id: item.id }] });
    assert.equal(removal.items[0].problem, null);
    assert.equal(removal.items[0].action, 'uninstall');
    assert.ok(removal.items[0].changes.some(change => change.code === 'program-uninstall'));
    assert.deepEqual(await f.readJson(f.settings), installedSettings);
    assert.equal(f.packages.has('@anthropic-ai/claude-code'), true);
  });
  test(`${platform} 更新原生 Claude：沿用原渠道`, async t => {
    const f = await fixture(t, { platform });
    await f.write(f.settings, '{"language":"zh"}');
    await f.write(f.native, 'existing native');
    await f.write(path.join(f.home, '.local/share/claude/versions/1'), 'existing native');
    const item = (await f.ccw.inspect()).items.find(item => item.kind === 'claude');
    assert.ok(item.id.includes(':native:'));
    assert.equal(
      (await f.apply({ task: 'install', selected: [{ id: item.id, maintenance: 'update' }] })).state,
      'done',
    );
    assert.ok(
      f.calls.some(
        call =>
          call.kind === 'execute' &&
          call.target === f.native &&
          call.args[0] === 'install' &&
          call.args[1] === '2.1.318',
      ),
    );
    assert.equal(
      f.calls.some(call => call.kind === 'npm' && call.target === 'install'),
      false,
    );
    const removal = await f.ccw.plan({ task: 'uninstall', selected: [{ id: item.id }] });
    assert.equal(removal.items[0].problem, null);
    assert.equal(removal.items[0].action, 'uninstall');
    assert.ok(removal.items[0].changes.some(change => change.code === 'program-uninstall'));
    assert.deepEqual(await f.readJson(f.settings), { language: 'zh' });
    assert.equal(await exists(f.native), true);
  });
}

test('取消 npm 安装：跳过备用渠道', async t => {
  const f = await fixture(t, { platform: 'win32' });
  const controller = new AbortController();
  f.faults.npm.set('install', async () => controller.abort());
  f.state.fail = 'npm:install';
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
  const preparedFetches = f.calls.filter(call => call.kind === 'fetch').length;
  const result = await f.ccw.apply(plan.id, controller.signal);
  assert.equal(result.state, 'cancelled');
  assert.equal(f.calls.filter(call => call.kind === 'fetch').length, preparedFetches);
  assert.equal(
    f.calls.some(call => call.target === 'cmd.exe'),
    false,
  );
});

test('显示内容列表：保持分组与短状态', async t => {
  const f = await fixture(t);
  let menu = 0;
  let inspected = false;
  await runTerminal(f.ccw, {
    wait: (_title, work) => work(new AbortController().signal),
    handoff: work => work(),
    show() {},
    async choose() {
      return menu++ === 0 ? 0 : 4;
    },
    async select(page) {
      const rows = page.rows.map(row => row.label);
      const groups = page.rows.map(row => row.group);
      inspected = true;
      const positions = [
        'Claude Code',
        '模型配置',
        'Code Simplifier',
        'Context7',
        'HIT-SudoMaker/SSRE2',
        'CCometixLine',
        'OfficeCLI',
      ].map(name => rows.findIndex(row => row.startsWith(name)));
      assert.ok(
        positions.every((value, index) => value >= 0 && (index === 0 || value > positions[index - 1])),
        rows.join('\n'),
      );
      assert.deepEqual([...new Set(groups)], ['基础配置', 'Plugins', 'MCPs', 'Skills', '附加工具']);
      assert.equal(
        rows.some(row => /会话加载|未声明启用|尚未验证认证|连接未测试/.test(row)),
        false,
      );
      return { kind: 'cancel', index: 0 };
    },
  });
  assert.equal(inspected, true);
});

test('并行检查内容：隔离慢 npm 探测', async t => {
  const f = await fixture(t);
  f.state.npmDelay = 60;
  const start = performance.now();
  const view = await f.ccw.inspect();
  t.diagnostic(`inspection=${Math.round(performance.now() - start)}ms; concurrent-probes=${f.state.npmPeak}`);
  assert.equal(view.problems.length, 0);
  assert.equal(f.state.npmPeak, 3, 'Claude、OfficeCLI、CCometixLine 的独立 npm 读取应并行');
});

test('取消检查：停止探测并拒绝迟到结果', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const started = Promise.withResolvers();
  let pending = 0;
  let stopped = 0;
  f.state.onNpm = (args, options) => {
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 5000);
    assert.equal(options.signal, controller.signal);
    const result = new Promise(resolve =>
      options.signal.addEventListener(
        'abort',
        () => {
          stopped++;
          resolve({ code: null, stdout: '', failed: true });
        },
        { once: true },
      ),
    );
    if (++pending === 3) started.resolve();
    return result;
  };
  const inspecting = f.ccw.inspect('contents', controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(inspecting, /cancelled/);
  assert.equal(stopped, 3);
});
