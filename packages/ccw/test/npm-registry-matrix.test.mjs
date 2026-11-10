import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  createEnv,
  fail,
  npmOf,
  npmWorld,
  ok,
  registryOf,
  scopedRegistryOf,
  seedBinary,
  versionProbe,
} from './env.mjs';

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

async function fixture(t, { configuredView = 'ok', mirrorView = 'ok', install = 'ok', installed = false } = {}) {
  const f = await createEnv(t, { seed: { settings: {}, state: {} } });
  const binary = path.join(f.cclineRoot, process.platform === 'win32' ? 'ccline.exe' : 'ccline');
  const npmRoot = path.join(f.root, 'npm', 'node_modules');
  if (installed) await f.write(binary, 'fixture binary');
  const world = npmWorld({
    package: PACKAGE,
    npmRoot,
    version: installed ? '2.0.1' : null,
    installVersion: '2.0.1',
    binary,
    binaryContent: 'fixture binary',
    view: args => viewResult(registryOf(args) === MIRROR ? mirrorView : configuredView),
    install: install === 'fail' ? 'fail' : null,
  });
  const machine = f.machine({
    processes: async () => [],
    npm: world.npm,
    execute: versionProbe({ binary, output: () => `ccline ${world.state.version ?? '2.0.1'}` }),
  });
  return { ...f, ccw: f.ccw(machine) };
}

test('安装 CCometixLine：复用镜像与查询期限', async t => {
  const f = await fixture(t, { configuredView: 'fail' });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  assert.equal(plan.items[0]?.problem, null, JSON.stringify(plan));
  const views = npmOf(f, 'view');
  assert.deepEqual(
    views.map(call => registryOf(call.args)),
    [null, MIRROR],
  );
  assert.ok(
    views.every(call => call.options?.timeoutMs === 5_000),
    JSON.stringify(views),
  );
  assert.equal(scopedRegistryOf(views[0].args, '@cometix'), null);
  assert.equal(
    scopedRegistryOf(views[1].args, '@cometix'),
    MIRROR,
    'scoped packages need an explicit scope override because npm scope config wins over --registry',
  );
  assert.ok(views.every(call => call.args.includes('--fetch-retries=0')));
  assert.ok(views.every(call => call.args.includes('--fetch-timeout=4000')));
  assert.equal(
    f.calls.some(call => call.kind === 'npm' && call.target === 'install'),
    false,
  );

  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  const installs = npmOf(f, 'install');
  assert.equal(installs.length, 1);
  assert.equal(registryOf(installs[0].args), MIRROR);
  assert.equal(scopedRegistryOf(installs[0].args, '@cometix'), MIRROR);
  assert.ok(installs[0].args.includes('--fetch-retries=1'));
  assert.ok(installs[0].args.includes('--fetch-timeout=30000'));
  assert.ok(npmOf(f, 'ls').every(call => call.options?.timeoutMs === 5_000));
});

test('安装 CCometixLine：沿用有效配置源', async t => {
  const f = await fixture(t);
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  assert.equal(plan.items[0]?.problem, null, JSON.stringify(plan));
  assert.deepEqual(
    npmOf(f, 'view').map(call => registryOf(call.args)),
    [null],
  );
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  const installs = npmOf(f, 'install');
  assert.equal(installs.length, 1);
  assert.equal(registryOf(installs[0].args), null);
});

test('配置源版本无效：查询镜像', async t => {
  const f = await fixture(t, { configuredView: 'invalid' });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  assert.equal(plan.items[0]?.problem, null, JSON.stringify(plan));
  assert.deepEqual(
    npmOf(f, 'view').map(call => registryOf(call.args)),
    [null, MIRROR],
  );
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.equal(registryOf(f.calls.find(call => call.kind === 'npm' && call.target === 'install').args), MIRROR);
});

test('拒绝不兼容的 CCometixLine 主版本', async t => {
  const f = await fixture(t, { configuredView: 'unsupported' });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  assert.equal(plan.items[0]?.problem, 'unsupported-ccline-release');
  assert.deepEqual(
    npmOf(f, 'view').map(call => registryOf(call.args)),
    [null],
  );
  assert.equal(
    f.calls.some(call => call.kind === 'npm' && call.target === 'install'),
    false,
  );
});

test('npm 来源均失败：阻止 CCometixLine 安装', async t => {
  const f = await fixture(t, { configuredView: 'fail', mirrorView: 'fail' });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  assert.notEqual(plan.items[0]?.problem, null);
  assert.deepEqual(
    npmOf(f, 'view').map(call => registryOf(call.args)),
    [null, MIRROR],
  );
  assert.equal(
    f.calls.some(call => call.kind === 'npm' && call.target === 'install'),
    false,
  );
  assert.equal((await f.ccw.apply(plan.id)).state, 'failed');
  assert.equal(
    f.calls.some(call => call.kind === 'npm' && call.target === 'install'),
    false,
  );
});

test('镜像安装失败：禁止换源重装', async t => {
  const f = await fixture(t, { configuredView: 'fail', install: 'fail' });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
  assert.equal(plan.items[0]?.problem, null, JSON.stringify(plan));
  assert.notEqual((await f.ccw.apply(plan.id)).state, 'done');
  const installs = npmOf(f, 'install');
  assert.equal(installs.length, 1);
  assert.equal(registryOf(installs[0].args), MIRROR);
});

test('卸载 CCometixLine：限时读取 npm 记录', async t => {
  const f = await fixture(t, { installed: true });
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'ccline' }] });
  assert.equal(plan.items[0]?.problem, null, JSON.stringify(plan));
  const localReads = f.calls.filter(call => call.kind === 'npm' && ['ls', 'root'].includes(call.target));
  assert.ok(localReads.some(call => call.target === 'ls'));
  assert.ok(localReads.some(call => call.target === 'root'));
  assert.ok(
    localReads.every(call => call.options?.timeoutMs === 5_000),
    JSON.stringify(localReads),
  );
});

test('更新 OfficeCLI：复用 npm 镜像', async t => {
  const f = await createEnv(t, { seed: { settings: {}, state: {} } });
  const npmRoot = path.join(f.root, 'npm', 'node_modules');
  const binary = path.join(npmRoot, '@officecli', 'officecli', 'vendor', 'officecli.exe');
  await f.write(binary, 'OfficeCLI 1.0.123 fixture');

  const world = npmWorld({
    package: '@officecli/officecli',
    npmRoot,
    version: '1.0.123',
    installVersion: '1.0.160',
    binary,
    binaryContent: 'OfficeCLI 1.0.160 fixture',
    lsOnRequest: true,
    view: args => (registryOf(args) === MIRROR ? ok(JSON.stringify('1.0.160')) : fail()),
  });
  const machine = {
    ...f.machine({
      processes: async () => [],
      npm: world.npm,
      execute: versionProbe({ binary, output: () => `OfficeCLI ${world.state.version}` }),
    }),
    async fetchText(url) {
      throw new Error(`unexpected network fetch: ${url}`);
    },
  };
  const ccw = f.ccw(machine, { platform: 'win32' });
  const id = `officecli:npm:${binary}`;
  const plan = await ccw.plan({
    task: 'install',
    selected: [{ id, maintenance: 'update', fields: { connection: 'mcp' } }],
  });
  assert.equal(plan.items[0]?.problem, null, JSON.stringify(plan));
  assert.deepEqual(
    npmOf(f, 'view').map(call => registryOf(call.args)),
    [null, MIRROR],
  );
  assert.ok(
    f.calls
      .filter(call => call.kind === 'npm' && ['ls', 'root'].includes(call.target))
      .every(call => call.options?.timeoutMs === 5_000),
  );

  assert.equal((await ccw.apply(plan.id)).state, 'done');
  const installs = npmOf(f, 'install');
  assert.equal(installs.length, 1);
  assert.equal(registryOf(installs[0].args), MIRROR);
});

test('更新 OfficeCLI 技能：固定镜像提交', async t => {
  const f = await createEnv(t, { seed: { settings: {}, state: {} } });
  const skill = path.join(f.claudeRoot, 'skills', 'officecli');
  const npmRoot = path.join(f.root, 'npm', 'node_modules');
  const binary = path.join(npmRoot, '@officecli', 'officecli', 'vendor', 'officecli.exe');
  const oldRevision = '1111111111111111111111111111111111111111';
  const nextRevision = '2222222222222222222222222222222222222222';
  await f.write(binary, 'OfficeCLI 1.0.123 fixture');
  await f.write(path.join(skill, 'SKILL.md'), '---\nname: officecli\n---\nold skill');

  const world = npmWorld({
    package: '@officecli/officecli',
    npmRoot,
    version: '1.0.123',
    installVersion: '1.0.160',
    binary,
    binaryContent: 'OfficeCLI 1.0.160 fixture',
    lsOnRequest: true,
    view: args =>
      registryOf(args) !== MIRROR ? fail() : ok(JSON.stringify(args.includes('gitHead') ? nextRevision : '1.0.160')),
  });
  const base = f.machine({
    processes: async () => [],
    npm: world.npm,
    execute: versionProbe({ binary, output: () => `OfficeCLI ${world.state.version}` }),
  });
  const stamp = await base.treeStamp(skill);
  const metadataFile = path.join(f.home, '.ccw', 'sources.json');
  await f.write(
    metadataFile,
    JSON.stringify({ [skill]: { repository: 'https://github.com/iOfficeAI/OfficeCLI', revision: oldRevision, stamp } }),
  );
  const sourceCalls = () => f.calls.filter(call => call.kind === 'source').length;
  const machine = {
    ...base,
    async source(repository, revision, folder) {
      f.calls.push({ kind: 'source', target: repository, args: [revision, folder] });
      assert.equal(repository, 'https://github.com/iOfficeAI/OfficeCLI');
      assert.equal(revision, nextRevision);
      assert.equal(folder, 'skills/officecli');
      return [{ path: 'SKILL.md', data: Buffer.from('---\nname: officecli\n---\nnew skill') }];
    },
    async fetchText(url) {
      throw new Error(`unexpected direct metadata fetch: ${url}`);
    },
  };
  const ccw = f.ccw(machine, { platform: 'win32' });
  const id = `officecli:npm:${binary}`;
  const plan = await ccw.plan({
    task: 'install',
    selected: [{ id, maintenance: 'update', fields: { connection: 'skill' } }],
  });
  assert.equal(plan.items[0]?.problem, null, JSON.stringify(plan));
  assert.equal(sourceCalls(), 1, '准备时冻结 Skill 载荷');
  const views = npmOf(f, 'view');
  assert.deepEqual(
    views.map(call => [call.args.includes('gitHead') ? 'gitHead' : 'version', registryOf(call.args)]),
    [
      ['version', null],
      ['version', MIRROR],
      ['gitHead', MIRROR],
    ],
  );
  const gitHead = views.find(call => call.args.includes('gitHead'));
  assert.equal(gitHead.options?.timeoutMs, 5_000);
  assert.equal(scopedRegistryOf(gitHead.args, '@officecli'), MIRROR);

  assert.equal((await ccw.apply(plan.id)).state, 'done');
  assert.equal(sourceCalls(), 1);
  const saved = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
  assert.equal(saved[skill].revision, nextRevision);
});

for (const action of ['update', 'reinstall'])
  test(`Claude npm ${action}：固定 stable 版本`, async t => {
    const f = await createEnv(t, { seed: { settings: {}, state: {} } });
    const npmRoot = path.join(f.root, 'npm', 'node_modules');
    const packageName = '@anthropic-ai/claude-code';
    const binary = path.join(npmRoot, packageName, 'cli.js');
    const stable = { version: '2.1.318' };
    // npmWorld 的 installVersion 在工厂期凝固，而本测试要求安装版本跟随 install 参数（计划期冻结的 stable），
    // 故以 install 函数按原 bin 种子序列表达动态版本
    const world = npmWorld({
      package: packageName,
      npmRoot,
      bin: { claude: 'cli.js' },
      binaryContent: 'fixture binary',
      view: args => ok(JSON.stringify(args[1].endsWith('@stable') ? stable.version : '2.9.999')),
      install: async (state, args) => {
        const spec = args.at(-1);
        state.version = spec.slice(spec.lastIndexOf('@') + 1);
        await seedBinary(
          path.join(npmRoot, packageName, 'package.json'),
          JSON.stringify({ name: packageName, version: state.version, bin: { claude: 'cli.js' } }),
        );
        await seedBinary(binary, 'fixture binary');
        return ok();
      },
    });
    const machine = f.machine({
      processes: async () => [],
      npm: world.npm,
      execute: versionProbe({
        binary,
        node: true,
        output: () => `${world.state.version ?? '2.1.318'} (Claude Code)`,
        otherwise: 'throw',
      }),
    });
    const ccw = f.ccw(machine, { platform: 'win32' });

    const first = await ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
    assert.ok(
      first.items.every(item => item.problem === null),
      JSON.stringify(first),
    );
    assert.equal((await ccw.apply(first.id)).state, 'done');
    const item = (await ccw.inspect()).items.find(item => item.kind === 'claude');
    world.state.version = '2.1.300';
    f.calls.length = 0;
    stable.version = '2.1.320';
    const plan = await ccw.plan({ task: 'install', selected: [{ id: item.id, maintenance: action }] });
    assert.match(JSON.stringify(plan.items[0].changes), /2\.1\.320/);
    stable.version = '2.1.321';
    const result = await ccw.apply(plan.id);
    assert.equal(result.state, 'done');
    assert.equal(world.state.version, '2.1.320');
    assert.ok(
      f.calls.some(
        call =>
          call.kind === 'npm' && call.target === 'install' && call.args.at(-1) === '@anthropic-ai/claude-code@2.1.320',
      ),
    );
    assert.equal(
      f.calls.filter(call => call.kind === 'npm' && call.args.includes('@anthropic-ai/claude-code@stable')).length,
      1,
    );
    assert.equal(
      f.calls.some(call => call.kind === 'npm' && call.args.includes('@anthropic-ai/claude-code@latest')),
      false,
    );
    const repeat = await ccw.plan({ task: 'install', selected: [{ id: item.id, maintenance: action }] });
    assert.ok(
      repeat.items.every(item => item.problem === null),
      JSON.stringify(repeat),
    );
    assert.equal((await ccw.apply(repeat.id)).state, 'done');
    assert.equal(world.state.version, '2.1.321');
  });
