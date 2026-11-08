import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { describeItem } from '../dist/render.js';
import { createCcw } from '../dist/ccw.js';
import { createEnv, exists, fail, ok, releaseContract } from './env.mjs';

const packageName = '@officecli/officecli';
const withNpmView = npm => async (args, options) =>
  args[0] === 'view' ? ok(JSON.stringify('1.0.123')) : npm(args, options);

async function fixture(t, { npm, read, execute, fetchText, source } = {}) {
  const f = await createEnv(t, { layout: 'home' });
  const npmRoot = path.join(f.root, 'npm', 'lib', 'node_modules');
  const packageRoot = path.join(npmRoot, packageName);
  const native = path.join(f.home, '.local', 'bin', 'officecli');
  const launcher = path.join(packageRoot, 'officecli.js');
  const binary = path.join(packageRoot, 'vendor', 'officecli');
  const skill = path.join(f.claudeRoot, 'skills', 'officecli');
  const state = { npm: false, locations: [], failUninstall: false };
  const npmHandler = async args => {
    if (args[0] === 'root') return ok(npmRoot);
    if (args[0] === 'ls')
      return ok(
        JSON.stringify({
          dependencies: args.at(-1) === packageName && state.npm ? { [packageName]: { version: '1.0.123' } } : {},
        }),
      );
    if (args[0] === 'uninstall') {
      if (state.failUninstall) return fail();
      state.npm = false;
      await fs.rm(packageRoot, { recursive: true, force: true });
      return ok();
    }
    throw new Error(`unexpected-npm:${args.join(' ')}`);
  };
  const machine = {
    ...f.machine({
      locate: async name => (name === 'officecli' ? state.locations : []),
      processes: async () => [],
      npm: npm ? npm(npmHandler) : npmHandler,
      execute:
        execute ??
        (async (file, args) => {
          if (args[0] === '--version') return ok('OfficeCLI 1.0.123');
          throw new Error('unexpected-command');
        }),
      ...(read ? { read } : {}),
    }),
    ensureUserPath: async () => {},
    fetchText:
      fetchText ??
      (async () => {
        throw new Error('unexpected-network');
      }),
    source:
      source ??
      (async () => {
        throw new Error('unexpected-source');
      }),
  };
  const ccw = f.ccw(machine, { platform: 'linux' });
  const installNpm = async () => {
    state.npm = true;
    await f.write(binary, 'npm binary');
    await f.write(launcher, 'npm launcher');
    state.locations = [launcher];
  };
  const installSkill = async (recorded = true) => {
    await f.write(
      path.join(skill, 'SKILL.md'),
      '---\nname: officecli\ndescription: OfficeCLI document commands\n---\nofficecli create file.docx',
    );
    if (recorded)
      await f.write(
        path.join(f.home, '.ccw', 'sources.json'),
        JSON.stringify({
          [skill]: {
            repository: 'https://github.com/iOfficeAI/OfficeCLI',
            revision: 'fixed',
            stamp: await machine.treeStamp(skill),
          },
        }),
      );
  };
  const installMcp = async command =>
    f.write(
      f.stateFile,
      JSON.stringify({ mcpServers: { officecli: { command, args: ['mcp'] } }, projects: { keep: true } }),
    );
  return {
    ...f,
    npmRoot,
    packageRoot,
    native,
    launcher,
    binary,
    skill,
    state,
    machine,
    ccw,
    installNpm,
    installSkill,
    installMcp,
  };
}

test('检查 OfficeCLI：聚合确认的接入', async t => {
  const f = await fixture(t);
  await f.installNpm();
  await f.installSkill();
  await f.installMcp(f.binary);
  const view = await f.ccw.inspect();
  const office = view.items.filter(item => item.kind === 'officecli');
  assert.equal(office.length, 1);
  assert.ok(office[0].facts.some(fact => fact.code === 'office-skill-connected'));
  assert.ok(office[0].facts.some(fact => fact.code === 'office-mcp-connected'));
  assert.ok(office[0].actions.includes('uninstall'));
  assert.equal(
    view.items.some(item => ['skill:officecli', 'mcp:officecli'].includes(item.id)),
    false,
  );
  assert.equal(
    f.calls.some(call => call.args.includes('--version')),
    false,
  );
});

test('检查 OfficeCLI：只读文件与接入事实', async t => {
  const f = await fixture(t, { execute: async () => ok('1.0.123') });
  await f.write(f.native, 'unrecognized binary');
  await f.installMcp(f.native);
  f.faults.execute.set(f.native, new Error('inspection must not start OfficeCLI'));
  const item = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
  assert.equal(item.problem, undefined);
  assert.ok(item.facts.some(fact => fact.code === 'program-identity-unchecked'));
  assert.ok(item.facts.some(fact => fact.code === 'office-mcp-connected'));
  assert.ok(item.actions.includes('detach'));
  f.faults.execute.delete(f.native);
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: item.id }] });
  assert.equal(plan.items[0].problem, 'program-identity-unconfirmed');
});

test('安装 OfficeCLI：拒绝身份未确认的已有程序', async t => {
  const f = await fixture(t, { execute: async () => ok('1.0.123') });
  await f.write(f.native, 'unrecognized binary');
  await f.installMcp(f.native);
  const item = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: item.id }] });
  assert.equal(plan.items[0].problem, 'program-identity-unconfirmed');
});

test('重装 OfficeCLI 接入：识别 Windows 命令名', async t => {
  const f = await fixture(t, { npm: withNpmView });
  await f.installNpm();
  await f.installMcp('officecli.exe');
  const item = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
  const plan = await f.ccw.plan({
    task: 'install',
    selected: [{ id: item.id, maintenance: 'reinstall', fields: { connection: 'mcp' } }],
  });
  assert.equal(plan.items[0].problem, null, JSON.stringify(plan));
});

test('识别 OfficeCLI Skill：忽略正文中的名称', async t => {
  const f = await fixture(t);
  await f.installNpm();
  await f.write(path.join(f.skill, 'SKILL.md'), '# Personal notes\nname: officecli\n');
  const view = await f.ccw.inspect();
  assert.ok(view.items.some(item => item.id === 'skill:officecli'));
  const item = view.items.find(item => item.kind === 'officecli');
  assert.equal(
    item.facts.some(fact => fact.code === 'office-skill-connected'),
    false,
  );
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: item.id }] });
  assert.equal(plan.items[0].problem, 'integration-source-conflict');
});

test('检查 OfficeCLI Skill：不暗示 MCP 状态', async t => {
  const f = await fixture(t);
  await f.installNpm();
  await f.installSkill();
  const item = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
  assert.ok(item.facts.some(fact => fact.code === 'office-skill-connected'));
  assert.equal(
    item.facts.some(fact => fact.code === 'connection-unchecked'),
    false,
  );
});

test('检查共享配置：每次快照只读一次', async t => {
  const counts = new Map();
  const f = await fixture(t, {
    read: async (file, base) => {
      counts.set(file, (counts.get(file) ?? 0) + 1);
      return base.read(file);
    },
  });
  await f.installNpm();
  await f.installSkill();
  await f.installMcp(f.binary);
  await f.ccw.inspect();
  const files = [f.stateFile, path.join(f.skill, 'SKILL.md'), path.join(f.claudeRoot, 'settings.json')];
  t.diagnostic(JSON.stringify(files.map(file => ({ file: path.basename(file), reads: counts.get(file) }))));
  assert.deepEqual(
    files.map(file => counts.get(file)),
    [1, 1, 1],
  );
  await f.installMcp('/unknown/officecli');
  const refreshed = await f.ccw.inspect();
  assert.deepEqual(
    files.map(file => counts.get(file)),
    [2, 2, 2],
  );
  assert.ok(refreshed.items.some(item => item.id === 'mcp:officecli'));
});

test('检查串行探测：共享剩余时间', async t => {
  let rootTimeout;
  const f = await fixture(t, {
    npm: npm => async (args, options) => {
      if (args[0] === 'ls' && args.at(-1) === packageName) await new Promise(resolve => setTimeout(resolve, 80));
      if (args[0] === 'root') rootTimeout = options.timeoutMs;
      return npm(args, options);
    },
  });
  await f.installNpm();
  const view = await f.ccw.inspect();
  assert.ok(view.items.some(item => item.kind === 'officecli'));
  assert.ok(rootTimeout > 0 && rootTimeout < 4_950, `remaining=${rootTimeout}`);
});

test('解除残留 OfficeCLI：无需程序存在', async t => {
  const f = await fixture(t);
  await f.installSkill();
  await f.installMcp('officecli');
  const document = path.join(f.home, 'documents', 'keep.docx');
  await f.write(document, 'user document');
  const office = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
  assert.ok(office.actions.includes('detach'));
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: office.id }] });
  assert.equal(plan.items[0].problem, null, JSON.stringify(plan));
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal((await f.read(f.stateFile)).mcpServers.officecli, undefined);
  assert.deepEqual((await f.read(f.stateFile)).projects, { keep: true });
  assert.equal(await fs.readFile(document, 'utf8'), 'user document');
  assert.equal(
    f.calls.some(call => call.kind === 'npm' && call.target === 'uninstall'),
    false,
  );
  assert.equal(await exists(f.skill), false);
});

test('解除残留 OfficeCLI：仅凭 frontmatter 同名不认领用户技能', async t => {
  const f = await fixture(t);
  await f.installSkill(false);
  const view = await f.ccw.inspect();
  const office = view.items.find(item => item.kind === 'officecli');
  assert.ok(office.actions.includes('install'));
  assert.equal(office.actions.includes('detach'), false, '无来源记录不提供解除');
  assert.ok(
    view.items.some(item => item.id === 'skill:officecli'),
    '用户技能仍独立显示',
  );
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: office.id }] });
  assert.equal(plan.items[0].problem, 'no-connection');
  assert.match(await fs.readFile(path.join(f.skill, 'SKILL.md'), 'utf8'), /officecli create file.docx/);
});

test('卸载 OfficeCLI 副本：保护其他接入', async t => {
  const f = await fixture(t);
  await f.installNpm();
  await f.write(f.native, 'native binary');
  await f.installSkill();
  await f.installMcp(f.native);
  f.state.locations = [f.launcher, f.native];
  const office = (await f.ccw.inspect()).items.filter(item => item.kind === 'officecli');
  assert.equal(office.length, 2);
  const npm = office.find(item => item.location === f.binary);
  const native = office.find(item => item.location === f.native);
  assert.ok(npm.facts.some(fact => fact.code === 'office-skill-connected'));
  assert.equal(
    npm.facts.some(fact => fact.code === 'office-mcp-connected'),
    false,
  );
  assert.ok(native.facts.some(fact => fact.code === 'office-mcp-connected'));
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: npm.id }] });
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal((await f.read(f.stateFile)).mcpServers.officecli.command, f.native);
  assert.equal(await fs.readFile(f.native, 'utf8'), 'native binary');
  assert.equal(await exists(f.skill), false);
});

test('准备混合 OfficeCLI 副本：拒绝重复接入', async t => {
  const f = await fixture(t, { npm: withNpmView });
  await f.installNpm();
  await f.write(f.native, 'native binary');
  await f.installMcp(f.native);
  f.state.locations = [f.launcher, f.native];
  const items = (await f.ccw.inspect()).items.filter(item => item.kind === 'officecli');
  const selectedNpm = items.find(item => item.location === f.binary);
  const native = items.find(item => item.location === f.native);
  const plan = await f.ccw.plan({
    task: 'install',
    selected: [
      { id: selectedNpm.id, maintenance: 'update', fields: { connection: 'mcp' } },
      { id: native.id, fields: { connection: 'mcp' } },
      { id: 'mcp:officecli' },
    ],
  });
  assert.equal(plan.items.find(item => item.id === 'mcp:officecli').problem, 'overlapping-selection');
});

test('安装 OfficeCLI：补齐技能并保留已有 MCP', async t => {
  const revision = 'b'.repeat(40);
  const f = await fixture(t, {
    npm: npm => async (args, options) =>
      args[0] === 'view' && args[2] === 'gitHead' ? ok(JSON.stringify(revision)) : npm(args, options),
    source: async (repository, commit, folder) => {
      assert.equal(repository, 'https://github.com/iOfficeAI/OfficeCLI');
      assert.equal(commit, revision);
      assert.equal(folder, 'skills/officecli');
      return [
        {
          path: 'SKILL.md',
          data: Buffer.from('---\nname: officecli\ndescription: bundled tool skill\n---\nOfficeCLI instructions'),
        },
      ];
    },
  });
  await f.installNpm();
  await f.installMcp('officecli');
  const registration = await fs.readFile(f.stateFile, 'utf8');
  const office = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: office.id }] });
  assert.equal(plan.items[0].problem, null, JSON.stringify(plan));
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.equal(await exists(f.skill), true);
  assert.equal(
    f.calls.some(call => call.args.includes('--version')),
    false,
  );
  assert.equal(await fs.readFile(f.stateFile, 'utf8'), registration);
});

test('解除 OfficeCLI：保留 npm 程序', async t => {
  const f = await fixture(t);
  await f.installNpm();
  await f.installMcp('officecli');
  const office = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: office.id, removal: 'detach' }] });
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.equal(await fs.readFile(f.binary, 'utf8'), 'npm binary');
  assert.equal(f.state.npm, true);
  assert.equal((await f.read(f.stateFile)).mcpServers.officecli, undefined);
});

test('重试卸载 OfficeCLI：保护重建入口', async t => {
  const f = await fixture(t);
  await f.installNpm();
  await f.installSkill();
  await f.installMcp(f.binary);
  const office = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
  f.state.failUninstall = true;
  let plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: office.id }] });
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'partial', JSON.stringify(first));
  assert.ok(first.remaining);
  await f.installSkill();
  f.state.failUninstall = false;
  const count = f.calls.filter(call => call.args[0] === 'uninstall').length;
  plan = await f.ccw.plan({ resume: first.remaining });
  const next = await f.ccw.apply(plan.id);
  assert.equal(next.state, 'failed', JSON.stringify(next));
  assert.equal(f.calls.filter(call => call.args[0] === 'uninstall').length, count);
  assert.equal(f.state.npm, true);
  assert.match(await fs.readFile(path.join(f.skill, 'SKILL.md'), 'utf8'), /name: officecli/);
});

test('管理同名 OfficeCLI：保护未知入口', async t => {
  const f = await fixture(t);
  await f.installNpm();
  await f.write(path.join(f.skill, 'SKILL.md'), '---\nname: unrelated\n---\nuser workflow');
  await f.installMcp('/some/other/program');
  const view = await f.ccw.inspect();
  assert.ok(view.items.some(item => item.id === 'skill:officecli'));
  assert.ok(view.items.some(item => item.id === 'mcp:officecli'));
  for (const item of view.items.filter(item => ['skill:officecli', 'mcp:officecli'].includes(item.id)))
    assert.ok(describeItem(item).startsWith('officecli\n'), '未知同名入口保留原始名称');
  const office = view.items.find(item => item.kind === 'officecli');
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: office.id }] });
  assert.equal(plan.items[0].problem, 'integration-source-conflict');
  assert.match(await fs.readFile(path.join(f.skill, 'SKILL.md'), 'utf8'), /user workflow/);
  const removal = await f.ccw.plan({ task: 'uninstall', selected: [{ id: office.id }] });
  assert.deepEqual(
    removal.items[0].changes
      .filter(change => change.code === 'unmatched-integration-kept')
      .map(change => change.detail),
    [f.skill, 'officecli'],
    '未知同名入口按实际键名保留',
  );
});

for (const entry of ['MCP', 'Skill'])
  test(`新增关联 ${entry}：阻止卸载 OfficeCLI`, async t => {
    const f = await fixture(t);
    await f.installNpm();
    const office = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
    const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: office.id }] });
    assert.equal(plan.items[0].problem, null);
    if (entry === 'MCP') await f.installMcp(f.binary);
    else await f.installSkill();
    const result = await f.ccw.apply(plan.id);
    assert.equal(result.state, 'failed', JSON.stringify(result));
    assert.ok(result.items[0].effects.some(effect => effect.code === 'target-changed'));
    assert.equal(await fs.readFile(f.binary, 'utf8'), 'npm binary');
    assert.equal(
      f.calls.some(call => call.args[0] === 'uninstall'),
      false,
    );
    if (entry === 'MCP') assert.equal((await f.read(f.stateFile)).mcpServers.officecli.command, f.binary);
    else assert.match(await fs.readFile(path.join(f.skill, 'SKILL.md'), 'utf8'), /name: officecli/);
  });

test('变更无关注册：继续卸载 OfficeCLI', async t => {
  const f = await fixture(t);
  await f.installNpm();
  const office = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: office.id }] });
  await f.installMcp('/some/other/officecli');
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal((await f.read(f.stateFile)).mcpServers.officecli.command, '/some/other/officecli');
  assert.equal(f.state.npm, false);
});

test('卸载失败后新增 MCP：阻止继续卸载', async t => {
  const f = await fixture(t);
  await f.installNpm();
  f.state.failUninstall = true;
  const office = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
  let plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: office.id }] });
  const first = await f.ccw.apply(plan.id);
  assert.ok(first.remaining);
  await f.installMcp(f.binary);
  f.state.failUninstall = false;
  const count = f.calls.filter(call => call.args[0] === 'uninstall').length;
  plan = await f.ccw.plan({ resume: first.remaining });
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'failed', JSON.stringify(result));
  assert.equal(f.calls.filter(call => call.args[0] === 'uninstall').length, count);
  assert.equal(f.state.npm, true);
  assert.equal((await f.read(f.stateFile)).mcpServers.officecli.command, f.binary);
});

test('解除 OfficeCLI 接入：串行修改注册', async t => {
  const f = await fixture(t);
  await f.installNpm();
  await f.installMcp(f.binary);
  const state = await f.read(f.stateFile);
  state.mcpServers.other = { command: 'keep shared runtime' };
  await f.write(f.stateFile, JSON.stringify(state));
  const office = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
  let active = 0;
  let maximum = 0;
  f.faults.editJson.set(f.stateFile, async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
  });
  const plan = await f.ccw.plan({ task: 'detach', selected: [{ id: office.id }, { id: 'mcp:other' }] });
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(maximum, 1);
  assert.deepEqual((await f.read(f.stateFile)).mcpServers, {});
  assert.equal(f.state.npm, true);
});

for (const annotated of [false, true])
  test(`获取 OfficeCLI 技能：使用 ${annotated ? 'annotated tag' : 'commit tag'}`, async t => {
    const commit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const tag = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const fetched = [];
    const f = await fixture(t, {
      fetchText: async url => {
        fetched.push(url);
        if (url.includes('registry.npmjs.org')) throw new Error('registry-version-not-found');
        if (url === 'https://api.github.com/repos/iOfficeAI/OfficeCLI/git/ref/tags/v1.0.123')
          return JSON.stringify({
            ref: 'refs/tags/v1.0.123',
            object: { type: annotated ? 'tag' : 'commit', sha: annotated ? tag : commit },
          });
        if (url === `https://api.github.com/repos/iOfficeAI/OfficeCLI/git/tags/${tag}`)
          return JSON.stringify({ sha: tag, object: { type: 'commit', sha: commit } });
        throw new Error('unexpected-network');
      },
      source: async (repository, revision, folder) => {
        assert.equal(repository, 'https://github.com/iOfficeAI/OfficeCLI');
        assert.equal(revision, commit);
        assert.equal(folder, 'skills/officecli');
        return [{ path: 'SKILL.md', data: Buffer.from('---\nname: officecli\n---\npublished native skill') }];
      },
    });
    await f.write(f.native, 'native OfficeCLI binary');
    f.state.locations = [f.native];
    const office = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
    const plan = await f.ccw.plan({ task: 'install', selected: [{ id: office.id }] });
    assert.equal(plan.items[0].problem, null, JSON.stringify(plan));
    assert.equal((await f.ccw.apply(plan.id)).state, 'done');
    assert.match(await fs.readFile(path.join(f.skill, 'SKILL.md'), 'utf8'), /published native skill/);
    assert.equal(
      fetched.some(url => url.includes('registry.npmjs.org')),
      false,
    );
    assert.equal(
      fetched.some(url => url.includes('/git/tags/')),
      annotated,
    );
    const metadata = await f.read(path.join(f.home, '.ccw', 'sources.json'));
    assert.equal(metadata[f.skill].revision, commit);
  });

test('卸载 OfficeCLI：保护替换后的用户技能', async t => {
  const f = await fixture(t);
  await f.installNpm();
  await f.installSkill();
  const stamp = await f.machine.treeStamp(f.skill);
  await f.write(
    path.join(f.home, '.ccw', 'sources.json'),
    JSON.stringify({ [f.skill]: { repository: 'https://github.com/iOfficeAI/OfficeCLI', stamp } }),
  );
  await f.write(path.join(f.skill, 'SKILL.md'), '---\nname: user-notes\n---\nuser-owned content');
  const view = await f.ccw.inspect();
  assert.ok(view.items.some(item => item.id === 'skill:officecli'));
  const office = view.items.find(item => item.kind === 'officecli');
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: office.id }] });
  assert.equal(plan.items[0].problem, null);
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.match(await fs.readFile(path.join(f.skill, 'SKILL.md'), 'utf8'), /user-owned content/);
  assert.ok(result.items[0].effects.some(effect => effect.code === 'unmatched-integration-kept'));
});

const officeRevision = 'a'.repeat(40);
const officePayload = Buffer.from('OfficeCLI native release payload');
const officeDigest = createHash('sha256').update(officePayload).digest('hex');

/** 原生安装世界：GitHub 释放合同经 fixture fetchText 机制注入，fetch/bytes/replaceFile 记入 calls，故障开关沿用 full-flow 语义 */
async function releaseFixture(t) {
  const asset = `officecli-linux-${process.arch}`;
  const f = await fixture(t, {
    source: async (repository, commit, folder) => {
      assert.equal(repository, 'https://github.com/iOfficeAI/OfficeCLI');
      assert.equal(commit, officeRevision);
      assert.equal(folder, 'skills/officecli');
      return [{ path: 'SKILL.md', data: Buffer.from('---\nname: officecli\n---\nOfficeCLI instructions') }];
    },
  });
  Object.assign(f.state, { sourceFailure: false, failReplaceTree: null, fail: '' });
  const release = releaseContract({ tag: 'v1.0.123', asset, digest: officeDigest, revision: officeRevision });
  f.machine.fetchText = async url => {
    f.calls.push({ kind: 'fetch', target: url });
    return release.fetchText(url);
  };
  f.machine.fetchBytes = async url => {
    f.calls.push({ kind: 'bytes', target: url });
    assert.equal(url, release.release + asset);
    return officePayload;
  };
  const replaceFile = f.machine.replaceFile;
  f.machine.replaceFile = async (file, data, expected, executable) => {
    f.calls.push({ kind: 'replaceFile', target: file });
    if (f.state.fail === 'office-native-replace' && file === f.native) throw new Error('office-native-replace-failed');
    return replaceFile(file, data, expected, executable);
  };
  const replaceTree = f.machine.replaceTree;
  f.machine.replaceTree = async (...args) => {
    if (f.state.failReplaceTree) throw new Error('fixture-write-failed');
    return replaceTree(...args);
  };
  const source = f.machine.source;
  f.machine.source = async (...args) => {
    if (f.state.sourceFailure) throw new Error('source-unavailable');
    return source(...args);
  };
  // createReadMachine 在构造时展开 machine；replaceFile/replaceTree 故障包装必须先于 ccw 构造就位
  return {
    ...f,
    ccw: createCcw({
      machine: f.machine,
      home: f.home,
      claudeRoot: f.claudeRoot,
      cclineRoot: f.cclineRoot,
      platform: 'linux',
    }),
  };
}

test('准备 OfficeCLI 资源失败：不安装程序', async t => {
  const f = await releaseFixture(t);
  f.state.sourceFailure = true;
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'officecli' }] });
  assert.equal(plan.items[0].problem, 'source-unavailable');
  assert.equal((await f.ccw.apply(plan.id)).state, 'failed');
  assert.equal(
    f.calls.some(call => call.kind === 'replaceFile'),
    false,
  );
  assert.equal(await exists(f.native), false);
});

test('重试 OfficeCLI 接入：保留已装程序与资源', async t => {
  const f = await releaseFixture(t);
  f.state.failReplaceTree = true;
  const install = await f.ccw.plan({
    task: 'install',
    selected: [{ id: 'officecli', fields: { connection: 'both' } }],
  });
  assert.equal(install.items[0].problem, null, JSON.stringify(install));
  const first = await f.ccw.apply(install.id);
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  f.state.failReplaceTree = null;
  f.state.sourceFailure = true;
  f.calls.length = 0;
  const resume = await f.ccw.plan({ resume: first.remaining });
  assert.equal(resume.items[0].problem, null, JSON.stringify(resume));
  const retry = await f.ccw.apply(resume.id);
  assert.equal(retry.state, 'done', JSON.stringify(retry));
  assert.equal(
    f.calls.some(call => call.kind === 'npm' && call.target === 'install'),
    false,
  );
  assert.equal(
    f.calls.some(
      call =>
        ['bytes', 'replaceFile'].includes(call.kind) || (call.kind === 'fetch' && call.target.includes('/releases/')),
    ),
    false,
  );
  assert.ok((await f.read(f.stateFile)).mcpServers.officecli);
  assert.ok(await fs.stat(path.join(f.claudeRoot, 'skills/officecli/SKILL.md')));
});

async function installOfficeCli(f) {
  const install = await f.ccw.plan({
    task: 'install',
    selected: [{ id: 'officecli', fields: { connection: 'both' } }],
  });
  assert.equal(install.items[0].problem, null, JSON.stringify(install));
  return f.ccw.apply(install.id);
}

test('重装 OfficeCLI 失败：保留原技能副本', async t => {
  const f = await releaseFixture(t);
  assert.equal((await installOfficeCli(f)).state, 'done');
  const other = path.join(f.home, '.agents/skills/officecli/SKILL.md');
  await f.write(other, 'other client');
  f.state.locations = [f.native];
  const item = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: item.id, maintenance: 'reinstall' }] });
  assert.equal(plan.items[0].problem, null);
  const backup = plan.items[0].changes.find(change => change.code === 'preserved-at').detail;
  f.state.fail = 'office-native-replace';
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'partial');
  assert.equal((await f.read(f.stateFile)).mcpServers.officecli, undefined);
  assert.equal(
    await fs.stat(path.join(f.claudeRoot, 'skills/officecli')).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.ok(await fs.stat(path.join(backup, 'SKILL.md')));
  assert.equal(await fs.readFile(other, 'utf8'), 'other client');
  f.state.fail = '';
  const resume = await f.ccw.plan({ resume: result.remaining });
  assert.equal(resume.items[0].problem, null, JSON.stringify(resume));
  assert.equal((await f.ccw.apply(resume.id)).state, 'done');
  assert.ok((await f.read(f.stateFile)).mcpServers.officecli);
});

test('重装 OfficeCLI：恢复接入并检查重叠', async t => {
  const f = await releaseFixture(t);
  assert.equal((await installOfficeCli(f)).state, 'done');
  f.state.locations = [f.native];
  const item = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
  const reinstall = await f.ccw.plan({ task: 'install', selected: [{ id: item.id, maintenance: 'reinstall' }] });
  assert.equal(reinstall.items[0].problem, null, JSON.stringify(reinstall));
  assert.equal((await f.ccw.apply(reinstall.id)).state, 'done');
  assert.ok((await f.read(f.stateFile)).mcpServers.officecli);
  const overlapping = await f.ccw.plan({
    task: 'install',
    selected: [{ id: item.id, maintenance: 'reinstall' }, { id: 'mcp:officecli' }],
  });
  assert.equal(overlapping.items[1].problem, 'overlapping-selection');
});

test('卸载 OfficeCLI：组合选择检查重叠', async t => {
  const f = await releaseFixture(t);
  assert.equal((await installOfficeCli(f)).state, 'done');
  f.state.locations = [f.native];
  const item = (await f.ccw.inspect()).items.find(item => item.kind === 'officecli');
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: item.id }, { id: 'mcp:officecli' }] });
  assert.equal(plan.items[0].problem, null, JSON.stringify(plan));
  assert.equal(plan.items[1].problem, 'overlapping-selection');
});
