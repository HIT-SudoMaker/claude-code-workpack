import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createEnv, ok, pluginMarketplaceFiles, revision } from './env.mjs';
import { createCcw } from '../dist/ccw.js';

async function catalogProbe(t, additions) {
  const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratch, 'ccw-catalog-probe-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dist = path.join(directory, 'dist');
  await fs.cp(fileURLToPath(new URL('../dist/', import.meta.url)), dist, { recursive: true });
  await fs.appendFile(
    path.join(dist, 'management-catalog.js'),
    `\n${Object.entries(additions)
      .map(([name, records]) => `Object.assign(${name}, ${JSON.stringify(records)});`)
      .join('\n')}\n`,
  );
  return (await import(pathToFileURL(path.join(dist, 'ccw.js')).href)).createCcw;
}

function ccwOptions(f, machine) {
  return {
    machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform: process.platform,
  };
}

test('新增插件数据：沿用来源校验与用户安装', async t => {
  const createCcw = await catalogProbe(t, {
    pluginSpecs: {
      'virtual-reviewer@claude-plugins-official': {
        title: 'Virtual Reviewer',
        source: 'official',
        exposure: 'offer',
      },
    },
  });
  const id = 'plugin:virtual-reviewer@claude-plugins-official';
  for (const [label, repository] of [
    ['缺失市场', null],
    ['公开别名', 'anthropics/claude-plugins-public'],
    ['冲突来源', 'someone/else'],
  ])
    await t.test(label, async t => {
      const f = await createEnv(t);
      const binary = path.join(f.home, '.local/bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
      await f.write(binary, 'Claude fixture');
      const marketFile = path.join(f.claudeRoot, 'plugins/known_marketplaces.json');
      if (repository !== null)
        await f.json(marketFile, { 'claude-plugins-official': { source: { repo: repository } } });
      const baseMachine = f.machine({
        npm: async () => ok('{}'),
        execute: async (file, args) => {
          if (file === 'git') return ok(`${revision}\tHEAD\n`);
          assert.equal(file, binary);
          if (args[1] === 'marketplace') {
            assert.deepEqual(args, ['plugin', 'marketplace', 'add', 'anthropics/claude-plugins-official']);
            await f.json(marketFile, {
              'claude-plugins-official': { source: { repo: 'anthropics/claude-plugins-official' } },
            });
          } else {
            assert.deepEqual(args, [
              'plugin',
              'install',
              'virtual-reviewer@claude-plugins-official',
              '--scope',
              'user',
            ]);
            const installPath = path.join(f.claudeRoot, 'plugins/cache/virtual-reviewer');
            await f.write(path.join(installPath, '.claude-plugin/plugin.json'), '{}');
            await f.json(path.join(f.claudeRoot, 'plugins/installed_plugins.json'), {
              plugins: {
                'virtual-reviewer@claude-plugins-official': [{ scope: 'user', installPath, gitCommitSha: revision }],
              },
            });
            await baseMachine.editJson(f.settingsFile, settings => {
              settings.enabledPlugins = { 'virtual-reviewer@claude-plugins-official': true };
            });
          }
          return ok();
        },
      });
      const machine = { ...baseMachine, source: async () => pluginMarketplaceFiles(['virtual-reviewer']) };
      const ccw = createCcw(ccwOptions(f, machine));
      const inspected = await ccw.inspect();
      const plan = await ccw.plan({ task: 'install', selected: [{ id }] });
      if (repository === 'someone/else') {
        assert.equal(plan.items[0].problem, 'marketplace-source-conflict');
        assert.equal(f.calls.filter(call => call.kind === 'execute' || call.kind === 'editJson').length, 0);
        return;
      }
      const item = inspected.items.find(entry => entry.id === id);
      assert.ok(item);
      assert.equal(item.title, 'Virtual Reviewer');
      assert.equal(item.canInstall, true);
      assert.deepEqual(item.actions, ['install']);
      assert.ok(inspected.items.some(entry => entry.id === 'plugin:github@claude-plugins-official'));
      assert.equal(plan.items[0].problem, null);
      assert.equal(plan.items[0].title, 'Virtual Reviewer');
      const result = await ccw.apply(plan.id);
      assert.equal(result.state, 'done', JSON.stringify(result));
      const commands = f.calls
        .filter(call => call.kind === 'execute' && call.args[0] === 'plugin')
        .map(call => call.args);
      assert.deepEqual(commands, [
        ['plugin', 'install', 'virtual-reviewer@claude-plugins-official', '--scope', 'user'],
      ]);
    });
});

test('新增套件数据：固定来源并保留已有成员', async t => {
  const f = await createEnv(t);
  await f.write(path.join(f.claudeRoot, 'skills/alpha/SKILL.md'), 'user alpha');
  const sourceCalls = [];
  let remoteHead = revision;
  const createCcw = await catalogProbe(t, {
    skillSuites: {
      'virtual-third': {
        title: 'Virtual Third Suite',
        repository: 'https://example.invalid/virtual/skills',
        folder: 'skills',
      },
    },
  });
  const machine = {
    ...f.machine({
      npm: async () => ok('{}'),
      execute: async (file, args) => {
        assert.equal(file, 'git');
        assert.deepEqual(args, ['ls-remote', 'https://example.invalid/virtual/skills', 'HEAD']);
        return ok(`${remoteHead}\tHEAD\n`);
      },
    }),
    source: async (repository, commit, folder) => {
      sourceCalls.push({ repository, commit, folder });
      return [
        { path: 'alpha/SKILL.md', data: Buffer.from('upstream alpha') },
        { path: 'beta/SKILL.md', data: Buffer.from('beta entry') },
        { path: 'beta/assets/icon.bin', data: Buffer.from([0, 128, 255]) },
        { path: 'beta/reference/demo/SKILL.md', data: Buffer.from('nested example') },
      ];
    },
  };
  const ccw = createCcw(ccwOptions(f, machine));
  const id = 'skill-set:virtual-third';
  const item = (await ccw.inspect()).items.find(entry => entry.id === id);
  assert.ok(item);
  assert.equal(item.title, 'Virtual Third Suite');
  assert.equal(item.canInstall, true);

  const plan = await ccw.plan({ task: 'install', selected: [{ id }] });
  assert.equal(plan.items[0].problem, null);
  assert.equal(plan.items[0].title, 'Virtual Third Suite');
  assert.deepEqual(sourceCalls, [
    { repository: 'https://example.invalid/virtual/skills', commit: revision, folder: 'skills' },
  ]);
  remoteHead = 'f'.repeat(40);
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  assert.equal(await fs.readFile(path.join(f.claudeRoot, 'skills/alpha/SKILL.md'), 'utf8'), 'user alpha');
  assert.equal(await fs.readFile(path.join(f.claudeRoot, 'skills/beta/SKILL.md'), 'utf8'), 'beta entry');
  assert.deepEqual(
    await fs.readFile(path.join(f.claudeRoot, 'skills/beta/assets/icon.bin')),
    Buffer.from([0, 128, 255]),
  );
  assert.equal(
    await fs.readFile(path.join(f.claudeRoot, 'skills/beta/reference/demo/SKILL.md'), 'utf8'),
    'nested example',
  );
  assert.deepEqual((await fs.readdir(path.join(f.claudeRoot, 'skills'))).sort(), ['alpha', 'beta']);
  const saved = (await f.read(path.join(f.home, '.ccw/sources.json')))[path.join(f.claudeRoot, 'skills/beta')];
  assert.equal(saved.repository, 'https://example.invalid/virtual/skills');
  assert.equal(saved.revision, revision);
  assert.equal(f.calls.filter(call => call.kind === 'execute').length, 1);
  assert.equal(sourceCalls.length, 1);
  const beta = (await ccw.inspect()).items.find(entry => entry.id === 'skill:beta');
  assert.equal(beta?.title, 'beta');
  assert.equal(beta?.skillSet, 'virtual-third');
});

test('新增成员数据：从所属套件派生来源', async t => {
  const f = await createEnv(t);
  const createCcw = await catalogProbe(t, {
    skillMembers: { 'virtual-member': { title: 'virtual-member', suite: 'ssre2' } },
  });
  const sourceCalls = [];
  const machine = {
    ...f.machine({
      npm: async () => ok('{}'),
      execute: async (file, args) => {
        assert.equal(file, 'git');
        assert.deepEqual(args, ['ls-remote', 'https://github.com/HIT-SudoMaker/ssre2-skills', 'HEAD']);
        return ok(`${revision}\tHEAD\n`);
      },
    }),
    source: async (repository, commit, folder) => {
      sourceCalls.push({ repository, commit, folder });
      return [{ path: 'SKILL.md', data: Buffer.from('virtual member entry') }];
    },
  };
  const ccw = createCcw(ccwOptions(f, machine));
  assert.equal(
    (await ccw.inspect()).items.some(item => item.id === 'skill:virtual-member'),
    false,
  );
  const plan = await ccw.plan({ task: 'install', selected: [{ id: 'skill:virtual-member' }] });
  assert.equal(plan.items[0].problem, null);
  assert.deepEqual(sourceCalls, [
    {
      repository: 'https://github.com/HIT-SudoMaker/ssre2-skills',
      commit: revision,
      folder: '.agents/skills/virtual-member',
    },
  ]);
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  const item = (await ccw.inspect()).items.find(entry => entry.id === 'skill:virtual-member');
  assert.equal(item?.title, 'virtual-member');
  assert.equal(item?.skillSet, 'ssre2');
  assert.deepEqual(item?.actions, ['update', 'detach']);
});

test('拒绝套件来源越级：不开始远程获取', async t => {
  const f = await createEnv(t);
  const createCcw = await catalogProbe(t, {
    skillSuites: {
      'virtual-invalid': {
        title: 'Invalid Suite',
        repository: 'https://example.invalid/virtual/skills',
        folder: '../skills',
      },
    },
  });
  const ccw = createCcw(ccwOptions(f, f.machine()));
  const plan = await ccw.plan({ task: 'install', selected: [{ id: 'skill-set:virtual-invalid' }] });
  assert.equal(plan.items[0].problem, 'invalid-target');
  assert.equal(f.calls.length, 0);
});

test('第三方插件：停用后经安装页恢复启用', async t => {
  const f = await createEnv(t);
  const name = 'superpowers@claude-plugins-official';
  const installPath = path.join(f.claudeRoot, 'plugins/cache/superpowers');
  await f.write(path.join(installPath, '.claude-plugin/plugin.json'), '{}');
  await f.json(path.join(f.claudeRoot, 'plugins/installed_plugins.json'), {
    plugins: { [name]: [{ scope: 'user', installPath }] },
  });
  await f.json(path.join(f.claudeRoot, 'plugins/known_marketplaces.json'), {
    'claude-plugins-official': { source: { repo: 'anthropics/claude-plugins-official' } },
  });
  await f.json(f.settingsFile, { enabledPlugins: { [name]: false } });
  const binary = path.join(f.home, '.local/bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  await f.write(binary, 'Claude fixture');
  const machine = f.machine({
    npm: async () => ok('{}'),
    execute: async (file, args) => {
      assert.equal(file, binary);
      assert.deepEqual(args, ['plugin', 'enable', name, '--scope', 'user']);
      await f.json(f.settingsFile, { enabledPlugins: { [name]: true } });
      return ok();
    },
  });
  const ccw = createCcw(ccwOptions(f, machine));
  const item = (await ccw.inspect()).items.find(entry => entry.id === `plugin:${name}`);
  assert.deepEqual(item.actions, ['connect']);
  assert.equal(item.canInstall, false);
  const plan = await ccw.plan({ task: 'install', selected: [{ id: `plugin:${name}` }] });
  assert.equal(plan.items[0].problem, null);
  assert.ok(plan.items[0].changes.some(change => change.code === 'plugin-reuse'));
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  assert.equal((await f.read(f.settingsFile)).enabledPlugins[name], true);
});
