import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createTestEnvironment, fail, ok, npmConfig } from './test-environment.mjs';

const npmOf = (scenario, command) => scenario.calls.filter(call => call.kind === 'npm' && call.target === command);
const registryOf = args => option(args, '--registry');
const scopedRegistryOf = (args, scope) => option(args, '--' + scope + ':registry');
function option(args, key) {
  const inline = args.find(arg => arg.startsWith(key + '='));
  const index = args.indexOf(key);
  return (
    (inline === undefined ? (index < 0 ? null : args[index + 1]) : inline.slice(key.length + 1))?.replace(/\/$/, '') ??
    null
  );
}
function npmPackage({ name, npmRoot, version = null, view, install }) {
  const state = { version };
  return {
    state,
    async npm(args) {
      if (args[0] === 'config') return npmConfig(args);
      if (args[0] === 'root') return ok(npmRoot);
      if (args[0] === 'ls')
        return ok(
          JSON.stringify({ dependencies: state.version === null ? {} : { [name]: { version: state.version } } }),
        );
      if (args[0] === 'view') return view(args);
      if (args[0] === 'install') {
        const version = args.at(-1).slice(args.at(-1).lastIndexOf('@') + 1);
        const result = await install(version);
        if (result.code === 0) state.version = version;
        return result;
      }
      throw new Error('Unexpected npm command: ' + args[0]);
    },
  };
}
function versionProbe({ binary, node = false, output }) {
  return async (executable, args) => {
    assert.equal(executable, node ? process.execPath : binary);
    assert.deepEqual(args, node ? [binary, '--version'] : ['--version']);
    return ok(output());
  };
}

const OFFICIAL = 'https://registry.npmjs.org';
const MIRROR = 'https://registry.npmmirror.com';
const PACKAGE = '@cometix/ccline';

const viewResult = outcome =>
  outcome === 'ok'
    ? ok(JSON.stringify('2.0.1'))
    : outcome === 'unsupported'
      ? ok(JSON.stringify('3.0.0'))
      : outcome === 'invalid'
        ? ok(JSON.stringify('not-a-version'))
        : fail();

async function createNpmScenario(
  testContext,
  { configuredView = 'ok', mirrorView = 'ok', install = 'ok', installed = false } = {},
) {
  const workspace = await createTestEnvironment(testContext, { seed: { settings: {}, state: {} } });
  const binary = path.join(workspace.cclineRoot, process.platform === 'win32' ? 'ccline.exe' : 'ccline');
  const npmRoot = path.join(workspace.root, 'npm', 'node_modules');
  if (installed) await workspace.write(binary, 'fixture binary');
  const world = npmPackage({
    name: PACKAGE,
    npmRoot,
    version: installed ? '2.0.1' : null,
    view: args => viewResult(registryOf(args) === MIRROR ? mirrorView : configuredView),
    install: async () => {
      if (install === 'fail') return fail();
      await workspace.write(binary, 'fixture binary');
      return ok();
    },
  });
  const machine = workspace.machine({
    processes: async () => [],
    npm: world.npm,
    execute: versionProbe({ binary, output: () => `ccline ${world.state.version ?? '2.0.1'}` }),
  });
  return { ...workspace, ccw: workspace.ccw(machine) };
}

// 安装、更新与卸载
test('安装 CCometixLine：复用镜像与查询期限', async testContext => {
  const scenario = await createNpmScenario(testContext, { configuredView: 'fail' });
  const plan = await scenario.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  assert.equal(plan.items[0]?.problem, null, JSON.stringify(plan));
  const views = npmOf(scenario, 'view');
  assert.deepEqual(
    views.map(call => registryOf(call.args)),
    [OFFICIAL, MIRROR],
  );
  assert.ok(
    views.every(call => call.options?.timeoutMs === 5_000),
    JSON.stringify(views),
  );
  assert.equal(scopedRegistryOf(views[0].args, '@cometix'), OFFICIAL);
  assert.equal(
    scopedRegistryOf(views[1].args, '@cometix'),
    MIRROR,
    'scoped packages need an explicit scope override because npm scope config wins over --registry',
  );
  assert.ok(views.every(call => call.args.includes('--fetch-retries=0')));
  assert.ok(views.every(call => call.args.includes('--fetch-timeout=4000')));
  assert.equal(
    scenario.calls.some(call => call.kind === 'npm' && call.target === 'install'),
    false,
  );

  assert.equal((await scenario.ccw.apply(plan.id)).state, 'done');
  const installs = npmOf(scenario, 'install');
  assert.equal(installs.length, 1);
  assert.equal(registryOf(installs[0].args), MIRROR);
  assert.equal(scopedRegistryOf(installs[0].args, '@cometix'), MIRROR);
  assert.ok(installs[0].args.includes('--fetch-retries=1'));
  assert.ok(installs[0].args.includes('--fetch-timeout=30000'));
  assert.ok(npmOf(scenario, 'ls').every(call => call.options?.timeoutMs > 0 && call.options.timeoutMs <= 5_000));
});

test('Claude npm 自动更新：固定 stable 版本', async testContext => {
  const workspace = await createTestEnvironment(testContext, { seed: { settings: {}, state: {} } });
  const npmRoot = path.join(workspace.root, 'npm', 'node_modules');
  const packageName = '@anthropic-ai/claude-code';
  const binary = path.join(npmRoot, packageName, 'cli.js');
  const stable = { version: '2.1.318' };
  const world = npmPackage({
    name: packageName,
    npmRoot,
    view: args => ok(JSON.stringify(args[1].endsWith('@stable') ? stable.version : '2.9.999')),
    install: async version => {
      await workspace.json(path.join(npmRoot, packageName, 'package.json'), {
        name: packageName,
        version,
        bin: { claude: 'cli.js' },
      });
      await workspace.write(binary, 'fixture binary');
      return ok();
    },
  });
  const machine = workspace.machine({
    processes: async () => [],
    npm: world.npm,
    execute: versionProbe({
      binary,
      node: true,
      output: () => `${world.state.version ?? '2.1.318'} (Claude Code)`,
    }),
  });
  const ccw = workspace.ccw(machine, { platform: 'win32' });

  const first = await ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
  assert.ok(
    first.items.every(item => item.problem === null),
    JSON.stringify(first),
  );
  assert.equal((await ccw.apply(first.id)).state, 'done');
  const item = (await ccw.inspect()).items.find(item => item.kind === 'claude');
  world.state.version = '2.1.300';
  workspace.calls.length = 0;
  stable.version = '2.1.320';
  const plan = await ccw.plan({ task: 'install', selected: [{ id: item.id }] });
  assert.match(JSON.stringify(plan.items[0].changes), /2\.1\.320/);
  stable.version = '2.1.321';
  const result = await ccw.apply(plan.id);
  assert.equal(result.state, 'done');
  assert.equal(world.state.version, '2.1.320');
  assert.ok(
    workspace.calls.some(
      call =>
        call.kind === 'npm' && call.target === 'install' && call.args.at(-1) === '@anthropic-ai/claude-code@2.1.320',
    ),
  );
  assert.equal(
    workspace.calls.filter(call => call.kind === 'npm' && call.args.includes('@anthropic-ai/claude-code@stable'))
      .length,
    1,
  );
  assert.equal(
    workspace.calls.some(call => call.kind === 'npm' && call.args.includes('@anthropic-ai/claude-code@latest')),
    false,
  );
  const repeat = await ccw.plan({ task: 'install', selected: [{ id: item.id }] });
  assert.ok(
    repeat.items.every(item => item.problem === null),
    JSON.stringify(repeat),
  );
  assert.equal((await ccw.apply(repeat.id)).state, 'done');
  assert.equal(world.state.version, '2.1.321');
});

test('卸载 CCometixLine：限时读取 npm 记录', async testContext => {
  const scenario = await createNpmScenario(testContext, { installed: true });
  const plan = await scenario.ccw.plan({ task: 'uninstall', selected: [{ id: 'ccline' }] });
  assert.equal(plan.items[0]?.problem, null, JSON.stringify(plan));
  const localReads = scenario.calls.filter(call => call.kind === 'npm' && ['ls', 'root'].includes(call.target));
  assert.ok(localReads.some(call => call.target === 'ls'));
  assert.ok(localReads.some(call => call.target === 'root'));
  assert.ok(
    localReads.every(call => call.options?.timeoutMs === 5_000),
    JSON.stringify(localReads),
  );
});

// 配置源与镜像的选择边界
for (const { title, options, views, problem = null, state = 'done', installs = [] } of [
  { title: '安装 CCometixLine：沿用有效配置源', views: [OFFICIAL], installs: [OFFICIAL] },
  {
    title: '配置源版本无效：查询镜像',
    options: { configuredView: 'invalid' },
    views: [OFFICIAL, MIRROR],
    installs: [MIRROR],
  },
  {
    title: '拒绝不兼容的 CCometixLine 主版本',
    options: { configuredView: 'unsupported' },
    views: [OFFICIAL],
    problem: 'unsupported-ccline-release',
    state: null,
  },
  {
    title: 'npm 来源均失败：阻止 CCometixLine 安装',
    options: { configuredView: 'fail', mirrorView: 'fail' },
    views: [OFFICIAL, MIRROR],
    problem: 'source-unavailable',
    state: 'failed',
  },
  {
    title: '镜像安装失败：禁止换源重装',
    options: { configuredView: 'fail', install: 'fail' },
    views: [OFFICIAL, MIRROR],
    state: 'not-done',
    installs: [MIRROR],
  },
])
  test(title, async testContext => {
    const scenario = await createNpmScenario(testContext, options);
    const plan = await scenario.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
    assert.equal(plan.items[0]?.problem, problem, JSON.stringify(plan));
    assert.deepEqual(
      npmOf(scenario, 'view').map(call => registryOf(call.args)),
      views,
    );
    assert.equal(npmOf(scenario, 'install').length, 0);
    if (state === null) return;
    const result = await scenario.ccw.apply(plan.id);
    if (state === 'not-done') assert.notEqual(result.state, 'done');
    else assert.equal(result.state, state);
    assert.deepEqual(
      npmOf(scenario, 'install').map(call => registryOf(call.args)),
      installs,
    );
  });
