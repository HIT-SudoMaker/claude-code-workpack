import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createEnv, ok, revision } from './env.mjs';

test('Claude 登录与启用已有插件可共同确认，插件不会等待不存在的程序步骤', async t => {
  const f = await createEnv(t);
  const name = 'github@claude-plugins-official';
  const claude = path.join(f.home, '.local/bin/claude');
  const pluginPath = path.join(f.claudeRoot, 'plugins/cache/github');
  await f.write(claude, 'native claude binary');
  await f.write(path.join(f.home, '.local/share/claude/versions/2.1.311'), 'native claude binary');
  await f.write(path.join(pluginPath, 'plugin.json'), '{}');
  await f.json(f.settingsFile, { enabledPlugins: { [name]: false } });
  await f.json(path.join(f.claudeRoot, 'plugins/known_marketplaces.json'), {
    'claude-plugins-official': { source: { repo: 'anthropics/claude-plugins-official' } },
  });
  await f.json(path.join(f.claudeRoot, 'plugins/installed_plugins.json'), {
    plugins: { [name]: [{ scope: 'user', installPath: pluginPath }] },
  });
  let enables = 0;
  const machine = f.machine({
    locate: async name => (name === 'claude' ? [claude] : []),
    processes: async () => [],
    npm: async () => ok('{}'),
    execute: async (_file, args, _options, base) => {
      if (args[0] === '--version') return ok('2.1.311 (Claude Code)');
      if (args[0] === 'auth') return ok(args[1] === 'status' ? '{"loggedIn":true}' : '');
      assert.deepEqual(args, ['plugin', 'enable', name, '--scope', 'user']);
      enables++;
      await base.editJson(f.settingsFile, settings => {
        settings.enabledPlugins[name] = true;
      });
      return ok();
    },
  });
  const ccw = f.ccw(machine, { platform: 'linux' });
  const plan = await ccw.plan({
    task: 'install',
    selected: [{ id: 'claude', maintenance: 'login' }, { id: `plugin:${name}` }],
  });
  assert.ok(
    plan.items.every(item => !item.problem),
    JSON.stringify(plan),
  );
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  assert.equal(enables, 1);
  assert.equal((await f.read(f.settingsFile)).enabledPlugins[name], true);
});

test('未派发技能及其等待前置步骤：重启恢复展示待执行', async t => {
  const f = await createEnv(t);
  const machine = {
    ...f.machine({ execute: async () => ok(`${revision}\tHEAD\n`) }),
    source: async () => [{ path: 'SKILL.md', data: Buffer.from('frozen skill') }],
  };
  await f.ccw(machine).plan({ task: 'install', selected: [{ id: 'skill:ssre2-design' }] });
  const recovery = await f.ccw(machine).recovery();
  assert.equal(recovery.items[0].state, 'pending');
  assert.equal(recovery.items[0].problem, undefined);
  assert.equal(
    await fs.stat(path.join(f.claudeRoot, 'skills/ssre2-design')).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test('skill deployment survives a fresh instance without fetching source or deploying twice', async t => {
  const f = await createEnv(t);
  const abort = new AbortController();
  let deployments = 0;
  let sources = 0;
  const base = f.machine({ execute: async () => ok(`${revision}\tHEAD\n`) });
  const machine = {
    ...base,
    source: async () => {
      sources++;
      return [{ path: 'SKILL.md', data: Buffer.from('frozen skill') }];
    },
    replaceTree: async (...args) => {
      deployments++;
      await base.replaceTree(...args);
      abort.abort();
    },
  };
  const first = f.ccw(machine);
  const preview = await first.plan({ task: 'install', selected: [{ id: 'skill:ssre2-design' }] });
  assert.equal(preview.items[0].problem, null);
  const interrupted = await first.apply(preview.id, abort.signal);
  assert.ok(interrupted.remaining);
  const restarted = f.ccw(machine);
  const resumed = await restarted.plan({ resume: interrupted.remaining });
  assert.equal((await restarted.apply(resumed.id)).state, 'done');
  assert.equal(deployments, 1);
  assert.equal(sources, 1);
  assert.equal(await fs.readFile(path.join(f.claudeRoot, 'skills/ssre2-design/SKILL.md'), 'utf8'), 'frozen skill');
});

test('plugin enables existing files then resumes only its transient credential after restart', async t => {
  const f = await createEnv(t);
  const name = 'github@claude-plugins-official';
  const pluginPath = path.join(f.claudeRoot, 'plugins/cache/github');
  const claude = path.join(f.home, 'claude.exe');
  await f.write(claude, 'claude binary');
  await f.write(path.join(pluginPath, 'plugin.json'), '{}');
  await f.json(path.join(f.claudeRoot, 'plugins/known_marketplaces.json'), {
    'claude-plugins-official': { source: { repo: 'anthropics/claude-plugins-official' } },
  });
  await f.json(path.join(f.claudeRoot, 'plugins/installed_plugins.json'), {
    plugins: { [name]: [{ scope: 'user', installPath: pluginPath }] },
  });
  await f.json(f.settingsFile, { enabledPlugins: { [name]: false } });
  const abort = new AbortController();
  let enables = 0;
  const machine = f.machine({
    locate: async name => (name === 'claude' ? [claude] : []),
    npm: async () => ok('{}'),
    execute: async (_file, args, _options, base) => {
      if (args[0] === '--version') return ok('2.1.311 (Claude Code)');
      assert.deepEqual(args, ['plugin', 'enable', name, '--scope', 'user']);
      enables++;
      await base.editJson(f.settingsFile, settings => {
        settings.enabledPlugins[name] = true;
      });
      abort.abort();
      return ok();
    },
  });
  const first = f.ccw(machine);
  const plan = await first.plan({
    task: 'install',
    selected: [{ id: `plugin:${name}`, fields: { secret: 'github-key' } }],
  });
  assert.equal(plan.items[0].problem, null);
  const interrupted = await first.apply(plan.id, abort.signal);
  assert.ok(interrupted.remaining);
  const next = f.ccw(machine);
  const recovery = await next.recovery();
  assert.equal(recovery.inputs.length, 1);
  const resumed = await next.plan({
    resume: recovery.id,
    inputs: { [recovery.inputs[0].operationId]: { secret: 'github-key' } },
  });
  assert.equal((await next.apply(resumed.id)).state, 'done');
  assert.equal(enables, 1);
  assert.equal((await f.read(f.settingsFile)).env.GITHUB_PERSONAL_ACCESS_TOKEN, 'github-key');
});

test('MCP unsaved credentials stay transient and a fresh instance asks for the missing input', async t => {
  const f = await createEnv(t);
  const machine = f.machine();
  const first = f.ccw(machine);
  const preview = await first.plan({
    task: 'install',
    selected: [{ id: 'mcp:context7', fields: { secret: 'never-persist-this-key' } }],
  });
  assert.equal(preview.items[0].problem, null);
  const restarted = f.ccw(machine);
  const recovery = await restarted.recovery();
  assert.equal(recovery.inputs.length, 1);
  const operationId = recovery.inputs[0].operationId;
  const recordFiles = await fs.readdir(path.join(f.home, '.ccw'));
  for (const file of recordFiles.filter(file => file.endsWith('.json')))
    assert.equal(
      (await fs.readFile(path.join(f.home, '.ccw', file), 'utf8')).includes('never-persist-this-key'),
      false,
    );
  const resumed = await restarted.plan({
    resume: recovery.id,
    inputs: { [operationId]: { secret: 'never-persist-this-key' } },
  });
  assert.equal((await restarted.apply(resumed.id)).state, 'done');
  assert.equal((await f.read(f.stateFile)).mcpServers.context7.headers.Authorization, 'Bearer never-persist-this-key');
});

test('plugin installation restores its approved marketplace revision without resolving HEAD again', async t => {
  const f = await createEnv(t);
  const name = 'github@claude-plugins-official';
  const claude = path.join(f.home, 'claude.exe');
  await f.write(claude, 'claude binary');
  await f.json(f.settingsFile, {
    extraKnownMarketplaces: {
      'claude-plugins-official': {
        source: { source: 'github', repo: 'anthropics/claude-plugins-official', ref: 'stable' },
        keep: 'custom-setting',
      },
      external: { keep: true },
    },
  });
  const files = [
    {
      path: '.claude-plugin/marketplace.json',
      data: Buffer.from(
        JSON.stringify({
          name: 'claude-plugins-official',
          plugins: [{ name: 'github', source: './external_plugins/github' }],
        }),
      ),
    },
    { path: 'external_plugins/github/.mcp.json', data: Buffer.from('{}') },
  ];
  const abort = new AbortController();
  let resolutions = 0;
  let installs = 0;
  const base = f.machine({
    locate: async name => (name === 'claude' ? [claude] : []),
    npm: async () => ok('{}'),
    execute: async (file, args, _options, fsMachine) => {
      if (file === 'git') {
        resolutions++;
        return ok(`${revision}\tHEAD\n`);
      }
      if (args[0] === '--version') return ok('2.1.311 (Claude Code)');
      assert.deepEqual(args, ['plugin', 'install', name, '--scope', 'user']);
      installs++;
      const installPath = path.join(f.claudeRoot, 'plugins/cache/github');
      await fsMachine.replaceTree(installPath, [{ path: '.mcp.json', data: Buffer.from('{}') }], null);
      await f.json(path.join(f.claudeRoot, 'plugins/installed_plugins.json'), {
        plugins: { [name]: [{ scope: 'user', installPath, gitCommitSha: revision }] },
      });
      await fsMachine.editJson(f.settingsFile, settings => {
        settings.enabledPlugins = { [name]: true };
      });
      abort.abort();
      return ok();
    },
  });
  const machine = {
    ...base,
    source: async (_repo, sha, folder) => {
      assert.equal(sha, revision);
      assert.equal(folder, '.');
      return files;
    },
  };
  const first = f.ccw(machine);
  const plan = await first.plan({
    task: 'install',
    selected: [{ id: `plugin:${name}`, fields: { secret: 'pending-key' } }],
  });
  assert.equal(plan.items[0].problem, null);
  const result = await first.apply(plan.id, abort.signal);
  assert.ok(result.remaining);
  const second = f.ccw({
    ...machine,
    source: async () => {
      throw new Error('must not re-fetch a confirmed marketplace');
    },
  });
  const recovery = await second.recovery();
  const resumed = await second.plan({
    resume: recovery.id,
    inputs: { [recovery.inputs[0].operationId]: { secret: 'pending-key' } },
  });
  assert.equal((await second.apply(resumed.id)).state, 'done');
  assert.equal(resolutions, 1);
  assert.equal(installs, 1);
  assert.equal(
    (await f.read(path.join(f.claudeRoot, 'plugins/known_marketplaces.json')))['claude-plugins-official'].source.ref,
    undefined,
  );
  assert.equal((await f.read(f.settingsFile)).extraKnownMarketplaces['claude-plugins-official'].source.ref, 'stable');
  assert.equal((await f.read(f.settingsFile)).extraKnownMarketplaces['claude-plugins-official'].keep, 'custom-setting');
  assert.deepEqual((await f.read(f.settingsFile)).extraKnownMarketplaces.external, { keep: true });
});

test('Serena same-byte reinstall with a lost command receipt stays unknown after restart', async t => {
  const f = await createEnv(t);
  const uv = path.join(f.home, '.local/bin/uv.exe');
  const serena = path.join(f.home, '.local/bin/serena.exe');
  await f.write(uv, 'uv binary');
  await f.write(serena, 'same serena bytes');
  await f.json(f.stateFile, { mcpServers: { serena: { command: serena, args: ['start-mcp-server'] } } });
  let installs = 0;
  let metadata = 0;
  const base = f.machine({
    locate: async name => (name === 'uv' ? [uv] : []),
    execute: async (file, args) => {
      assert.equal(file, uv);
      if (args[1] === 'dir') return ok(path.dirname(serena));
      if (args[1] === 'list') return ok('serena-agent v0.1.0\n');
      if (args[1] === 'install') {
        installs++;
        throw new Error('receipt-lost');
      }
      throw new Error(`unexpected command ${args}`);
    },
  });
  const machine = {
    ...base,
    fetchText: async () => {
      metadata++;
      return JSON.stringify({ info: { version: '0.1.0' } });
    },
  };
  const first = f.ccw(machine, { platform: 'win32' });
  const preview = await first.plan({
    task: 'install',
    selected: [
      { id: 'mcp:serena', maintenance: 'reinstall' },
      { id: 'settings', fields: { language: '中文' } },
    ],
  });
  assert.equal(preview.items[0].problem, null);
  const result = await first.apply(preview.id);
  assert.equal(result.items.find(item => item.id === 'settings').state, 'done');
  const second = f.ccw(machine, { platform: 'win32' });
  const resumed = await second.plan({ resume: result.remaining });
  const stopped = await second.apply(resumed.id);
  assert.equal(stopped.state, 'partial');
  assert.ok(stopped.items[0].effects.some(effect => effect.code === 'program-installation-unconfirmed'));
  assert.equal(installs, 1);
  assert.equal(metadata, 1);
});

for (const [label, firstResult, retry] of [
  ['returned nonzero', { code: 1, failed: false, stdout: '' }, true],
  ['timeout', { code: 1, failed: true, stdout: '' }, false],
  ['missing exit status', { code: null, failed: false, stdout: '' }, false],
])
  test(`Serena ${label}：新实例仅重试已知失败的命令`, async t => {
    const f = await createEnv(t);
    const uv = path.join(f.home, '.local/bin/uv.exe');
    const serena = path.join(f.home, '.local/bin/serena.exe');
    await f.write(uv, 'uv binary');
    await f.write(serena, 'same serena bytes');
    await f.json(f.stateFile, { mcpServers: { serena: { command: serena, args: ['start-mcp-server'] } } });
    let installs = 0;
    const machine = {
      ...f.machine({
        locate: async name => (name === 'uv' ? [uv] : []),
        execute: async (file, args) => {
          if (file === serena && args[0] === 'init') return ok();
          assert.equal(file, uv);
          if (args[1] === 'dir') return ok(path.dirname(serena));
          if (args[1] === 'list') return ok('serena-agent v0.1.0\n');
          if (args[1] === 'install') return ++installs === 1 ? firstResult : ok();
          throw new Error('unexpected-command');
        },
      }),
      fetchText: async () => JSON.stringify({ info: { version: '0.1.0' } }),
    };
    const first = f.ccw(machine, { platform: 'win32' });
    const preview = await first.plan({ task: 'install', selected: [{ id: 'mcp:serena', maintenance: 'reinstall' }] });
    assert.equal(preview.items[0].problem, null);
    const result = await first.apply(preview.id);
    assert.ok(result.remaining);
    const restarted = f.ccw(machine, { platform: 'win32' });
    const resumed = await restarted.plan({ resume: result.remaining });
    const done = await restarted.apply(resumed.id);
    assert.equal(installs, retry ? 2 : 1);
    assert.equal(done.state === 'done', retry);
    if (!retry) assert.ok(done.items[0].effects.some(effect => effect.code === 'program-installation-unconfirmed'));
  });

test('cold Serena install freezes the uv script and resumes initialization in a fresh instance', async t => {
  const f = await createEnv(t);
  const uv = path.join(f.home, '.local/bin/uv');
  const serena = path.join(f.home, '.local/bin/serena');
  const abort = new AbortController();
  const counts = { installer: 0, runtime: 0, initialize: 0, metadata: 0, script: 0 };
  const base = f.machine({
    execute: async (file, args) => {
      if (file === 'sh') {
        counts.installer++;
        await f.write(uv, 'uv frozen 0.5.0');
        return ok();
      }
      if (file === uv && args[0] === '--version') return ok('uv 0.5.0');
      if (file === uv && args[1] === 'list')
        return ok(
          await fs.stat(serena).then(
            () => 'serena-agent v0.1.0\n',
            () => '',
          ),
        );
      if (file === uv && args[1] === 'install') {
        counts.runtime++;
        await f.write(serena, 'frozen serena');
        abort.abort();
        return ok();
      }
      if (file === serena && args[0] === 'init') {
        counts.initialize++;
        return ok();
      }
      throw new Error(`unexpected ${file} ${args}`);
    },
  });
  const machine = {
    ...base,
    fetchText: async url => {
      if (url.includes('pypi.org')) {
        counts.metadata++;
        return JSON.stringify({ info: { version: '0.1.0' } });
      }
      counts.script++;
      return 'APP_VERSION="0.5.0"\n';
    },
  };
  const first = f.ccw(machine, { platform: 'linux' });
  const preview = await first.plan({ task: 'install', selected: [{ id: 'mcp:serena' }] });
  assert.equal(preview.items[0].problem, null);
  const result = await first.apply(preview.id, abort.signal);
  assert.ok(result.remaining);
  const second = f.ccw(machine, { platform: 'linux' });
  const resumed = await second.plan({ resume: result.remaining });
  assert.equal((await second.apply(resumed.id)).state, 'done');
  assert.deepEqual(counts, { installer: 1, runtime: 1, initialize: 1, metadata: 1, script: 1 });
  assert.equal((await f.read(f.stateFile)).mcpServers.serena.command, serena);
  assert.equal(
    (await fs.readdir(path.join(f.home, '.ccw'))).some(name => name.startsWith('install-uv-')),
    false,
  );
});
