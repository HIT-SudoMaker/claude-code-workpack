import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { createEnv, ok, releaseContract } from './env.mjs';

test('OfficeCLI restart reconciles deployed binary and resumes PATH without deploying again', async t => {
  const f = await createEnv(t);
  const bytes = Buffer.from('frozen OfficeCLI release');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const binary = path.join(f.home, '.local/bin/officecli');
  await f.write(binary, 'previous OfficeCLI release');
  let deployments = 0;
  let pathAttempts = 0;
  const base = f.machine({
    npm: async args => (args[0] === 'root' ? ok(path.join(f.root, 'npm/lib/node_modules')) : ok('{"dependencies":{}}')),
    execute: async (_file, args) => (args[0] === '--version' ? ok('OfficeCLI 1.0.123') : ok()),
    processes: async () => [],
  });
  const machine = {
    ...base,
    ...releaseContract({ tag: 'v1.0.123', asset: 'officecli-linux-x64', digest }),
    fetchBytes: async () => bytes,
    async replaceFile(...args) {
      if (args[0] === binary) deployments++;
      return base.replaceFile(...args);
    },
    async ensureUserPath() {
      pathAttempts++;
      if (pathAttempts === 1) throw new Error('path-unavailable');
    },
  };
  const first = f.ccw(machine, { platform: 'linux' });
  const plan = await first.plan({ task: 'install', selected: [{ id: 'officecli', maintenance: 'update' }] });
  assert.equal(plan.items[0].problem, null);
  const result = await first.apply(plan.id);
  assert.ok(result.remaining);
  const restarted = f.ccw(machine, { platform: 'linux' });
  const recovery = await restarted.recovery();
  assert.ok(recovery);
  assert.equal(deployments, 1);
  const continued = await restarted.plan({ resume: recovery.id });
  const done = await restarted.apply(continued.id);
  assert.equal(done.state, 'done');
  assert.equal(deployments, 1);
  assert.equal(pathAttempts, 2);
  assert.equal(await machine.fingerprint(binary), digest);
});

test('Claude same-byte reinstall with a lost command receipt remains paused after restart', async t => {
  const f = await createEnv(t);
  const root = path.join(f.root, 'npm/lib/node_modules');
  const directory = path.join(root, '@anthropic-ai/claude-code');
  const binary = path.join(directory, 'cli.js');
  await f.json(path.join(directory, 'package.json'), { name: '@anthropic-ai/claude-code', bin: { claude: 'cli.js' } });
  await f.write(binary, 'unchanged program bytes');
  let installs = 0;
  let queries = 0;
  const machine = f.machine({
    npm: async args => {
      if (args[0] === 'root') return ok(root);
      if (args[0] === 'ls')
        return ok(JSON.stringify({ dependencies: { '@anthropic-ai/claude-code': { version: '2.1.2' } } }));
      if (args[0] === 'view') {
        queries++;
        return ok('"2.1.2"');
      }
      if (args[0] === 'install') {
        installs++;
        await f.write(binary, 'unchanged program bytes');
        throw new Error('command-return-lost');
      }
      throw new Error('unexpected-command');
    },
    execute: async () => ok('2.1.2 Claude Code'),
    processes: async () => [],
  });
  const first = f.ccw(machine, { platform: 'linux' });
  const plan = await first.plan({ task: 'install', selected: [{ id: 'claude', maintenance: 'reinstall' }] });
  assert.equal(plan.items[0].problem, null);
  const result = await first.apply(plan.id);
  assert.notEqual(result.state, 'done');
  assert.equal(installs, 1);
  const frozenQueries = queries;
  const restarted = f.ccw(machine, { platform: 'linux' });
  const recovery = await restarted.recovery();
  const resumed = await restarted.plan({ resume: recovery.id });
  const stillPaused = await restarted.apply(resumed.id);
  assert.notEqual(stillPaused.state, 'done');
  assert.equal(installs, 1);
  assert.equal(queries, frozenQueries);
  assert.ok(stillPaused.items[0].effects.some(effect => effect.code === 'program-installation-unconfirmed'));
});

test('Claude restart completes only defaults after a verified installation', async t => {
  const f = await createEnv(t);
  const root = path.join(f.root, 'npm/lib/node_modules');
  const directory = path.join(root, '@anthropic-ai/claude-code');
  const binary = path.join(directory, 'cli.js');
  let version = null;
  let installs = 0;
  let queries = 0;
  let failDefaults = true;
  const base = f.machine({
    npm: async args => {
      if (args[0] === 'root') return ok(root);
      if (args[0] === 'ls')
        return ok(JSON.stringify({ dependencies: version ? { '@anthropic-ai/claude-code': { version } } : {} }));
      if (args[0] === 'view') {
        queries++;
        return ok('"2.1.2"');
      }
      if (args[0] === 'install') {
        installs++;
        version = '2.1.2';
        await f.json(path.join(directory, 'package.json'), { bin: { claude: 'cli.js' } });
        await f.write(binary, 'verified program');
        return ok();
      }
      throw new Error('unexpected-command');
    },
    execute: async () => ok('2.1.2 Claude Code'),
    processes: async () => [],
  });
  const machine = {
    ...base,
    async editJson(file, edit) {
      if (file === f.settingsFile && failDefaults) throw new Error('settings-locked');
      return base.editJson(file, edit);
    },
  };
  const first = f.ccw(machine, { platform: 'linux' });
  const plan = await first.plan({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(plan.items[0].problem, null);
  const result = await first.apply(plan.id);
  assert.ok(result.remaining);
  assert.equal(installs, 1);
  failDefaults = false;
  const frozenQueries = queries;
  const restarted = f.ccw(machine, { platform: 'linux' });
  const recovery = await restarted.recovery();
  const resumed = await restarted.plan({ resume: recovery.id });
  const done = await restarted.apply(resumed.id);
  assert.equal(done.state, 'done', JSON.stringify(done));
  assert.equal(installs, 1);
  assert.equal(queries, frozenQueries);
  assert.equal((await f.read(f.settingsFile)).permissions.defaultMode, 'bypassPermissions');
});

test('Claude CMD restart cleans its frozen installer directory without reinstalling the program', async t => {
  const f = await createEnv(t);
  const root = path.join(f.root, 'npm/node_modules');
  const binary = path.join(f.home, '.local/bin/claude.exe');
  let npmInstalls = 0;
  let cmdInstalls = 0;
  let cleanups = 0;
  const base = f.machine({
    npm: async args => {
      if (args[0] === 'root') return ok(root);
      if (args[0] === 'view') return ok('"2.1.2"');
      if (args[0] === 'ls') return ok('{"dependencies":{}}');
      if (args[0] === 'install') {
        npmInstalls++;
        return { code: 1, failed: false, stdout: '' };
      }
      throw new Error('unexpected-command');
    },
    execute: async (file, args) => {
      if (file === 'cmd.exe') {
        cmdInstalls++;
        await f.write(binary, 'native Claude 2.1.2');
        await f.write(path.join(f.home, '.local/share/claude/versions/2.1.2'), 'native Claude 2.1.2');
        return ok();
      }
      return args[0] === '--version' ? ok('2.1.2 Claude Code') : ok();
    },
    processes: async () => [],
  });
  const machine = {
    ...base,
    fetchText: async () => '@echo off\r\n',
    async removeTree(file, ...args) {
      if (path.basename(file).startsWith('install-claude-')) {
        cleanups++;
        if (cleanups === 1) throw new Error('installer-locked');
      }
      return base.removeTree(file, ...args);
    },
  };
  const first = f.ccw(machine, { platform: 'win32' });
  const plan = await first.plan({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(plan.items[0].problem, null);
  const result = await first.apply(plan.id);
  assert.ok(result.remaining, JSON.stringify(result));
  assert.equal(cmdInstalls, 1);
  const restarted = f.ccw(machine, { platform: 'win32' });
  const recovery = await restarted.recovery();
  const resumed = await restarted.plan({ resume: recovery.id });
  const done = await restarted.apply(resumed.id);
  assert.equal(done.state, 'done', JSON.stringify(done));
  assert.equal(npmInstalls, 1);
  assert.equal(cmdInstalls, 1);
  assert.equal(cleanups, 2);
});
