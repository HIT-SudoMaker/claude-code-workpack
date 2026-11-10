import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createCcw } from '../dist/ccw.js';

import {
  createEnv,
  fail,
  npmOf,
  npmWorld,
  ok,
  pluginMarketplaceFiles,
  registryOf,
  releaseContract,
  revision,
  scopedRegistryOf,
  versionProbe,
} from './env.mjs';

const MIRROR = 'https://registry.npmmirror.com';
const OFFICIAL = 'https://registry.npmjs.org';

for (const backup of ['unreachable', 'html', 'empty'])
  test(`Windows npm 安装可用：${backup} CMD 备用来源不阻止主安装`, async t => {
    const f = await createEnv(t);
    const npmRoot = path.join(f.root, 'npm/node_modules');
    const binary = path.join(npmRoot, '@anthropic-ai/claude-code/cli.js');
    const world = npmWorld({
      package: '@anthropic-ai/claude-code',
      npmRoot,
      installVersion: '2.1.318',
      bin: { claude: 'cli.js' },
      view: async () => ok('"2.1.318"'),
    });
    const base = f.machine({
      npm: world.npm,
      execute: versionProbe({ binary, node: true, output: '2.1.318 Claude Code' }),
      processes: async () => [],
    });
    let backupFetches = 0;
    const ccw = f.ccw(
      {
        ...base,
        async fetchText(url) {
          assert.equal(url, 'https://claude.ai/install.cmd');
          backupFetches++;
          if (backup === 'unreachable') throw new Error('source-timeout');
          return backup === 'html' ? '<html>network login</html>' : '';
        },
      },
      { platform: 'win32' },
    );
    const plan = await ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
    assert.equal(plan.items[0].problem, null, JSON.stringify(plan));
    assert.equal((await ccw.apply(plan.id)).state, 'done');
    assert.equal(npmOf(f, 'install').length, 1);
    assert.equal(
      f.calls.some(call => call.target === 'cmd.exe'),
      false,
    );
    assert.equal(backupFetches, 1);
    assert.equal(await fs.readFile(binary, 'utf8'), 'fixture binary');
  });

test('回退 npm 镜像并冻结安装来源', async t => {
  const f = await createEnv(t, { seed: { settings: {}, state: {} } });
  const npmRoot = path.join(f.root, 'npm', 'node_modules');
  const packageName = '@anthropic-ai/claude-code';
  const binary = path.join(npmRoot, packageName, 'cli.js');
  const npmrc = path.join(f.home, '.npmrc');
  const npmrcBefore = '@private:registry=https://registry.example.test/\n';
  await f.write(npmrc, npmrcBefore);
  const world = npmWorld({
    package: packageName,
    npmRoot,
    installVersion: '2.1.318',
    bin: { claude: 'cli.js' },
    binaryContent: 'fixture binary',
    view: args => (registryOf(args) === MIRROR ? ok(JSON.stringify('2.1.318')) : fail()),
    onInstall: args => {
      assert.equal(registryOf(args), MIRROR, '安装必须复用成功解析 stable 的镜像源');
    },
  });
  const base = f.machine({
    processes: async () => [],
    npm: world.npm,
    execute: versionProbe({ binary, node: true, output: '2.1.318 (Claude Code)', otherwise: 'throw' }),
  });
  const machine = {
    ...base,
    async fetchText(url) {
      if (url === 'https://claude.ai/install.cmd') return '@echo off\r\n';
      throw new Error(`unexpected direct registry fetch: ${url}`);
    },
  };
  const ccw = f.ccw(machine, { platform: 'win32' });

  const plan = await ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(plan.items[0]?.problem, null, JSON.stringify(plan));
  assert.deepEqual(
    npmOf(f, 'view').map(call => registryOf(call.args)),
    [OFFICIAL, MIRROR],
  );
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  assert.ok(npmOf(f, 'install').some(call => registryOf(call.args) === MIRROR));
  assert.equal(
    f.calls.some(call => call.kind === 'npm' && call.target === 'config' && call.args[1] !== 'get'),
    false,
    'CCW 不得改写用户的 npm registry 配置',
  );
  assert.equal(await base.read(npmrc), npmrcBefore);
});

test('安装 OfficeCLI：使用 GitHub 载荷', async t => {
  const f = await createEnv(t, { seed: { settings: {}, state: {} } });
  const localAppData = path.join(f.root, 'LocalAppData');
  const payload = Buffer.from('OfficeCLI GitHub release fixture');
  const digest = createHash('sha256').update(payload).digest('hex');
  const tag = 'v1.0.123';
  const asset = 'officecli-win-x64.exe';
  const release = `https://github.com/iOfficeAI/OfficeCLI/releases/download/${tag}/`;
  const network = [];
  const base = f.machine({
    processes: async () => [],
    npm: async args => {
      if (args[0] === 'ls') return ok('{"dependencies":{}}');
      throw new Error(`unexpected npm command: ${args[0]}`);
    },
  });
  const { fetchText } = releaseContract({ tag, asset, digest, revision, network });
  const machine = {
    ...base,
    fetchText,
    async fetchBytes(url) {
      network.push(url);
      assert.equal(url, release + asset);
      return payload;
    },
    async source(repository, commit, folder) {
      assert.equal(repository, 'https://github.com/iOfficeAI/OfficeCLI');
      assert.equal(commit, revision);
      assert.equal(folder, 'skills/officecli');
      network.push(repository);
      return [{ path: 'SKILL.md', data: Buffer.from('---\nname: officecli\n---\nOfficeCLI commands') }];
    },
  };
  const ccw = f.ccw(machine, { platform: 'win32', arch: 'x64', localAppData });

  const plan = await ccw.plan({ task: 'install', selected: [{ id: 'officecli' }] });
  assert.equal(plan.items[0]?.problem, null, JSON.stringify(plan));
  const npmCalls = f.calls.filter(call => call.kind === 'npm');
  assert.deepEqual(
    npmCalls.map(call => call.args[0]),
    ['ls'],
  );
  assert.ok(
    npmCalls[0]?.options?.timeoutMs > 0 && npmCalls[0].options.timeoutMs <= 10_000,
    `OfficeCLI npm discovery must be bounded; received ${JSON.stringify(npmCalls[0]?.options)}`,
  );
  assert.ok(network.length >= 4);
  assert.ok(
    network.every(url => url.startsWith('https://api.github.com/') || url.startsWith('https://github.com/')),
    network.join('\n'),
  );
  assert.equal(
    npmCalls.some(call => ['view', 'install'].includes(call.args[0])),
    false,
  );
});

test('回退官方 npm 来源：限时单次安装', async t => {
  const f = await createEnv(t, { seed: { settings: {}, state: {} } });
  const npmRoot = path.join(f.root, 'npm', 'node_modules');
  const packageName = '@anthropic-ai/claude-code';
  const binary = path.join(npmRoot, packageName, 'cli.js');
  const fetches = [];
  const world = npmWorld({
    package: packageName,
    npmRoot,
    installVersion: '2.1.318',
    bin: { claude: 'cli.js' },
    binaryContent: 'fixture binary',
    view: () => fail(),
  });
  const machine = f.machine({
    processes: async () => [],
    npm: world.npm,
    execute: versionProbe({ binary, node: true, output: '2.1.318 (Claude Code)', otherwise: 'throw' }),
  });
  const ccw = f.ccw(
    {
      ...machine,
      async fetchText(url, options) {
        if (url === 'https://claude.ai/install.cmd') return '@echo off\r\n';
        fetches.push({ url, options });
        assert.equal(url, `${OFFICIAL}/@anthropic-ai%2Fclaude-code/stable`);
        return JSON.stringify({ version: '2.1.318' });
      },
    },
    { platform: 'win32' },
  );

  const plan = await ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(plan.items[0]?.problem, null, JSON.stringify(plan));
  assert.deepEqual(
    npmOf(f, 'view').map(call => registryOf(call.args)),
    [OFFICIAL, MIRROR],
  );
  assert.deepEqual(fetches, [{ url: `${OFFICIAL}/@anthropic-ai%2Fclaude-code/stable`, options: { timeoutMs: 5_000 } }]);
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  const installs = npmOf(f, 'install');
  assert.equal(installs.length, 1);
  assert.equal(registryOf(installs[0].args), OFFICIAL);
  assert.equal(scopedRegistryOf(installs[0].args, '@anthropic-ai'), OFFICIAL);
});

const CLAUDE_PACKAGE = '@anthropic-ai/claude-code';
const CLAUDE_VERSION = '2.1.318';

/** 构造 Claude npm 世界应答器：view/install/探测共性集中，差异经参数暴露（view/install 结果、ls ENOENT 形态、fetch 模式） */
async function claudeFixture(
  t,
  { view = 'ok', install = 'ok', installResultFail = false, enoentLs = false, fetch = 'guard' } = {},
) {
  const f = await createEnv(t, { seed: { settings: {}, state: {} } });
  const npmRoot = path.join(f.root, 'npm', 'node_modules');
  const binary = path.join(npmRoot, CLAUDE_PACKAGE, 'cli.js');
  const world = npmWorld({
    package: CLAUDE_PACKAGE,
    npmRoot,
    installVersion: CLAUDE_VERSION,
    bin: { claude: 'cli.js' },
    binaryContent: 'fixture binary',
    view: () => (view === 'ok' ? ok(JSON.stringify(CLAUDE_VERSION)) : fail()),
    install: install === 'fail' ? 'fail' : null,
  });
  const fetches = [];
  const fetchText = async url => {
    fetches.push(url);
    if (fetch === 'garbage') return '{"version":"latest"}';
    if (url === 'https://claude.ai/install.cmd') {
      if (fetch === 'unreachable') throw new Error('source-timeout');
      return '# isolated installer fixture';
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const machine = {
    ...f.machine({
      processes: async () => [],
      npm: async (args, options) => {
        if (enoentLs && args[0] === 'ls' && world.state.version === null)
          return { code: 4294963238, failed: false, stdout: JSON.stringify({ error: { code: 'ENOENT' } }) };
        const result = await world.npm(args, options);
        return installResultFail && args[0] === 'install' ? fail() : result;
      },
      execute: versionProbe({
        binary,
        node: true,
        output: () => `${world.state.version ?? CLAUDE_VERSION} (Claude Code)`,
        before: async file => (file === 'git' ? ok(`${revision}\tHEAD`) : undefined),
      }),
    }),
    async source(repository, commit, folder) {
      assert.equal(repository, 'https://github.com/anthropics/claude-plugins-official');
      assert.equal(commit, revision);
      assert.equal(folder, '.');
      return pluginMarketplaceFiles();
    },
    fetchText,
  };
  return { ...f, npmRoot, machine, fetches, ccw: f.ccw(machine, { platform: 'win32' }) };
}

test('CMD 备用来源不可用：重启保留冻结结果而不重新获取安装器', async t => {
  const f = await claudeFixture(t, { install: 'fail', fetch: 'unreachable' });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(plan.items[0].problem, null, JSON.stringify(plan));
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'failed', JSON.stringify(first));
  assert.ok(first.remaining);
  assert.ok(first.items[0].effects.some(effect => effect.code === 'installer-unavailable'));
  const restarted = createCcw({
    machine: f.machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform: 'win32',
  });
  const resumed = await restarted.plan({ resume: first.remaining });
  const paused = await restarted.apply(resumed.id);
  assert.equal(paused.state, 'failed', JSON.stringify(paused));
  assert.ok(paused.remaining);
  assert.equal(npmOf(f, 'install').length, 1);
  assert.equal(
    f.calls.some(call => call.target === 'cmd.exe'),
    false,
  );
  assert.deepEqual(f.fetches, ['https://claude.ai/install.cmd']);
  assert.deepEqual(await f.read(f.settingsFile), {});
});

for (const rootExists of [false, true])
  test(`npm 报 ENOENT：${rootExists ? '报告已有目录异常' : '允许首次安装'}`, async t => {
    const f = await claudeFixture(t, { enoentLs: true });
    if (rootExists) await fs.mkdir(f.npmRoot, { recursive: true });
    const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
    const result = await f.ccw.apply(plan.id);
    assert.equal(result.state, rootExists ? 'failed' : 'done');
    if (rootExists) {
      assert.equal(result.items[0].effects.at(-1).code, 'installation-state-unconfirmed');
      assert.equal(
        f.calls.some(
          call =>
            (call.kind === 'execute' && (call.target === 'cmd.exe' || call.args[0] === 'install')) ||
            (call.kind === 'npm' && call.target === 'install'),
        ),
        false,
      );
    }
  });

test('npm 报错但程序可用：跳过备用安装', async t => {
  const f = await claudeFixture(t, { installResultFail: true });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
  assert.ok(
    plan.items.every(item => item.problem === null),
    JSON.stringify(plan),
  );
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'done');
  assert.deepEqual(
    result.items[0].effects.find(effect => effect.code === 'program-ready'),
    { state: 'done', code: 'program-ready', detail: path.join(f.npmRoot, CLAUDE_PACKAGE, 'cli.js') },
  );
  assert.equal(
    f.calls.some(call => call.target === 'cmd.exe' || call.kind === 'fetch'),
    false,
  );
});

test('stable 来源均失败：停止准备', async t => {
  const f = await claudeFixture(t, { view: 'fail', fetch: 'garbage' });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(plan.items[0].problem, 'stable-release-unavailable');
  assert.equal(
    f.calls.some(
      call =>
        (call.kind === 'execute' && (call.target === 'cmd.exe' || call.args[0] === 'install')) ||
        (call.kind === 'npm' && call.target === 'install'),
    ),
    false,
  );
});

test('全部安装失败：保留各渠道结果', async t => {
  const f = await claudeFixture(t, { install: 'fail', fetch: 'installer' });
  const plan = await f.ccw.plan({
    task: 'install',
    selected: [{ id: 'claude' }, { id: 'plugin:github@claude-plugins-official' }],
  });
  assert.ok(
    plan.items.every(item => item.problem === null),
    JSON.stringify(plan),
  );
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.deepEqual(
    result.items[0].effects.filter(effect => effect.code.endsWith('install-failed')).map(effect => effect.code),
    ['npm-install-failed', 'cmd-install-failed'],
  );
  assert.equal(result.items[1].effects.at(-1).code, 'dependency-not-ready');
  assert.equal(f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe').length, 1);
});
