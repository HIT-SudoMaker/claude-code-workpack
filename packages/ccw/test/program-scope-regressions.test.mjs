import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createCcw } from '../dist/ccw.js';
import { npmConfig, createEnv, exists, ok, pluginMarketplaceFiles, revision } from './env.mjs';

const packageName = '@anthropic-ai/claude-code';

async function fixture(t, platform = 'win32') {
  const f = await createEnv(t, { layout: 'home', seed: { settings: { language: 'English' } } });
  const roots = ['a', 'b'].map(name => path.join(f.root, name, 'node_modules'));
  const versions = new Map();
  const located = new Map();
  const brews = new Map();
  const state = {
    active: roots[0],
    confirming: false,
    unavailable: false,
    pathBrew: null,
    wrongBrewRoot: false,
    brewFails: false,
    npmReplaced: false,
    installFails: false,
    cleanupFails: false,
    fetchScript: false,
    snapshotFile: null,
    snapshotFailed: false,
    afterInstall: null,
    afterUninstall: null,
    onCmd: null,
    afterCmd: null,
    afterVersionProbe: null,
    afterInitialize: null,
    onRemoveTree: null,
    afterRemoveTree: null,
    scriptFetches: 0,
  };
  const binary = prefix => path.join(prefix, packageName, 'cli.js');
  const wrapped = f.machine({
    locate: async kind => located.get(kind) ?? [],
    processes: async () => [],
    npm: async args => {
      if (state.npmReplaced) throw new Error('npm-changed');
      if (args[0] === 'config') return npmConfig(args);
      const prefix = args.find(value => value.startsWith('--prefix='))?.slice('--prefix='.length);
      const selectedRoot =
        prefix === undefined
          ? state.active
          : path.join(prefix, platform === 'win32' ? 'node_modules' : 'lib/node_modules');
      if (args[0] === 'root') return ok(selectedRoot);
      if (args[0] === 'view') return ok(JSON.stringify('2.1.2'));
      if (args[0] === 'ls') {
        if (state.confirming && state.unavailable) return { code: null, failed: true, stdout: '' };
        const version = args.at(-1) === packageName ? versions.get(selectedRoot) : undefined;
        return ok(JSON.stringify({ dependencies: version === undefined ? {} : { [packageName]: { version } } }));
      }
      if (args[0] === 'install') {
        if (state.installFails) return { code: 1, failed: false, stdout: '' };
        versions.set(selectedRoot, '2.1.2');
        await f.write(binary(selectedRoot), '2.1.2');
        await f.write(
          path.join(selectedRoot, packageName, 'package.json'),
          JSON.stringify({ name: packageName, bin: { claude: 'cli.js' } }),
        );
        state.confirming = true;
        if (state.afterInstall) await state.afterInstall();
        return ok();
      }
      if (args[0] === 'uninstall') {
        if (state.cleanupFails) return { code: 1, failed: false, stdout: '' };
        versions.delete(selectedRoot);
        await fs.rm(path.join(selectedRoot, packageName), { recursive: true, force: true });
        if (state.afterUninstall) await state.afterUninstall();
        return ok();
      }
      throw new Error('unexpected-npm-command');
    },
    execute: async (executable, args, options) => {
      if (executable === 'git') return ok(`${revision}\tHEAD`);
      if (executable === 'cmd.exe') {
        if (state.onCmd) await state.onCmd();
        await f.write(path.join(f.home, '.local/bin/claude.exe'), '2.1.2');
        await f.write(path.join(f.home, '.local/share/claude/versions/2.1.2'), '2.1.2');
        if (state.afterCmd) await state.afterCmd();
        return ok();
      }
      const brew = brews.get(executable === 'brew' ? state.pathBrew : executable);
      if (brew) {
        if (args[0] === '--cellar' || args[0] === '--caskroom')
          return ok(
            path.join(
              state.wrongBrewRoot ? path.join(f.root, 'wrong-brew') : brew.root,
              args[0] === '--cellar' ? 'Cellar' : 'Caskroom',
            ),
          );
        if (args[0] === 'list') return ok(brew.listed ?? (brew.installed ? `${brew.packageName} 1.0.123` : ''));
        if (args[0] === 'uninstall') {
          brew.installed = false;
          await fs.unlink(brew.binary);
          return { code: state.brewFails ? 1 : 0, failed: false, stdout: '' };
        }
        if (args[0] === 'upgrade' || args[0] === 'reinstall') {
          if (options?.env?.HOMEBREW_NO_AUTO_UPDATE !== '1') await f.write(executable, 'auto-updated Homebrew manager');
          await f.write(brew.binary, 'updated package');
          return ok();
        }
      }
      const target = executable === process.execPath ? args[0] : executable;
      const command = executable === process.execPath ? args.slice(1) : args;
      if (command[0] === 'auth') return ok(command[1] === 'status' ? '{"loggedIn":true}' : '');
      if (command[0] === '--version') {
        const output = target.includes('officecli')
          ? '1.0.123 OfficeCLI'
          : `${await fs.readFile(target, 'utf8')} Claude Code`;
        if (state.afterVersionProbe) await state.afterVersionProbe(target);
        return ok(output);
      }
      return ok();
    },
  });
  const machine = {
    ...wrapped,
    async source(repository, commit, folder) {
      assert.equal(repository, 'https://github.com/anthropics/claude-plugins-official');
      assert.equal(commit, revision);
      assert.equal(folder, '.');
      return pluginMarketplaceFiles();
    },
    async treeStamp(file, ...args) {
      if (file === state.snapshotFile && state.confirming && !state.snapshotFailed) {
        state.snapshotFailed = true;
        throw new Error('snapshot-read-failed');
      }
      return wrapped.treeStamp(file, ...args);
    },
    async fetchText(url, options) {
      if (url === 'https://claude.ai/install.cmd') state.scriptFetches += 1;
      return url === 'https://claude.ai/install.cmd' || state.fetchScript
        ? '@echo off\r\n'
        : wrapped.fetchText(url, options);
    },
    async initialize(file, text) {
      const result = await wrapped.initialize(file, text);
      if (result && state.afterInitialize) await state.afterInitialize(file);
      return result;
    },
    async removeTree(...args) {
      if (state.onRemoveTree) await state.onRemoveTree(args[0]);
      const result = await wrapped.removeTree(...args);
      if (state.afterRemoveTree) await state.afterRemoveTree(args[0]);
      return result;
    },
  };
  const ccw = f.ccw(machine, { platform });
  const seedNpm = async (prefix = roots[0]) => {
    versions.set(prefix, '2.1.1');
    await f.write(binary(prefix), '2.1.1');
    await f.write(
      path.join(prefix, packageName, 'package.json'),
      JSON.stringify({ name: packageName, bin: { claude: 'cli.js' } }),
    );
    return binary(prefix);
  };
  const seedBrew = async (name, kind = 'officecli') => {
    const prefix = path.join(f.root, name);
    const executable = path.join(prefix, 'bin/brew');
    const file = path.join(
      prefix,
      kind === 'claude' ? 'Caskroom/claude-code/2.1.1/claude' : 'Cellar/officecli/1.0.123/bin/officecli',
    );
    const brew = {
      root: prefix,
      executable,
      binary: file,
      packageName: kind === 'claude' ? 'claude-code' : 'officecli',
      installed: true,
      listed: null,
    };
    await f.write(executable, 'brew manager');
    await f.write(file, '1.0.123');
    brews.set(executable, brew);
    located.set(kind, [...(located.get(kind) ?? []), file]);
    return brew;
  };
  const apply = async input => {
    const plan = await ccw.plan(input);
    assert.equal(plan.problem, null);
    assert.equal(plan.items[0].problem, null, JSON.stringify(plan));
    return ccw.apply(plan.id);
  };
  return {
    ...f,
    roots,
    binary,
    machine,
    ccw,
    state,
    versions,
    located,
    brews,
    platform,
    seedNpm,
    seedBrew,
    apply,
  };
}

test('npm 入口被替换：停止旧计划并完成独立配置', async t => {
  const f = await fixture(t);
  await f.seedNpm();
  const item = (await f.ccw.inspect()).items.find(item => item.kind === 'claude');
  const plan = await f.ccw.plan({
    task: 'install',
    selected: [
      { id: item.id, maintenance: 'update' },
      { id: 'settings', fields: { language: 'English' } },
    ],
  });
  assert.ok(
    plan.items.every(item => item.problem === null),
    JSON.stringify(plan),
  );
  f.state.npmReplaced = true;
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'partial');
  assert.equal(result.items[0].effects.at(-1).code, 'npm-changed');
  assert.equal(result.items[0].isPending, true);
  assert.equal(result.items[1].state, 'done');
  assert.ok(result.remaining);
});

test('卸载 Homebrew：绑定所选根', async t => {
  const f = await fixture(t, 'darwin');
  const a = await f.seedBrew('a-brew');
  const b = await f.seedBrew('b-brew');
  f.state.pathBrew = b.executable;
  const selected = (await f.ccw.inspect()).items.find(item => item.location === a.binary);
  const result = await f.apply({ task: 'uninstall', selected: [{ id: selected.id }] });
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(await exists(a.binary), false);
  assert.equal(await fs.readFile(b.binary, 'utf8'), '1.0.123');
  assert.ok(
    f.calls.some(call => call.kind === 'execute' && call.target === a.executable && call.args[0] === 'uninstall'),
  );
});

test('确认 Homebrew：拒绝未知归属', async t => {
  const f = await fixture(t, 'darwin');
  const a = await f.seedBrew('a-brew');
  f.state.pathBrew = a.executable;
  f.state.wrongBrewRoot = true;
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'officecli' }] });
  assert.equal(plan.items[0].problem, 'program-scope-unconfirmed');
  assert.equal(
    f.calls.some(call => call.args[0] === 'uninstall'),
    false,
  );
});

for (const addedAfterPlan of [false, true])
  test(`卸载 Homebrew：拒绝${addedAfterPlan ? '新增' : '已有'}多版本`, async t => {
    const f = await fixture(t, 'darwin');
    const installed = await f.seedBrew('brew');
    const other = path.join(installed.root, 'Cellar/officecli/1.0.200/bin/officecli');
    const addOther = async () => {
      await f.write(other, 'unselected version');
      installed.listed = 'officecli 1.0.123 1.0.200';
    };
    if (!addedAfterPlan) await addOther();
    const selected = (await f.ccw.inspect()).items.find(item => item.location === installed.binary);
    const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: selected.id }] });
    if (addedAfterPlan) {
      assert.equal(plan.items[0].problem, null);
      await addOther();
    }
    if (plan.items[0].problem === null) {
      const result = await f.ccw.apply(plan.id);
      assert.equal(result.items[0].effects.at(-1).code, 'program-scope-unconfirmed');
    } else assert.equal(plan.items[0].problem, 'program-scope-unconfirmed');
    assert.equal(await fs.readFile(other, 'utf8'), 'unselected version');
    assert.equal(await fs.readFile(installed.binary, 'utf8'), '1.0.123');
    assert.equal(
      f.calls.some(call => call.args[0] === 'uninstall'),
      false,
    );
  });

test('准备 Homebrew：核对登记版本', async t => {
  const f = await fixture(t, 'darwin');
  const installed = await f.seedBrew('brew');
  installed.listed = 'officecli 1.0.200';
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'officecli' }] });
  assert.equal(plan.items[0].problem, 'program-scope-unconfirmed');
  assert.equal(
    f.calls.some(call => call.args[0] === 'uninstall'),
    false,
  );
});

test('更新 Homebrew：无法固定来源时不选择另一个管理器', async t => {
  const f = await fixture(t, 'darwin');
  const a = await f.seedBrew('a-brew');
  const b = await f.seedBrew('b-brew');
  f.state.pathBrew = a.executable;
  const selected = (await f.ccw.inspect()).items.find(item => item.location === a.binary);
  const plan = await f.ccw.plan({
    task: 'install',
    selected: [{ id: selected.id, maintenance: 'update', fields: { connection: 'mcp' } }],
  });
  assert.equal(plan.items[0].problem, 'pinned-version-channel-unsupported');
  f.state.pathBrew = b.executable;
  assert.equal((await f.ccw.apply(plan.id)).state, 'failed');
  assert.equal(await fs.readFile(a.binary, 'utf8'), '1.0.123');
  assert.equal(await fs.readFile(b.binary, 'utf8'), '1.0.123');
  assert.equal(
    f.calls.some(call => ['upgrade', 'reinstall'].includes(call.args[0])),
    false,
  );
});

test('维护 Homebrew：无法固定来源时保留管理器', async t => {
  const f = await fixture(t, 'darwin');
  const a = await f.seedBrew('a-brew');
  f.state.pathBrew = a.executable;
  const plan = await f.ccw.plan({
    task: 'install',
    selected: [{ id: 'officecli', maintenance: 'update', fields: { connection: 'mcp' } }],
  });
  assert.equal(plan.items[0].problem, 'pinned-version-channel-unsupported');
  assert.equal((await f.ccw.apply(plan.id)).state, 'failed');
  assert.equal(
    f.calls.some(call => ['upgrade', 'reinstall'].includes(call.args[0])),
    false,
  );
  assert.equal(await fs.readFile(a.executable, 'utf8'), 'brew manager');
});

test('替换 Homebrew：阻止原卸载', async t => {
  const f = await fixture(t, 'darwin');
  const a = await f.seedBrew('a-brew');
  f.state.pathBrew = a.executable;
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'officecli' }] });
  assert.equal(plan.items[0].problem, null);
  await f.write(a.executable, 'different Homebrew manager');
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.items[0].effects.at(-1).code, 'program-scope-unconfirmed');
  assert.ok(result.remaining);
  assert.equal(result.items[0].isPending, true);
  assert.equal(
    f.calls.some(call => call.args[0] === 'uninstall'),
    false,
  );
});

test('切换 npm 根：阻止原更新', async t => {
  const f = await fixture(t);
  await f.seedNpm(f.roots[0]);
  await f.seedNpm(f.roots[1]);
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'claude', maintenance: 'update' }] });
  assert.equal(plan.items[0].problem, null);
  f.state.active = f.roots[1];
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.items[0].effects.at(-1).code, 'program-scope-unconfirmed');
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 0);
  assert.deepEqual([...f.versions.values()], ['2.1.1', '2.1.1']);
});

test('继续 npm 更新：仅复核程序', async t => {
  const f = await fixture(t);
  await f.seedNpm();
  f.state.unavailable = true;
  const first = await f.apply({ task: 'install', selected: [{ id: 'claude', maintenance: 'update' }] });
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  f.state.unavailable = false;
  const plan = await f.ccw.plan({ resume: first.remaining });
  assert.equal(
    plan.items.some(item => item.changes.some(change => change.code === 'program-update')),
    false,
  );
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 1);
});

test('继续 npm 新装：仅复核程序', async t => {
  const f = await fixture(t);
  f.state.unavailable = true;
  const first = await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(first.state, 'failed');
  assert.ok(first.remaining);
  assert.equal(
    f.calls.some(call => call.args[0] === 'uninstall' || (call.kind === 'execute' && call.target === 'cmd.exe')),
    false,
  );
  f.state.unavailable = false;
  assert.equal((await f.apply({ resume: first.remaining })).state, 'done');
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 1);
});

test('npm 新装回执丢失：仅确认已落地的固定版本', async t => {
  const f = await fixture(t);
  f.state.afterInstall = async () => {
    f.state.afterInstall = null;
    f.state.unavailable = true;
    throw new Error('npm-install-receipt-lost');
  };
  const first = await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  assert.notEqual(first.state, 'done', JSON.stringify(first));
  assert.ok(first.remaining, JSON.stringify(first));
  assert.equal(await fs.readFile(f.binary(f.roots[0]), 'utf8'), '2.1.2');
  assert.equal(f.versions.get(f.roots[0]), '2.1.2');
  f.state.unavailable = false;
  const result = await f.apply({ resume: first.remaining });
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 1);
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'uninstall').length, 0);
  assert.equal(f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe').length, 0);
  assert.equal(f.state.scriptFetches, 1);
});

test('切换 npm 根：阻止原新装', async t => {
  const f = await fixture(t);
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(plan.items[0].problem, null);
  f.state.active = f.roots[1];
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.items[0].effects.at(-1).code, 'program-scope-unconfirmed');
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 0);
});

test('停止失效程序：保留独立剩余工作', async t => {
  const f = await fixture(t);
  await f.seedNpm();
  const office = await f.seedBrew('office-brew');
  const items = (await f.ccw.inspect()).items;
  const claude = items.find(item => item.id.startsWith('claude:npm:'));
  const selectedOffice = items.find(item => item.location === office.binary);
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: claude.id }, { id: selectedOffice.id }] });
  assert.ok(plan.items.every(item => item.problem === null));
  f.state.active = f.roots[1];
  f.state.brewFails = true;
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  assert.equal(first.items.find(item => item.id === claude.id).isPending, true);
  const next = await f.ccw.plan({ resume: first.remaining });
  assert.deepEqual(
    next.items.map(item => item.id),
    [claude.id],
  );
  assert.equal((await f.ccw.apply(next.id)).state, 'partial');
  assert.equal(first.items.find(item => item.id === selectedOffice.id).state, 'done');
  assert.equal(f.versions.get(f.roots[0]), '2.1.1');
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'uninstall').length, 0);
});

test('重试失败清理：保留安装进度', async t => {
  const f = await fixture(t);
  f.state.cleanupFails = true;
  f.state.fetchScript = true;
  f.state.afterInstall = async () => fs.unlink(f.binary(f.roots[0]));
  const first = await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(first.state, 'failed');
  assert.equal(first.items[0].effects.at(-1).code, 'failed-install-cleanup-failed');
  f.state.cleanupFails = false;
  const resumed = await f.apply({ resume: first.remaining });
  assert.equal(resumed.state, 'done', JSON.stringify(resumed));
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 1);
});

test('npm 清理回执丢失：确认原作用域为空后仅进入一次 CMD', async t => {
  const f = await fixture(t);
  f.state.fetchScript = true;
  f.state.afterInstall = async () => fs.unlink(f.binary(f.roots[0]));
  f.state.afterUninstall = async () => {
    f.state.afterUninstall = null;
    f.state.unavailable = true;
    throw new Error('npm-cleanup-receipt-lost');
  };
  const first = await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining, JSON.stringify(first));
  assert.equal(await exists(path.join(f.roots[0], packageName)), false);
  assert.equal(f.versions.has(f.roots[0]), false);
  assert.equal(f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe').length, 0);
  f.state.unavailable = false;
  const result = await f.apply({ resume: first.remaining });
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(f.home, '.local/bin/claude.exe'), 'utf8'), '2.1.2');
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 1);
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'uninstall').length, 1);
  assert.equal(f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe').length, 1);
  assert.equal(f.state.scriptFetches, 1);
});

test('继续 CMD 新装：仅复核程序', async t => {
  const f = await fixture(t);
  f.state.installFails = true;
  f.state.fetchScript = true;
  f.state.onCmd = async () => {
    f.state.confirming = true;
    f.state.unavailable = true;
  };
  const first = await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(first.state, 'failed');
  assert.ok(first.remaining);
  f.state.unavailable = false;
  assert.equal((await f.apply({ resume: first.remaining })).state, 'done');
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 1);
  assert.equal(f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe').length, 1);
});

test('CMD 新装回执丢失：仅确认已落地的固定版本', async t => {
  const f = await fixture(t);
  f.state.installFails = true;
  f.state.fetchScript = true;
  f.state.afterCmd = async () => {
    f.state.afterCmd = null;
    f.state.confirming = true;
    f.state.unavailable = true;
    throw new Error('cmd-install-receipt-lost');
  };
  const first = await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  assert.notEqual(first.state, 'done', JSON.stringify(first));
  assert.ok(first.remaining, JSON.stringify(first));
  const native = path.join(f.home, '.local/bin/claude.exe');
  assert.equal(await fs.readFile(native, 'utf8'), '2.1.2');
  assert.equal(await fs.readFile(path.join(f.home, '.local/share/claude/versions/2.1.2'), 'utf8'), '2.1.2');
  f.state.unavailable = false;
  const result = await f.apply({ resume: first.remaining });
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.ok(result.items[0].effects.some(effect => effect.code === 'program-ready' && effect.detail === native));
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 1);
  const commands = f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].args.at(-1), '2.1.2');
  assert.equal(f.state.scriptFetches, 1);
});

for (const drift of ['version', 'scope'])
  test(`CMD 回执丢失后${drift === 'version' ? '版本' : '作用域'}变化：停止原安装`, async t => {
    const f = await fixture(t);
    f.state.installFails = true;
    f.state.fetchScript = true;
    f.state.afterCmd = async () => {
      f.state.afterCmd = null;
      f.state.confirming = true;
      f.state.unavailable = true;
      throw new Error('cmd-install-receipt-lost');
    };
    const first = await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
    assert.notEqual(first.state, 'done', JSON.stringify(first));
    assert.ok(first.remaining, JSON.stringify(first));
    const native = path.join(f.home, '.local/bin/claude.exe');
    if (drift === 'version') await f.write(native, '2.1.3 external replacement');
    else f.state.active = f.roots[1];
    f.state.unavailable = false;
    const result = await f.apply({ resume: first.remaining });
    assert.notEqual(result.state, 'done', JSON.stringify(result));
    assert.equal(
      result.items[0].effects.at(-1).code,
      drift === 'version' ? 'program-changed' : 'program-scope-unconfirmed',
    );
    assert.equal(await fs.readFile(native, 'utf8'), drift === 'version' ? '2.1.3 external replacement' : '2.1.2');
    assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 1);
    assert.equal(f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe').length, 1);
    assert.equal(f.state.scriptFetches, 1);
  });

test('继续 CMD 清理：移除安装文件', async t => {
  const f = await fixture(t);
  f.state.installFails = true;
  f.state.fetchScript = true;
  const directories = [];
  f.state.onRemoveTree = async directory => {
    if (path.basename(directory).startsWith('install-claude-')) {
      directories.push(directory);
      if (directories.length === 1) throw new Error('installer-conflict');
    }
  };
  const first = await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  assert.equal((await f.apply({ resume: first.remaining })).state, 'done');
  assert.equal(await exists(directories[0]), false);
  assert.equal(f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe').length, 1);
  assert.equal(directories.length, 2);
});

for (const recreated of [false, true])
  test(`CMD 清理回执丢失：${recreated ? '保护用户重建的安装目录' : '仅确认已删除的安装目录'}`, async t => {
    const f = await fixture(t);
    f.state.installFails = true;
    f.state.fetchScript = true;
    let removed;
    const abort = new AbortController();
    f.state.afterRemoveTree = async directory => {
      if (!path.basename(directory).startsWith('install-claude-')) return;
      f.state.afterRemoveTree = null;
      removed = directory;
      abort.abort();
      throw new Error('installer-remove-receipt-lost');
    };
    const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
    const first = await f.ccw.apply(plan.id, abort.signal);
    assert.equal(first.state, 'cancelled');
    assert.ok(first.remaining, JSON.stringify(first));
    assert.ok(removed);
    assert.equal(await exists(removed), false);
    const keep = path.join(removed, 'keep.txt');
    if (recreated) await f.write(keep, 'user recreated artifact');
    const result = await f.apply({ resume: first.remaining });
    if (recreated) {
      assert.notEqual(result.state, 'done', JSON.stringify(result));
      assert.equal(result.items[0].effects.at(-1).code, 'installer-conflict');
      assert.equal(await fs.readFile(keep, 'utf8'), 'user recreated artifact');
    } else {
      assert.equal(result.state, 'done', JSON.stringify(result));
      assert.equal(await exists(removed), false);
    }
    assert.equal(await fs.readFile(path.join(f.home, '.local/bin/claude.exe'), 'utf8'), '2.1.2');
    assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 1);
    assert.equal(f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe').length, 1);
    assert.equal(f.state.scriptFetches, 1);
  });

test('CMD 初始化回执丢失：复核同一安装文件且只派发一次', async t => {
  const f = await fixture(t);
  f.state.installFails = true;
  f.state.fetchScript = true;
  const initialized = [];
  f.state.afterInitialize = async file => {
    if (path.basename(file) !== 'install.cmd') return;
    initialized.push(file);
    if (initialized.length === 1) throw new Error('installer-initialize-receipt-lost');
  };
  const first = await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  let result = first;
  if (first.state !== 'done') {
    assert.ok(first.remaining, JSON.stringify(first));
    result = await f.apply({ resume: first.remaining });
  }
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(initialized.length, 1);
  assert.equal(await exists(path.dirname(initialized[0])), false);
  assert.equal(await fs.readFile(path.join(f.home, '.local/bin/claude.exe'), 'utf8'), '2.1.2');
  const commands = f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].options.cwd, path.dirname(initialized[0]));
  assert.equal(f.state.scriptFetches, 1);
});

test('CMD 初始化结果冲突：保护用户重建文件且不运行安装器', async t => {
  const f = await fixture(t);
  f.state.installFails = true;
  f.state.fetchScript = true;
  let keep;
  f.state.afterInitialize = async file => {
    if (path.basename(file) !== 'install.cmd') return;
    f.state.afterInitialize = null;
    keep = path.join(path.dirname(file), 'keep.txt');
    await f.write(file, 'user replaced installer');
    await f.write(keep, 'user recreated artifact');
    throw new Error('installer-initialize-receipt-lost');
  };
  const first = await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  const result = first.remaining ? await f.apply({ resume: first.remaining }) : first;
  assert.notEqual(result.state, 'done', JSON.stringify(result));
  assert.ok(['installer-conflict', 'program-installation-unconfirmed'].includes(result.items[0].effects.at(-1).code));
  assert.equal(await fs.readFile(keep, 'utf8'), 'user recreated artifact');
  assert.equal(await fs.readFile(path.join(path.dirname(keep), 'install.cmd'), 'utf8'), 'user replaced installer');
  assert.equal(f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe').length, 0);
  assert.equal(f.state.scriptFetches, 1);
});

test('CMD 快照与清理同时失败：未知安装结果优先阻断', async t => {
  const f = await fixture(t);
  f.state.installFails = true;
  f.state.fetchScript = true;
  const native = path.join(f.home, '.local/bin/claude.exe');
  f.state.snapshotFile = native;
  f.state.afterCmd = async () => {
    f.state.confirming = true;
  };
  f.state.onRemoveTree = async directory => {
    if (path.basename(directory).startsWith('install-claude-')) throw new Error('installer-conflict');
  };
  const result = await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  assert.notEqual(result.state, 'done', JSON.stringify(result));
  assert.equal(result.items[0].effects.at(-1).code, 'program-installation-unconfirmed');
  assert.ok(result.remaining);
  assert.equal(result.items[0].isPending, true);
  assert.equal(await fs.readFile(native, 'utf8'), '2.1.2');
  assert.equal(f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe').length, 1);
  assert.equal(f.state.scriptFetches, 1);
});

test('CMD 回执丢失后取消：缺少快照时续办保持待核对', async t => {
  const f = await fixture(t);
  f.state.installFails = true;
  f.state.fetchScript = true;
  const controller = new AbortController();
  f.state.afterCmd = async () => {
    f.state.afterCmd = null;
    controller.abort();
    throw new Error('cmd-install-receipt-lost');
  };
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
  const first = await f.ccw.apply(plan.id, controller.signal);
  assert.equal(first.state, 'cancelled');
  assert.ok(first.remaining, JSON.stringify(first));
  assert.equal(await fs.readFile(path.join(f.home, '.local/bin/claude.exe'), 'utf8'), '2.1.2');
  assert.deepEqual(await f.read(f.settingsFile), { language: 'English' });
  const result = await f.apply({ resume: first.remaining });
  assert.notEqual(result.state, 'done', JSON.stringify(result));
  assert.ok(result.remaining);
  assert.ok(result.items[0].effects.some(effect => effect.code === 'program-installation-unconfirmed'));
  assert.deepEqual(await f.read(f.settingsFile), { language: 'English' });
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 1);
  assert.equal(f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe').length, 1);
  assert.equal(f.state.scriptFetches, 1);
});

for (const channel of ['npm', 'cmd'])
  test(`确认 ${channel} 版本时替换入口：保护相同版本的外部文件`, async t => {
    const f = await fixture(t);
    if (channel === 'cmd') {
      f.state.installFails = true;
      f.state.fetchScript = true;
    }
    const binary = channel === 'npm' ? f.binary(f.roots[0]) : path.join(f.home, '.local/bin/claude.exe');
    const replacement = '2.1.2 external replacement';
    let replacements = 0;
    f.state.afterVersionProbe = async target => {
      if (target !== binary || replacements !== 0) return;
      replacements += 1;
      await f.write(binary, replacement);
    };
    const result = await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
    assert.equal(replacements, 1);
    assert.notEqual(result.state, 'done', JSON.stringify(result));
    assert.equal(result.items[0].effects.at(-1).code, 'program-changed');
    assert.ok(result.remaining);
    assert.equal(result.items[0].isPending, true);
    assert.equal(await fs.readFile(binary, 'utf8'), replacement);
    assert.deepEqual(await f.read(f.settingsFile), { language: 'English' });
    assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 1);
    assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'uninstall').length, 0);
    assert.equal(
      f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe').length,
      channel === 'cmd' ? 1 : 0,
    );
    assert.equal(f.state.scriptFetches, 1);
  });

test('CMD 执行后安装目录被重建：保留用户文件并停止清理', async t => {
  const f = await fixture(t);
  f.state.installFails = true;
  f.state.fetchScript = true;
  let directory;
  f.state.afterInitialize = async file => {
    if (path.basename(file) === 'install.cmd') directory = path.dirname(file);
  };
  f.state.afterCmd = async () => {
    f.state.afterCmd = null;
    assert.ok(directory);
    await fs.rm(directory, { recursive: true, force: true });
    await f.write(path.join(directory, 'install.cmd'), 'user rebuilt installer');
    await f.write(path.join(directory, 'keep.txt'), 'user rebuilt artifact');
  };
  const first = await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  const result = first.remaining ? await f.apply({ resume: first.remaining }) : first;
  assert.notEqual(result.state, 'done', JSON.stringify(result));
  assert.equal(result.items[0].effects.at(-1).code, 'installer-conflict');
  assert.equal(await fs.readFile(path.join(directory, 'install.cmd'), 'utf8'), 'user rebuilt installer');
  assert.equal(await fs.readFile(path.join(directory, 'keep.txt'), 'utf8'), 'user rebuilt artifact');
  assert.equal(await fs.readFile(path.join(f.home, '.local/bin/claude.exe'), 'utf8'), '2.1.2');
  assert.equal(f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe').length, 1);
  assert.equal(f.state.scriptFetches, 1);
});

test('继续 npm 复核：保护外部替换', async t => {
  const f = await fixture(t);
  const binary = await f.seedNpm();
  f.state.unavailable = true;
  const first = await f.apply({ task: 'install', selected: [{ id: 'claude', maintenance: 'update' }] });
  assert.equal(first.state, 'partial');
  await f.write(binary, 'external replacement');
  f.state.unavailable = false;
  const result = await f.apply({ resume: first.remaining });
  assert.equal(result.state, 'partial');
  assert.equal(result.items[0].effects.at(-1).code, 'program-changed');
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 1);
});

for (const [seeded, maintenance, label] of [
  [true, 'reinstall', '重装'],
  [false, undefined, '新装'],
])
  test(`停止 npm ${label}：缺少安装快照`, async t => {
    const f = await fixture(t);
    const binary = seeded ? await f.seedNpm() : f.binary(f.roots[0]);
    f.state.snapshotFile = seeded ? binary : path.join(f.roots[0], packageName, 'package.json');
    const settingsFile = f.settingsFile;
    const settings = await fs.readFile(settingsFile, 'utf8');
    const first = await f.apply({
      task: 'install',
      selected: [maintenance ? { id: 'claude', maintenance } : { id: 'claude' }],
    });
    assert.equal(first.state, 'failed');
    assert.ok(first.remaining);
    assert.equal(first.items[0].isPending, true);
    assert.equal(first.items[0].effects.at(-1).code, 'program-installation-unconfirmed');
    await f.write(binary, '2.1.2 external replacement');
    const restarted = createCcw({
      machine: f.machine,
      home: f.home,
      claudeRoot: f.claudeRoot,
      cclineRoot: f.cclineRoot,
      platform: f.platform,
    });
    const resumed = await restarted.plan({ resume: first.remaining });
    const paused = await restarted.apply(resumed.id);
    assert.notEqual(paused.state, 'done', JSON.stringify(paused));
    assert.ok(paused.remaining);
    assert.equal(await fs.readFile(binary, 'utf8'), '2.1.2 external replacement');
    assert.equal(await fs.readFile(settingsFile, 'utf8'), settings);
    assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 1);
  });

test('继续 npm 新装：保护缺失快照', async t => {
  const f = await fixture(t);
  const settingsFile = f.settingsFile;
  const settings = await fs.readFile(settingsFile, 'utf8');
  f.state.afterInstall = async () => fs.rm(path.join(f.roots[0], packageName), { recursive: true, force: true });
  const first = await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(first.state, 'failed');
  assert.ok(first.remaining);
  await f.write(
    path.join(f.roots[0], packageName, 'package.json'),
    JSON.stringify({ name: packageName, bin: { claude: 'cli.js' } }),
  );
  await f.write(f.binary(f.roots[0]), '2.1.2 external replacement');
  const result = await f.apply({ resume: first.remaining });
  assert.equal(result.state, 'failed');
  assert.equal(result.items[0].effects.at(-1).code, 'program-changed');
  assert.equal(await fs.readFile(settingsFile, 'utf8'), settings);
  assert.ok(result.remaining);
  assert.equal(result.items[0].isPending, true);
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, 1);
});

test('登录 Claude：使用所选副本', async t => {
  const f = await fixture(t);
  await f.seedNpm();
  const binary = path.join(f.home, '.local/bin/claude.exe');
  await f.write(binary, '2.1.1');
  await f.write(path.join(f.home, '.local/share/claude/versions/2.1.1'), '2.1.1');
  const selected = (await f.ccw.inspect()).items.find(item => item.id.startsWith('claude:native:'));
  const result = await f.apply({ task: 'install', selected: [{ id: selected.id, maintenance: 'login' }] });
  assert.equal(result.state, 'done');
  const auth = f.calls.filter(call => call.kind === 'execute' && call.args[0] === 'auth');
  assert.equal(auth.length, 2);
  assert.ok(auth.every(call => call.target === binary));
});

test('检查 npm 副本：保留独立根', async t => {
  const f = await fixture(t);
  await f.seedNpm(f.roots[0]);
  const other = await f.seedNpm(f.roots[1]);
  f.located.set('claude', [other]);
  const items = (await f.ccw.inspect()).items.filter(item => item.kind === 'claude');
  assert.equal(items.length, 2);
  assert.ok(items.some(item => item.location === other && item.id.startsWith('claude:manual:')));
});

test('检查 Windows 程序：合并路径大小写', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const localAppData = path.join(f.root, 'LocalApps');
  const binary = path.join(localAppData, 'OfficeCli/officecli.exe');
  await f.write(binary, '1.0.123');
  f.located.set('officecli', [binary]);
  const ccw = createCcw({
    machine: f.machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform: f.platform,
    localAppData: localAppData.toLowerCase(),
  });
  const items = (await ccw.inspect()).items.filter(item => item.kind === 'officecli');
  assert.equal(items.length, 1);
  assert.ok(items[0].id.startsWith('officecli:native:'));
});

test('安装 npm 程序：修复缺失入口', async t => {
  const f = await fixture(t);
  await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  const binary = f.binary(f.roots[0]);
  await fs.unlink(binary);
  const broken = (await f.ccw.inspect()).items.find(item => item.kind === 'claude');
  assert.ok(broken.facts.some(fact => fact.code === 'program-missing'));
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: broken.id }] });
  assert.equal(plan.items[0].problem, null);
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.ok(await fs.readFile(binary));
});

test('重装健康程序：跳过 npm 操作', async t => {
  const f = await fixture(t);
  await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  const installed = (await f.ccw.inspect()).items.find(item => item.kind === 'claude');
  f.calls.length = 0;
  const healthy = await f.ccw.plan({ task: 'install', selected: [{ id: installed.id }] });
  assert.equal((await f.ccw.apply(healthy.id)).state, 'done');
  assert.equal(
    f.calls.some(call => call.kind === 'npm' && ['view', 'install'].includes(call.target)),
    false,
  );
});

for (const channel of ['npm', 'cmd'])
  test(`取消 Claude ${channel} 安装：保留就绪程序`, async t => {
    const f = await fixture(t);
    const native = path.join(f.home, '.local/bin/claude.exe');
    const controller = new AbortController();
    if (channel === 'cmd') {
      f.state.installFails = true;
      f.state.fetchScript = true;
    }
    const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
    const result = await f.ccw.apply(plan.id, controller.signal, event => {
      if (event.kind === 'effect' && event.effect.code === 'program-ready') controller.abort();
    });
    if (channel === 'cmd') f.located.set('claude', [native]);
    assert.equal(result.state, 'cancelled');
    assert.equal(await fs.readFile(channel === 'npm' ? f.binary(f.roots[0]) : native, 'utf8'), '2.1.2');
    assert.ok(
      (await f.ccw.inspect()).items.some(
        item => item.kind === 'claude' && item.facts.some(fact => fact.code === 'program-exists'),
      ),
    );
    assert.ok(result.remaining);
    assert.deepEqual(await f.read(f.settingsFile), { language: 'English' });
    const retry = await f.ccw.plan({ resume: result.remaining });
    assert.equal(retry.items[0].problem, null);
    const done = await f.ccw.apply(retry.id);
    assert.equal(done.state, 'done', JSON.stringify(done));
    assert.ok(done.items[0].effects.some(effect => effect.code === 'program-ready'));
    assert.equal(
      f.calls.filter(call =>
        channel === 'npm'
          ? call.kind === 'npm' && call.target === 'install'
          : call.kind === 'execute' && call.target === 'cmd.exe',
      ).length,
      1,
    );
  });

test('取消 Claude 同字节重装：缺少快照时不重发命令', async t => {
  const f = await fixture(t);
  await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  const id = (await f.ccw.inspect()).items.find(item => item.kind === 'claude').id;
  const controller = new AbortController();
  f.faults.npm.set('install', async () => controller.abort());
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id, maintenance: 'reinstall' }] });
  const result = await f.ccw.apply(plan.id, controller.signal);
  assert.equal(result.state, 'cancelled');
  const calls = f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length;
  const retry = await f.ccw.plan({ resume: result.remaining });
  const resumed = await f.ccw.apply(retry.id);
  assert.notEqual(resumed.state, 'done', JSON.stringify(resumed));
  assert.ok(resumed.items[0].effects.some(effect => effect.code === 'program-installation-unconfirmed'));
  assert.equal(f.calls.filter(call => call.kind === 'npm' && call.target === 'install').length, calls);
  assert.ok(result.remaining);
});

test('安装后程序缺失：保留命令结果', async t => {
  const f = await fixture(t);
  await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  const item = (await f.ccw.inspect()).items.find(value => value.kind === 'claude');
  await fs.rm(f.binary(f.roots[0]));
  f.state.afterInstall = async () => fs.unlink(f.binary(f.roots[0]));
  const missing = (await f.ccw.inspect()).items.find(value => value.id === item.id);
  assert.equal(
    missing.facts.some(fact => fact.code === 'program-missing'),
    true,
  );
  const result = await f.apply({ task: 'install', selected: [{ id: missing.id }] });
  assert.equal(result.state, 'partial');
  assert.deepEqual(
    result.items[0].effects.slice(-2).map(effect => effect.code),
    ['package-command-completed', 'program-not-ready'],
  );
});

test('更新 Claude：禁止降级', async t => {
  const f = await fixture(t);
  await f.apply({ task: 'install', selected: [{ id: 'claude' }] });
  const item = (await f.ccw.inspect()).items.find(item => item.kind === 'claude');
  f.versions.set(f.roots[0], '2.1.3');
  await f.write(f.binary(f.roots[0]), '2.1.3');
  f.calls.length = 0;
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: item.id, maintenance: 'update' }] });
  assert.equal(plan.items[0].problem, 'newer-version-preserved');
  assert.equal(
    f.calls.some(call => call.kind === 'npm' && call.target === 'install'),
    false,
  );
});

test('npm 安装失败：尝试 CMD 后验证程序', async t => {
  const f = await fixture(t);
  f.state.installFails = true;
  f.state.fetchScript = true;
  const readJson = async file =>
    JSON.parse(
      await fs.readFile(file, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '{}';
        throw error;
      }),
    );
  const baseExecute = f.machine.execute;
  f.machine.execute = async (executable, args, options) => {
    const command = executable === process.execPath ? args.slice(1) : args;
    if (command[0] !== 'plugin') return baseExecute(executable, args, options);
    const result = await baseExecute(executable, args, options);
    if (command[1] === 'marketplace') {
      await f.write(
        path.join(f.claudeRoot, 'plugins/known_marketplaces.json'),
        JSON.stringify({
          'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } },
        }),
      );
      return result;
    }
    const id = command[2];
    const config = await readJson(f.settingsFile);
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
    await f.write(f.settingsFile, JSON.stringify(config));
    return result;
  };
  const baseFetchText = f.machine.fetchText;
  f.machine.fetchText = async (url, options) => {
    f.calls.push({ kind: 'fetch', target: url });
    return baseFetchText(url, options);
  };
  const plan = await f.ccw.plan({
    task: 'install',
    selected: [{ id: 'claude' }, { id: 'plugin:github@claude-plugins-official' }],
  });
  assert.ok(
    plan.items.every(item => item.problem === null),
    JSON.stringify(plan),
  );
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'done');
  assert.ok(result.items[0].effects.some(effect => effect.code === 'npm-install-failed'));
  assert.deepEqual(
    result.items[0].effects.find(effect => effect.code === 'program-ready'),
    { state: 'done', code: 'program-ready', detail: path.join(f.home, '.local/bin/claude.exe') },
  );
  assert.equal(f.calls.filter(call => call.kind === 'execute' && call.target === 'cmd.exe').length, 1);
  assert.equal(
    f.calls.some(call => call.target === 'powershell.exe'),
    false,
  );
  assert.ok(f.calls.some(call => call.kind === 'fetch' && call.target === 'https://claude.ai/install.cmd'));
  assert.equal((await f.read(f.settingsFile)).enabledPlugins['github@claude-plugins-official'], true);
});

test('切换安装渠道：复用 stable 版本', async t => {
  const f = await fixture(t);
  const native = path.join(f.home, '.local/bin/claude.exe');
  f.state.installFails = true;
  f.state.fetchScript = true;
  let stableVersion = '2.1.320';
  const baseNpm = f.machine.npm;
  f.machine.npm = async (args, options) => {
    const stable = args[0] === 'view' && args[1]?.includes('claude-code') && args[1]?.endsWith('@stable');
    const result = await baseNpm(args, options);
    return stable ? ok(JSON.stringify(stableVersion)) : result;
  };
  const baseExecute = f.machine.execute;
  f.machine.execute = async (executable, args, options) => {
    const result = await baseExecute(executable, args, options);
    const command = executable === process.execPath ? args.slice(1) : args;
    if (executable === 'cmd.exe' || (executable === native && (command[0] === 'install' || command[0] === 'update'))) {
      const version = executable === 'cmd.exe' ? args.at(-1) : command[1];
      await f.write(native, version);
      await f.write(path.join(f.home, '.local/share/claude/versions', version), version);
    }
    return result;
  };
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
  stableVersion = '2.1.321';
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.equal(f.calls.find(call => call.kind === 'execute' && call.target === 'cmd.exe').args.at(-1), '2.1.320');
  assert.equal(
    f.calls.filter(call => call.kind === 'npm' && call.args.includes('@anthropic-ai/claude-code@stable')).length,
    1,
  );
  f.located.set('claude', [native]);
  const item = (await f.ccw.inspect()).items.find(item => item.kind === 'claude');
  assert.equal((await f.apply({ task: 'install', selected: [{ id: item.id, maintenance: 'update' }] })).state, 'done');
  assert.ok(
    f.calls.some(
      call =>
        call.kind === 'execute' && call.target === native && call.args[0] === 'install' && call.args[1] === '2.1.321',
    ),
  );
});

test('合并 npm 启动脚本：保留独立副本', async t => {
  const f = await fixture(t);
  const baseNpm = f.machine.npm;
  f.machine.npm = async (args, options) => {
    const result = await baseNpm(args, options);
    if (args[0] === 'ls' && args.at(-1) === '@officecli/officecli')
      return ok(JSON.stringify({ dependencies: { '@officecli/officecli': { version: '1.0.123' } } }));
    return result;
  };
  const vendor = path.join(f.roots[0], '@officecli/officecli/vendor', 'officecli.exe');
  await f.write(vendor, '1.0.123');
  await f.write(
    path.join(f.roots[0], '@officecli/officecli/package.json'),
    JSON.stringify({ name: '@officecli/officecli', version: '1.0.123' }),
  );
  const prefix = path.dirname(f.roots[0]);
  const shims = ['officecli', 'officecli.cmd', 'officecli.ps1'].map(name => path.join(prefix, name));
  for (const file of shims) await f.write(file, 'npm launch script');
  const manual = path.join(f.root, 'independent/officecli.exe');
  await f.write(manual, 'separate binary');
  f.located.set('officecli', [...shims, manual]);
  const items = (await f.ccw.inspect()).items.filter(item => item.kind === 'officecli');
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map(item => item.location),
    [vendor, manual],
  );
});
