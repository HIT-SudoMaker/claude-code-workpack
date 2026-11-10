import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createCcw } from '../dist/ccw.js';
import { npmConfig, createEnv, exists, ok, releaseContract } from './env.mjs';

const bytes = Buffer.from('fixed native OfficeCLI release payload');
const checksum = createHash('sha256').update(bytes).digest('hex');
const revision = 'c8b1b37768bc9c48b53c013e340412376d8268df';
const assetNames = [
  'officecli-win-x64.exe',
  'officecli-win-arm64.exe',
  'officecli-mac-x64',
  'officecli-mac-arm64',
  'officecli-linux-x64',
  'officecli-linux-arm64',
  'officecli-linux-alpine-x64',
  'officecli-linux-alpine-arm64',
];

/** 外部命令是否按完整命令行执行过（calls 形态见 env.mjs） */
const ranExecute = (f, command) =>
  f.calls.some(
    call =>
      call.kind === 'execute' &&
      call.target === command[0] &&
      JSON.stringify(call.args) === JSON.stringify(command.slice(1)),
  );

async function fixture(t, platform = process.platform, extra = {}) {
  const f = await createEnv(t, {
    layout: 'home',
    seed: {
      settings: { language: 'English', env: { ANTHROPIC_API_KEY: 'isolated-test-key' } },
      state: { projects: { keep: true } },
    },
  });
  const npmRoot = path.join(f.root, 'npm/node_modules');
  const nativeClaude = path.join(f.home, '.local/bin', platform === 'win32' ? 'claude.exe' : 'claude');
  const nativeOffice =
    platform === 'win32'
      ? path.join(f.home, 'AppData/Local/OfficeCli/officecli.exe')
      : path.join(f.home, '.local/bin/officecli');
  const brew = path.join(f.root, 'bin/brew');
  const packages = new Map();
  const state = {
    release: '1.0.123',
    running: false,
    commandFails: false,
    leaveProgram: false,
    checksumBad: false,
    pathFails: false,
    confirming: false,
    registryUnavailable: false,
    failStateFileRemove: false,
    swapStateFileAtFingerprint: false,
    failClaudeVersionsTree: false,
    npmFailure: null,
    officecliVersion: '1.0.123 OfficeCLI',
    officecliHelp: null,
    brewVersionsUnknown: false,
    managedFails: false,
    managed: null,
    ownership: null,
    scoopPrefix: null,
    sourceGate: null,
    located: new Map(),
  };
  await f.write(path.join(f.home, 'document.docx'), 'user document');
  await f.write(brew, 'test Homebrew manager');
  const base = f.machine({
    locate: async name => state.located.get(name) ?? [],
    processes: async () => (state.running ? [{ name: 'claude.exe', command: 'claude --resume' }] : []),
    npm: async args => {
      if (state.npmFailure !== null) return { code: null, failed: true, stdout: '', ...state.npmFailure };
      if (args[0] === 'config') return npmConfig(args);
      if (args[0] === 'ls' && state.confirming && state.registryUnavailable)
        return { code: null, failed: true, stdout: '' };
      const name = args.at(-1);
      if (args[0] === 'root') return ok(npmRoot);
      if (args[0] === 'ls')
        return ok(
          JSON.stringify({ dependencies: packages.has(name) ? { [name]: { version: packages.get(name) } } : {} }),
        );
      if (args[0] === 'uninstall') {
        if (!state.leaveProgram) {
          packages.delete(name);
          await fs.rm(path.join(npmRoot, name), { recursive: true, force: true });
        }
        state.confirming = true;
        return { code: state.commandFails ? 1 : 0, failed: false, stdout: '' };
      }
      throw new Error(`unexpected-npm-${args[0]}`);
    },
    execute: async (file, args, options) => {
      if (state.managed !== null && file === state.managed.command[0] && args[0] === state.managed.command[1]) {
        await fs.unlink(state.managed.binary);
        state.managed.removed = true;
        return { code: state.managedFails ? 1 : 0, failed: false, stdout: '' };
      }
      if (file === 'rpm' && args[0] === '-qa') return ok(state.managed?.removed ? '' : 'claude-code');
      if (file === 'dpkg-query' && args[0] === '-W') return ok(state.managed?.removed ? '' : 'claude-code installed');
      if (file === 'apk' && args.length === 1 && args[0] === 'info')
        return ok(state.managed?.removed ? '' : 'claude-code');
      if (['dpkg-query', 'rpm', 'apk'].includes(file) && args[0] !== 'del')
        return state.ownership !== null && file in state.ownership
          ? ok(state.ownership[file])
          : { code: 1, failed: false, stdout: '' };
      if (file === 'scoop' && args[0] === 'prefix' && state.scoopPrefix !== null) return ok(state.scoopPrefix);
      if (file === brew) {
        if (args[0] === '--cellar' || args[0] === '--caskroom')
          return ok(path.join(f.root, args[0] === '--cellar' ? 'Cellar' : 'Caskroom'));
        if (args[0] === 'list') {
          // 带包名的登记复核读真实目录；无包名的卸载复核由测试翻转 brewVersionsUnknown
          if (args.at(-1) === '--versions')
            return state.brewVersionsUnknown ? { code: null, failed: true, stdout: '' } : ok('');
          const directory = path.join(f.root, args.includes('--cask') ? 'Caskroom' : 'Cellar');
          const names = await fs.readdir(directory).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
          });
          const registrations = await Promise.all(
            names.map(async name => `${name} ${(await fs.readdir(path.join(directory, name))).join(' ')}`),
          );
          return ok(registrations.join('\n'));
        }
      }
      if (args[0] === '--version') {
        if (file === nativeOffice) {
          assert.equal(options.env.OFFICECLI_SKIP_UPDATE, '1');
          assert.equal(options.env.OFFICECLI_NO_AUTO_INSTALL, '1');
          return ok(state.officecliVersion);
        }
        return ok('2.1.311 Claude Code');
      }
      if (file === nativeOffice && state.officecliHelp !== null) return ok(state.officecliHelp);
      return ok();
    },
  });
  const machine = {
    ...base,
    async fetchText(url) {
      f.calls.push({ kind: 'fetch', target: url });
      return releaseContract({
        tag: `v${state.release}`,
        asset: assetNames,
        digest: checksum,
        revision,
        also: url => {
          if (url.includes('registry.npmjs.org')) return JSON.stringify({ gitHead: revision });
          throw new Error('unexpected-fetch');
        },
      }).fetchText(url);
    },
    async fetchBytes(url) {
      f.calls.push({ kind: 'binary', target: url });
      return state.checksumBad ? Buffer.from('bad release bytes') : bytes;
    },
    userPathContains: async () => state.pathConfigured === true,
    async ensureUserPath(directory) {
      f.calls.push({ kind: 'path', target: directory });
      if (state.pathFails) throw new Error('user-path-write-failed');
      state.pathConfigured = true;
    },
    async source(repository, commit, _folder, options) {
      if (state.sourceGate !== null) return state.sourceGate(options);
      f.calls.push({ kind: 'source', target: repository, args: [commit] });
      return [{ path: 'SKILL.md', data: Buffer.from('---\nname: officecli\n---\nUse officecli to edit documents.\n') }];
    },
    async remove(...args) {
      if (state.failStateFileRemove && args[0] === f.stateFile) throw new Error('state-removal-failed');
      return base.remove(...args);
    },
    async removeTree(...args) {
      f.calls.push({ kind: 'removeTree', target: args[0] });
      if (state.failClaudeVersionsTree && args[0].endsWith(path.join('.local/share/claude')))
        throw new Error('version-removal-failed');
      return base.removeTree(...args);
    },
    async treeStamp(...args) {
      const stamp = await base.treeStamp(...args);
      if (state.swapStateFileAtFingerprint && args[0] === f.stateFile) {
        state.swapStateFileAtFingerprint = false;
        await fs.unlink(f.stateFile);
        await f.write(path.join(f.stateFile, 'keep.txt'), 'new directory content');
      }
      return stamp;
    },
  };
  const ccw = f.ccw(machine, { platform, ...extra });
  const seedNpm = async kind => {
    const name = kind === 'claude' ? '@anthropic-ai/claude-code' : '@officecli/officecli';
    packages.set(name, kind === 'claude' ? '2.1.311' : '1.0.123');
    await f.write(path.join(npmRoot, name, 'package.json'), JSON.stringify({ name, bin: { claude: 'cli.js' } }));
    const binary = path.join(
      npmRoot,
      name,
      kind === 'claude' ? 'cli.js' : `vendor/officecli${platform === 'win32' ? '.exe' : ''}`,
    );
    await f.write(binary, 'npm program');
    return binary;
  };
  const seedNativeClaude = async () => {
    await f.write(nativeClaude, 'native Claude program');
    await f.write(path.join(f.home, '.local/share/claude/versions/2.1.311'), 'native Claude program');
  };
  const apply = async request => {
    const plan = await ccw.plan(request);
    assert.equal(plan.problem, null);
    assert.ok(
      plan.items.every(item => item.problem === null),
      JSON.stringify(plan),
    );
    return ccw.apply(plan.id);
  };
  return {
    ...f,
    npmRoot,
    nativeClaude,
    nativeOffice,
    machine,
    ccw,
    packages,
    state,
    seedNpm,
    seedNativeClaude,
    apply,
  };
}

for (const platform of ['win32', 'darwin', 'linux'])
  test(`${platform} 卸载 npm Claude：保留数据`, async t => {
    const f = await fixture(t, platform);
    const binary = await f.seedNpm('claude');
    await f.write(path.join(f.claudeRoot, 'projects/session.jsonl'), 'saved session');
    const settings = await fs.readFile(path.join(f.claudeRoot, 'settings.json'), 'utf8');
    const item = (await f.ccw.inspect()).items.find(value => value.kind === 'claude');
    assert.ok(item.actions.includes('uninstall'));
    const result = await f.apply({ task: 'uninstall', selected: [{ id: item.id }] });
    assert.equal(result.state, 'done', JSON.stringify(result));
    assert.equal(await exists(binary), false);
    assert.equal(await fs.readFile(path.join(f.claudeRoot, 'settings.json'), 'utf8'), settings);
    assert.equal(await fs.readFile(path.join(f.claudeRoot, 'projects/session.jsonl'), 'utf8'), 'saved session');
    assert.equal(await fs.readFile(path.join(f.home, 'document.docx'), 'utf8'), 'user document');
    assert.ok(
      f.calls.some(
        call => call.kind === 'npm' && call.target === 'uninstall' && call.args.at(-1) === '@anthropic-ai/claude-code',
      ),
    );
  });

test('卸载原生 Claude：删除程序与版本', async t => {
  const f = await fixture(t);
  await f.seedNativeClaude();
  await f.write(path.join(f.home, '.local/bin/other-tool'), 'shared tool');
  const result = await f.apply({ task: 'uninstall', selected: [{ id: 'claude' }] });
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(await exists(f.nativeClaude), false);
  assert.equal(
    await fs.stat(path.join(f.home, '.local/share/claude')).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.equal(await fs.readFile(path.join(f.home, '.local/bin/other-tool'), 'utf8'), 'shared tool');
});

test('完整卸载 Claude：删除用户数据', async t => {
  const f = await fixture(t);
  await f.seedNpm('claude');
  await f.write(path.join(f.claudeRoot, 'unknown/nested/file.txt'), 'included in full directory removal');
  await f.write(path.join(f.home, '.codex/history.jsonl'), 'keep Codex');
  const shared = path.join(f.root, 'shared skills');
  await f.write(path.join(shared, 'SKILL.md'), 'keep shared source');
  await fs.mkdir(path.join(f.claudeRoot, 'skills'), { recursive: true });
  await fs.symlink(shared, path.join(f.claudeRoot, 'skills/shared'), 'junction');
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'claude' }], removeData: true });
  assert.ok(
    plan.items.every(item => item.problem === null),
    JSON.stringify(plan),
  );
  assert.equal(plan.items.at(-1).id, 'data:claude');
  assert.deepEqual(
    plan.items
      .at(-1)
      .changes.filter(change => change.detail)
      .map(change => change.detail),
    [f.claudeRoot, f.stateFile],
  );
  assert.ok(plan.items.every(item => !item.changes.some(change => change.code === 'keep-user-data')));
  assert.ok(await fs.stat(f.claudeRoot));
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(await exists(f.claudeRoot), false);
  assert.equal(await exists(f.stateFile), false);
  assert.equal(await fs.readFile(path.join(f.home, 'document.docx'), 'utf8'), 'user document');
  assert.equal(await fs.readFile(path.join(f.home, '.codex/history.jsonl'), 'utf8'), 'keep Codex');
  assert.equal(await fs.readFile(path.join(shared, 'SKILL.md'), 'utf8'), 'keep shared source');
  assert.ok(result.items.at(-1).effects.some(effect => effect.code === 'claude-data-cleared'));
});

test('删除自定义 Claude 根：保留默认根', async t => {
  const f = await fixture(t);
  await f.seedNpm('claude');
  const custom = path.join(f.home, 'custom claude');
  await f.write(path.join(custom, 'settings.json'), '{"env":{"ANTHROPIC_API_KEY":"isolated-custom-key"}}');
  await f.write(path.join(custom, '.claude.json'), '{"projects":{}}');
  const ccw = createCcw({
    machine: f.machine,
    home: f.home,
    claudeRoot: custom,
    cclineRoot: path.join(custom, 'ccline'),
    platform: process.platform,
  });
  const plan = await ccw.plan({
    task: 'uninstall',
    selected: [{ id: 'claude' }, { id: 'settings' }],
    removeData: true,
  });
  assert.ok(
    plan.items.every(item => item.problem === null),
    JSON.stringify(plan),
  );
  assert.deepEqual(
    plan.items
      .at(-1)
      .changes.filter(change => change.detail)
      .map(change => change.detail),
    [custom],
  );
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  assert.equal(await exists(custom), false);
  assert.ok(await fs.stat(path.join(f.claudeRoot, 'settings.json')));
  assert.equal(await fs.readFile(f.stateFile, 'utf8'), '{"projects":{"keep":true}}');
});

test('卸载 Claude 失败：保留用户数据', async t => {
  const f = await fixture(t);
  await f.seedNpm('claude');
  f.state.leaveProgram = true;
  const first = await f.apply({ task: 'uninstall', selected: [{ id: 'claude' }], removeData: true });
  assert.equal(first.state, 'failed');
  assert.ok(first.remaining);
  assert.equal(first.items.at(-1).effects.at(-1).code, 'dependency-not-ready');
  assert.ok(await fs.stat(path.join(f.claudeRoot, 'settings.json')));
  const attempts = f.calls.filter(call => call.kind === 'npm' && call.target === 'uninstall').length;
  const stillUnknown = await f.apply({ resume: first.remaining });
  assert.equal(stillUnknown.state, 'failed');
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'uninstall').length, attempts);
  await fs.rm(path.join(f.npmRoot, '@anthropic-ai/claude-code'), { recursive: true });
  f.packages.delete('@anthropic-ai/claude-code');
  f.state.leaveProgram = false;
  const resumed = await f.apply({ resume: first.remaining });
  assert.equal(resumed.state, 'done', JSON.stringify(resumed));
  assert.equal(await exists(f.claudeRoot), false);
});

test('卸载后重启 Claude：阻止删除数据', async t => {
  const f = await fixture(t);
  await f.seedNpm('claude');
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'claude' }], removeData: true });
  const first = await f.ccw.apply(plan.id, undefined, event => {
    if (event.kind === 'effect' && event.effect.code === 'program-removed') f.state.running = true;
  });
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  assert.ok(first.items.some(item => item.effects.some(effect => effect.code === 'claude-running')));
  assert.equal(first.items.at(-1).effects.at(-1).code, 'dependency-not-ready');
  assert.ok(await fs.stat(path.join(f.claudeRoot, 'settings.json')));
  f.state.running = false;
  assert.equal((await f.apply({ resume: first.remaining })).state, 'done');
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'uninstall').length, 1);
});

test('取消数据删除：仅重试剩余状态', async t => {
  const f = await fixture(t);
  await f.seedNpm('claude');
  const abort = new AbortController();
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'claude' }], removeData: true });
  const first = await f.ccw.apply(plan.id, abort.signal, event => {
    if (event.kind === 'effect' && event.effect.code === 'claude-data-removed' && event.effect.detail === f.claudeRoot)
      abort.abort();
  });
  assert.equal(first.state, 'cancelled');
  assert.ok(first.remaining);
  assert.ok(await fs.stat(f.stateFile));
  assert.equal((await f.apply({ resume: first.remaining })).state, 'done');
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'uninstall').length, 1);
});

for (const recreate of [false, true])
  test(`重试删除数据：${recreate ? '保留重建目录' : '仅删除剩余状态'}`, async t => {
    const f = await fixture(t);
    await f.seedNpm('claude');
    const stateFile = path.join(f.home, '.claude.json');
    f.state.failStateFileRemove = true;
    const first = await f.apply({ task: 'uninstall', selected: [{ id: 'claude' }], removeData: true });
    assert.equal(first.state, 'partial');
    assert.ok(first.remaining);
    assert.equal(await exists(f.claudeRoot), false);
    if (recreate) await f.write(path.join(f.claudeRoot, 'settings.json'), 'new external settings');
    f.state.failStateFileRemove = false;
    const resumed = await f.apply({ resume: first.remaining });
    assert.equal(resumed.state, recreate ? 'partial' : 'done', JSON.stringify(resumed));
    assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'uninstall').length, 1);
    if (recreate) {
      assert.equal(resumed.items.find(item => item.id === 'data:claude').effects.at(-1).code, 'target-changed');
      assert.equal(await fs.readFile(path.join(f.claudeRoot, 'settings.json'), 'utf8'), 'new external settings');
      assert.ok(await fs.stat(stateFile));
    } else assert.equal(await exists(stateFile), false);
  });

test('完整卸载 Claude：拒绝用户根和链接根', async t => {
  const f = await fixture(t);
  await f.seedNpm('claude');
  const linked = path.join(f.home, 'linked claude');
  await fs.symlink(f.claudeRoot, linked, 'junction');
  for (const [claudeRoot, code] of [
    [f.home, 'invalid-data-root'],
    [linked, 'linked-parent'],
  ]) {
    const ccw = createCcw({
      machine: f.machine,
      home: f.home,
      claudeRoot,
      cclineRoot: path.join(f.claudeRoot, 'ccline'),
      platform: process.platform,
    });
    const plan = await ccw.plan({ task: 'uninstall', selected: [{ id: 'claude' }], removeData: true });
    assert.equal(plan.items.at(-1).problem, code, JSON.stringify(plan));
    const failed = await ccw.apply(plan.id);
    assert.equal(failed.state, 'failed');
    await ccw.abandon(failed.remaining);
  }
  assert.equal(
    f.calls.some(call => call.kind === 'npm' && call.target === 'uninstall'),
    false,
  );
  assert.ok(await fs.stat(path.join(f.claudeRoot, 'settings.json')));
});

test('替换状态文件为目录：阻止递归删除', async t => {
  const f = await fixture(t);
  await f.seedNpm('claude');
  const stateFile = path.join(f.home, '.claude.json');
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'claude' }], removeData: true });
  f.state.swapStateFileAtFingerprint = true;
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'partial');
  assert.equal(await fs.readFile(path.join(stateFile, 'keep.txt'), 'utf8'), 'new directory content');
});

test('卸载 Claude 副本：保留其他安装', async t => {
  const f = await fixture(t);
  await f.seedNpm('claude');
  await f.seedNativeClaude();
  const item = (await f.ccw.inspect()).items.find(value => value.id.startsWith('claude:npm:'));
  const result = await f.apply({ task: 'uninstall', selected: [{ id: item.id }] });
  assert.equal(result.state, 'done');
  assert.equal(await fs.readFile(f.nativeClaude, 'utf8'), 'native Claude program');
  assert.ok(
    result.items[0].effects.some(
      effect => effect.code === 'program-other-copies-kept' && effect.detail === f.nativeClaude,
    ),
  );
});

test('确认 npm 卸载：以实际状态为准', async t => {
  const f = await fixture(t);
  await f.seedNpm('claude');
  f.state.commandFails = true;
  assert.equal((await f.apply({ task: 'uninstall', selected: [{ id: 'claude' }] })).state, 'done');
  await f.seedNpm('claude');
  f.state.commandFails = false;
  f.state.leaveProgram = true;
  const failed = await f.apply({ task: 'uninstall', selected: [{ id: 'claude' }] });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.items[0].effects.at(-1).code, 'program-removal-unconfirmed');
});

test('变更程序：阻止卸载', async t => {
  const f = await fixture(t);
  const binary = await f.seedNpm('claude');
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'claude' }] });
  await f.write(binary, 'external replacement');
  assert.equal((await f.ccw.apply(plan.id)).items[0].effects.at(-1).code, 'program-changed');
  assert.equal(
    f.calls.some(call => call.kind === 'npm' && call.target === 'uninstall'),
    false,
  );
});

test('运行中 Claude：拒绝卸载计划', async t => {
  const f = await fixture(t);
  await f.seedNpm('claude');
  f.state.running = true;
  const active = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'claude' }] });
  assert.equal(active.items[0].problem, 'claude-running');
});

test('重试原生卸载：保护重建入口', async t => {
  const f = await fixture(t);
  await f.seedNativeClaude();
  f.state.failClaudeVersionsTree = true;
  const first = await f.apply({ task: 'uninstall', selected: [{ id: 'claude' }] });
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  await f.write(f.nativeClaude, 'new external entry');
  f.state.failClaudeVersionsTree = false;
  const retry = await f.apply({ resume: first.remaining });
  assert.equal(retry.state, 'partial');
  assert.equal(retry.items[0].effects.at(-1).code, 'program-changed');
  assert.equal(f.calls.filter(call => call.kind === 'removeTree' && call.target === f.nativeClaude).length, 1);
});

for (const [platform, arch, libc, asset] of [
  ['win32', 'x64', undefined, 'officecli-win-x64.exe'],
  ['win32', 'arm64', undefined, 'officecli-win-arm64.exe'],
  ['darwin', 'x64', undefined, 'officecli-mac-x64'],
  ['darwin', 'arm64', undefined, 'officecli-mac-arm64'],
  ['linux', 'x64', 'glibc', 'officecli-linux-x64'],
  ['linux', 'arm64', 'musl', 'officecli-linux-alpine-arm64'],
])
  test(`${platform} ${arch} ${libc ?? ''} 安装原生 OfficeCLI`, async t => {
    const f = await fixture(t, platform, { arch, ...(libc ? { libc } : {}) });
    const result = await f.apply({ task: 'install', selected: [{ id: 'officecli' }] });
    assert.equal(result.state, 'done', JSON.stringify(result));
    assert.deepEqual(await fs.readFile(f.nativeOffice), bytes);
    assert.ok(f.calls.some(call => call.kind === 'binary' && call.target.endsWith(`/v1.0.123/${asset}`)));
    assert.ok(f.calls.some(call => call.kind === 'path' && call.target === path.dirname(f.nativeOffice)));
    assert.equal(
      f.calls.some(call => call.kind === 'npm' && call.target === 'install'),
      false,
    );
  });

test('下载校验失败：阻止写入 OfficeCLI', async t => {
  const f = await fixture(t);
  f.state.checksumBad = true;
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'officecli' }] });
  assert.equal(plan.items[0].problem, 'release-checksum-mismatch');
  assert.equal(await exists(f.nativeOffice), false);
});

test('重试 OfficeCLI PATH：复用下载资源', async t => {
  const f = await fixture(t);
  f.state.pathFails = true;
  const first = await f.apply({ task: 'install', selected: [{ id: 'officecli' }] });
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  const downloads = f.calls.filter(call => call.kind === 'binary').length;
  const releases = f.calls.filter(call => call.kind === 'fetch' && call.target.endsWith('/releases/latest')).length;
  f.state.pathFails = false;
  f.state.release = '1.0.124';
  assert.equal((await f.apply({ resume: first.remaining })).state, 'done');
  assert.equal(f.calls.filter(call => call.kind === 'binary').length, downloads);
  assert.equal(
    f.calls.filter(call => call.kind === 'fetch' && call.target.endsWith('/releases/latest')).length,
    releases,
  );
});

test('取消 OfficeCLI 技能准备：不安装程序', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  const entered = Promise.withResolvers();
  f.state.sourceGate = options => {
    assert.ok(options.signal);
    entered.resolve();
    return new Promise((_resolve, reject) =>
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
    );
  };
  const preparing = f.ccw.plan({ task: 'install', selected: [{ id: 'officecli' }] }, abort.signal);
  const cancelled = assert.rejects(preparing, /^Error: cancelled$/);
  await entered.promise;
  abort.abort();
  await cancelled;
  assert.equal(await exists(f.nativeOffice), false);
  assert.equal(
    await fs.stat(path.join(f.claudeRoot, 'skills/officecli')).then(
      () => true,
      () => false,
    ),
    false,
  );
  f.state.sourceGate = null;
  assert.equal((await f.apply({ task: 'install', selected: [{ id: 'officecli' }] })).state, 'done');
});

for (const [platform, channel, kind, relative, command] of [
  [
    'darwin',
    'brew',
    'claude',
    'Caskroom/claude-code@latest/2.1.311/claude',
    ['brew', 'uninstall', '--cask', 'claude-code@latest'],
  ],
  ['darwin', 'brew', 'officecli', 'Cellar/officecli/1.0.123/bin/officecli', ['brew', 'uninstall', 'officecli']],
  [
    'win32',
    'winget',
    'claude',
    'Microsoft/WinGet/Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe',
    ['winget', 'uninstall', '--id', 'Anthropic.ClaudeCode', '--exact', '--disable-interactivity'],
  ],
  ['win32', 'scoop', 'officecli', 'apps/officecli/1.0.123/officecli.exe', ['scoop', 'uninstall', 'officecli']],
  ['linux', 'apt', 'claude', 'usr/bin/claude', ['apt-get', 'remove', '--yes', 'claude-code']],
  ['linux', 'dnf', 'claude', 'usr/bin/claude', ['dnf', 'remove', '--assumeyes', 'claude-code']],
  ['linux', 'apk', 'claude', 'usr/bin/claude', ['apk', 'del', 'claude-code']],
])
  test(`${channel} 卸载 ${kind}：使用原管理器`, async t => {
    const f = await fixture(t, platform);
    const binary = path.join(channel === 'scoop' ? path.join(f.home, 'scoop') : f.root, relative);
    await f.write(binary, 'package managed binary');
    if (channel === 'scoop')
      await f.write(
        path.join(path.dirname(binary), 'manifest.json'),
        '{"homepage":"https://github.com/iOfficeAI/OfficeCLI"}',
      );
    f.state.located.set(kind, [binary]);
    const expected = channel === 'brew' ? [path.join(f.root, 'bin/brew'), ...command.slice(1)] : command;
    f.state.managed = { command: [expected[0], expected[1]], binary };
    if (channel === 'scoop') f.state.scoopPrefix = path.dirname(binary);
    if (channel === 'apt') f.state.ownership = { 'dpkg-query': `claude-code: ${binary}` };
    if (channel === 'dnf') f.state.ownership = { rpm: 'claude-code' };
    if (channel === 'apk') f.state.ownership = { apk: `${binary} is owned by claude-code-2.1.311-r0` };
    const selected = (await f.ccw.inspect()).items.find(item => item.id.startsWith(`${kind}:${channel}:`));
    assert.ok(selected, JSON.stringify(await f.ccw.inspect()));
    const result = await f.apply({ task: 'uninstall', selected: [{ id: selected.id }] });
    assert.equal(result.state, 'done', JSON.stringify(result));
    assert.ok(ranExecute(f, expected));
  });

for (const [platform, channel, action, relative, command] of [
  ['darwin', 'brew', 'update', 'Cellar/officecli/1.0.123/bin/officecli', ['brew', 'upgrade', 'officecli']],
  ['darwin', 'brew', 'reinstall', 'Cellar/officecli/1.0.123/bin/officecli', ['brew', 'reinstall', 'officecli']],
  ['win32', 'scoop', 'update', 'apps/officecli/1.0.123/officecli.exe', ['scoop', 'update', 'officecli']],
  ['win32', 'scoop', 'reinstall', 'apps/officecli/1.0.123/officecli.exe', ['scoop', 'update', '--force', 'officecli']],
])
  test(`${channel} OfficeCLI ${action}：无法固定来源时保留原范围`, async t => {
    const f = await fixture(t, platform);
    const binary = path.join(channel === 'scoop' ? path.join(f.home, 'scoop') : f.root, relative);
    await f.write(binary, 'package managed binary');
    if (channel === 'scoop')
      await f.write(
        path.join(path.dirname(binary), 'manifest.json'),
        '{"homepage":"https://github.com/iOfficeAI/OfficeCLI"}',
      );
    f.state.located.set('officecli', [binary]);
    if (channel === 'scoop') f.state.scoopPrefix = path.dirname(binary);
    const selected = (await f.ccw.inspect()).items.find(item => item.id.startsWith(`officecli:${channel}:`));
    assert.ok(selected, JSON.stringify(await f.ccw.inspect()));
    const plan = await f.ccw.plan({
      task: 'install',
      selected: [{ id: selected.id, maintenance: action, fields: { connection: 'mcp' } }],
    });
    assert.equal(plan.items[0].problem, 'pinned-version-channel-unsupported');
    assert.equal((await f.ccw.apply(plan.id)).state, 'failed');
    const expected = channel === 'brew' ? [path.join(f.root, 'bin/brew'), ...command.slice(1)] : command;
    assert.equal(ranExecute(f, expected), false);
    assert.equal(await fs.readFile(binary, 'utf8'), 'package managed binary');
  });

test('卸载原生 OfficeCLI：仅删除已确认文件', async t => {
  const f = await fixture(t);
  await f.write(f.nativeOffice, bytes);
  await f.write(`${f.nativeOffice}.update`, 'pending program');
  await f.write(`${f.nativeOffice}.old`, 'old program');
  await f.write(path.join(f.home, '.officecli/config.json'), '{"autoUpdate":false}');
  await f.write(path.join(path.dirname(f.nativeOffice), 'other-tool'), 'keep other program');
  const result = await f.apply({ task: 'uninstall', selected: [{ id: 'officecli' }] });
  assert.equal(result.state, 'done', JSON.stringify(result));
  for (const file of [f.nativeOffice, `${f.nativeOffice}.update`, `${f.nativeOffice}.old`])
    assert.equal(await exists(file), false);
  assert.equal(await fs.readFile(path.join(f.home, '.officecli/config.json'), 'utf8'), '{"autoUpdate":false}');
  assert.equal(await fs.readFile(path.join(path.dirname(f.nativeOffice), 'other-tool'), 'utf8'), 'keep other program');
});

test('识别 OfficeCLI 身份不符：拒绝卸载', async t => {
  const f = await fixture(t);
  await f.write(f.nativeOffice, 'unrelated native file');
  f.state.officecliVersion = 'DifferentTool 1.0.123';
  const mismatch = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'officecli' }] });
  assert.equal(mismatch.items[0].problem, 'program-identity-unconfirmed');
  assert.equal(await fs.readFile(f.nativeOffice, 'utf8'), 'unrelated native file');
});

test('发现更新冲突目录：拒绝卸载', async t => {
  const f = await fixture(t);
  await f.write(f.nativeOffice, 'unrelated native file');
  f.state.officecliVersion = '1.0.123 OfficeCLI';
  await fs.mkdir(`${f.nativeOffice}.update`, { recursive: true });
  const directory = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'officecli' }] });
  assert.equal(directory.items[0].problem, 'program-update-conflict');
  assert.equal(await fs.readFile(f.nativeOffice, 'utf8'), 'unrelated native file');
});

test('npm 不可用：仍管理原生 OfficeCLI', async t => {
  const f = await fixture(t);
  f.state.npmFailure = { reason: 'npm-not-found' };
  assert.equal((await f.apply({ task: 'install', selected: [{ id: 'officecli' }] })).state, 'done');
  f.state.npmFailure = {};
  assert.equal((await f.apply({ task: 'uninstall', selected: [{ id: 'officecli' }] })).state, 'done');
});

test('识别 OfficeCLI：用帮助确认版本', async t => {
  const f = await fixture(t);
  await f.write(f.nativeOffice, bytes);
  f.state.officecliVersion = '1.0.123';
  f.state.officecliHelp = 'officecli: AI-friendly CLI for Office documents';
  assert.equal((await f.apply({ task: 'uninstall', selected: [{ id: 'officecli' }] })).state, 'done');
});

test('重试 Claude 卸载：仅复核包登记', async t => {
  const f = await fixture(t);
  await f.seedNpm('claude');
  f.state.registryUnavailable = true;
  const first = await f.apply({ task: 'uninstall', selected: [{ id: 'claude' }] });
  assert.equal(first.state, 'failed');
  assert.ok(first.remaining);
  assert.ok(first.items[0].effects.some(effect => effect.code === 'npm-inspection-failed'));
  f.state.registryUnavailable = false;
  const retry = await f.ccw.plan({ resume: first.remaining });
  assert.equal(
    retry.items.some(item => item.changes.some(change => change.code === 'program-uninstall')),
    false,
  );
  assert.equal((await f.ccw.apply(retry.id)).state, 'done');
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'uninstall').length, 1);
});

for (const [relative, label, content] of [
  ['Microsoft/WinGet/not-the-package/claude.exe', '未知程序', 'unrelated manual executable'],
  ['Microsoft/WinGet/Packages/Anthropic.ClaudeCode_9.9.9_fake/claude.exe', '伪造目录', 'path-shaped impostor'],
])
  test(`识别无来源段 WinGet 路径：保留手工安装（${label}）`, async t => {
    const f = await fixture(t, 'win32');
    const binary = path.join(f.root, relative);
    await f.write(binary, content);
    f.state.located.set('claude', [binary]);
    const item = (await f.ccw.inspect()).items.find(value => value.kind === 'claude');
    assert.match(item.id, /^claude:manual:/, '目录形态不带来源段按手工处理');
    assert.equal(item.actions.includes('uninstall'), false);
    const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: item.id }] });
    assert.equal(plan.items[0].problem, 'channel-not-supported');
    assert.equal(
      f.calls.some(call => call.kind === 'execute' && call.target === 'winget'),
      false,
      '不执行影响真实登记包的卸载命令',
    );
    assert.equal(await fs.readFile(binary, 'utf8'), content);
  });

test('更新 WinGet Claude：指定目标版本', async t => {
  const f = await fixture(t, 'win32');
  const binary = path.join(
    f.root,
    'Microsoft/WinGet/Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe',
  );
  await f.write(binary, 'winget binary');
  f.state.located.set('claude', [binary]);
  const npm = f.machine.npm;
  f.machine.npm = async (args, options) => (args[0] === 'view' ? ok(JSON.stringify('2.1.318')) : npm(args, options));
  const execute = f.machine.execute;
  f.machine.execute = async (file, args, options) =>
    file === binary && args[0] === '--version' ? ok('2.1.318 Claude Code') : execute(file, args, options);
  const item = (await f.ccw.inspect()).items.find(item => item.kind === 'claude');
  assert.equal((await f.apply({ task: 'install', selected: [{ id: item.id, maintenance: 'update' }] })).state, 'done');
  const command = f.calls.find(call => call.kind === 'execute' && call.target === 'winget');
  assert.equal(command.args[0], 'upgrade');
  assert.equal(command.args[command.args.indexOf('--version') + 1], '2.1.318');
  assert.equal(
    f.calls.some(call => call.kind === 'npm' && call.target === 'install'),
    false,
  );
});

test('渠道无法指定版本：拒绝更新', async t => {
  const f = await fixture(t, 'darwin');
  const binary = path.join(f.root, 'Caskroom/claude-code/2.1.300/claude');
  await f.write(binary, 'brew binary');
  f.state.located.set('claude', [binary]);
  const item = (await f.ccw.inspect()).items.find(item => item.kind === 'claude');
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: item.id, maintenance: 'update' }] });
  assert.equal(plan.items[0].problem, 'pinned-version-channel-unsupported');
  assert.equal(
    f.calls.some(call => call.kind === 'execute' && call.target === 'brew'),
    false,
  );
});

test('卸载 Scoop 实例：保护全局副本', async t => {
  const f = await fixture(t, 'win32');
  const user = path.join(f.home, 'scoop/apps/officecli/1.0.123/officecli.exe');
  const global = path.join(f.root, 'global scoop/apps/officecli/1.0.123/officecli.exe');
  for (const binary of [user, global]) {
    await f.write(binary, binary === user ? 'user package' : 'global package');
    await f.write(
      path.join(path.dirname(binary), 'manifest.json'),
      '{"homepage":"https://github.com/iOfficeAI/OfficeCLI"}',
    );
  }
  f.state.located.set('officecli', [user, global]);
  f.state.scoopPrefix = path.dirname(user);
  f.state.managed = { command: ['scoop', 'uninstall'], binary: user };
  const items = (await f.ccw.inspect()).items;
  const globalItem = items.find(item => item.location === global);
  const userItem = items.find(item => item.location === user);
  assert.match(globalItem.id, /^officecli:manual:/);
  assert.equal(globalItem.actions.includes('uninstall'), false);
  const wrongScope = await f.ccw.plan({ task: 'uninstall', selected: [{ id: globalItem.id }] });
  assert.equal(wrongScope.items[0].problem, 'channel-not-supported');
  assert.equal(
    f.calls.some(call => call.kind === 'execute' && call.target === 'scoop' && call.args[0] === 'uninstall'),
    false,
  );
  assert.equal(await fs.readFile(user, 'utf8'), 'user package');
  assert.equal((await f.apply({ task: 'uninstall', selected: [{ id: userItem.id }] })).state, 'done');
  assert.equal(await fs.readFile(global, 'utf8'), 'global package');
});

test('切换 Scoop 前缀：阻止旧卸载计划', async t => {
  const f = await fixture(t, 'win32');
  const binary = path.join(f.home, 'scoop/apps/officecli/1.0.123/officecli.exe');
  const other = path.join(f.home, 'scoop/apps/officecli/1.0.124/officecli.exe');
  for (const file of [binary, other]) {
    await f.write(file, 'program');
    await f.write(
      path.join(path.dirname(file), 'manifest.json'),
      '{"homepage":"https://github.com/iOfficeAI/OfficeCLI"}',
    );
  }
  f.state.located.set('officecli', [binary]);
  f.state.scoopPrefix = path.dirname(binary);
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'officecli' }] });
  assert.equal(plan.items[0].problem, null);
  f.state.scoopPrefix = path.dirname(other);
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.items[0].effects.at(-1).code, 'program-scope-unconfirmed');
  assert.equal(
    f.calls.some(call => call.kind === 'execute' && call.target === 'scoop' && call.args[0] === 'uninstall'),
    false,
  );
  assert.equal(await fs.readFile(binary, 'utf8'), 'program');
});

test('包管理器报错：仅重试卸载复核', async t => {
  const f = await fixture(t, 'darwin');
  const binary = path.join(f.root, 'Caskroom/claude-code/2.1.311/claude');
  await f.write(binary, 'managed program');
  f.state.located.set('claude', [binary]);
  const manager = path.join(f.root, 'bin/brew');
  f.state.managed = { command: [manager, 'uninstall'], binary };
  f.state.managedFails = true;
  f.state.brewVersionsUnknown = true;
  const first = await f.apply({ task: 'uninstall', selected: [{ id: 'claude' }] });
  assert.equal(first.state, 'failed');
  assert.ok(first.items[0].effects.some(effect => effect.code === 'program-removal-unconfirmed'));
  const uncertain = await f.apply({ resume: first.remaining });
  assert.equal(uncertain.state, 'failed');
  assert.equal(uncertain.items[0].effects.at(-1).code, 'program-removal-unconfirmed');
  f.state.brewVersionsUnknown = false;
  assert.equal((await f.apply({ resume: uncertain.remaining })).state, 'done');
  assert.equal(
    f.calls.filter(call => call.kind === 'execute' && call.target === manager && call.args[0] === 'uninstall').length,
    1,
  );
  const inspections = f.calls.filter(
    call => call.kind === 'execute' && call.args[0] === 'list' && call.args.at(-1) === '--versions',
  );
  assert.ok(inspections.length > 0);
  assert.ok(
    inspections.every(
      call =>
        call.target === manager && call.args.includes('--cask') && call.options.env.HOMEBREW_NO_AUTO_UPDATE === '1',
    ),
  );
});

test('识别 Linux 包：拒绝相似包名', async t => {
  const f = await fixture(t, 'linux');
  const binary = path.join(f.root, 'usr/bin/claude');
  await f.write(binary, 'different package program');
  f.state.located.set('claude', [binary]);
  f.state.ownership = {
    'dpkg-query': `other-claude-code: ${binary}`,
    rpm: 'other-claude-code',
    apk: `${binary} is owned by other-claude-code-2.1.311-r0`,
  };
  const item = (await f.ccw.inspect()).items.find(value => value.kind === 'claude');
  assert.match(item.id, /^claude:manual:/);
  assert.equal(item.actions.includes('uninstall'), false);
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: item.id }] });
  assert.equal(plan.items[0].problem, 'channel-not-supported');
  assert.equal(
    f.calls.some(
      call =>
        (call.kind === 'npm' && ['remove', 'del'].includes(call.target)) ||
        (call.kind === 'execute' && (call.target === 'apt-get' || ['remove', 'del'].includes(call.args[0]))),
    ),
    false,
  );
  assert.equal(await fs.readFile(binary, 'utf8'), 'different package program');
});
