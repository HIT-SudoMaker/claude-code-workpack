import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createEnv, ok, registryOf, scopedRegistryOf } from './env.mjs';

test('新实例继续 Claude 安装：默认 npm 源变化不改变已批准的安装来源', async t => {
  const f = await createEnv(t, { seed: { settings: {} } });
  const npmRoot = path.join(f.root, 'npm/lib/node_modules');
  const npmEntry = path.join(f.root, 'npm/npm-cli.js');
  const name = '@anthropic-ai/claude-code';
  const binary = path.join(npmRoot, name, 'cli.js');
  await f.write(npmEntry, 'fixed npm manager identity');
  let configuredRegistry = 'https://registry-a.example.test';
  let installed = false;
  const machine = f.machine({
    processes: async () => [],
    npm: async args => {
      if (args[0] === 'config') return ok(args.at(-1).includes(':') ? 'undefined' : configuredRegistry);
      if (args[0] === 'root') return ok(npmRoot);
      if (args[0] === 'ls')
        return ok(JSON.stringify({ dependencies: installed ? { [name]: { version: '2.1.2' } } : {} }));
      if (args[0] === 'view') return ok(JSON.stringify('2.1.2'));
      if (args[0] === 'install') {
        const registry = scopedRegistryOf(args, '@anthropic-ai') ?? registryOf(args) ?? configuredRegistry;
        installed = true;
        await f.write(binary, 'binary provided by ' + registry);
        await f.json(path.join(npmRoot, name, 'package.json'), {
          name,
          version: '2.1.2',
          bin: { claude: 'cli.js' },
        });
        return ok();
      }
      throw new Error('unexpected-npm-command');
    },
    execute: async (_file, args) => (args.includes('--version') ? ok('2.1.2 Claude Code') : ok()),
  });
  machine.npmIdentity = async () => ({ entry: npmEntry, binary: npmEntry, stamp: await machine.fingerprint(npmEntry) });
  const plan = await f.ccw(machine, { platform: 'linux' }).plan({ task: 'install', selected: [{ id: 'claude' }] });
  assert.ok(
    plan.items.every(item => !item.problem),
    JSON.stringify(plan),
  );
  configuredRegistry = 'https://registry-b.example.test';
  const restarted = f.ccw(machine, { platform: 'linux' });
  const recovery = await restarted.recovery();
  const resumed = await restarted.plan({ resume: recovery.id });
  const result = await restarted.apply(resumed.id);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(await fs.readFile(binary, 'utf8'), 'binary provided by https://registry-a.example.test');
});

test('新实例继续 CCometixLine 安装：保留项目作用域源，覆盖全局安装及后来的作用域配置', async t => {
  const f = await createEnv(t, { seed: { settings: {} } });
  const npmRoot = path.join(f.root, 'npm/lib/node_modules');
  const binary = path.join(f.cclineRoot, 'ccline');
  const name = '@cometix/ccline';
  const projectRegistry = 'https://packages.example.test/project/npm';
  let scopeRegistry = projectRegistry;
  let installed = false;
  const machine = f.machine({
    processes: async () => [],
    npm: async args => {
      if (args[0] === 'config')
        return ok(args.at(-1) === '@cometix:registry' ? scopeRegistry : 'https://default.example.test');
      if (args[0] === 'root') return ok(npmRoot);
      if (args[0] === 'ls')
        return ok(JSON.stringify({ dependencies: installed ? { [name]: { version: '2.0.1' } } : {} }));
      const registry =
        scopedRegistryOf(args, '@cometix') ?? (args.includes('-g') ? 'https://global.example.test' : scopeRegistry);
      if (args[0] === 'view') return registry === projectRegistry ? ok('"2.0.1"') : ok('"2.0.2"');
      if (args[0] === 'install') {
        installed = true;
        await f.write(binary, 'binary provided by ' + registry);
        return ok();
      }
      throw new Error('unexpected-npm-command');
    },
    execute: async () => ok('ccline 2.0.1'),
  });
  const plan = await f.ccw(machine, { platform: 'linux' }).plan({ task: 'install', selected: [{ id: 'ccline' }] });
  assert.equal(plan.items[0].problem, null, JSON.stringify(plan));
  scopeRegistry = 'https://changed-scope.example.test';
  const restarted = f.ccw(machine, { platform: 'linux' });
  const recovery = await restarted.recovery();
  const resumed = await restarted.plan({ resume: recovery.id });
  const result = await restarted.apply(resumed.id);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(await fs.readFile(binary, 'utf8'), 'binary provided by ' + projectRegistry);
});

for (const registry of [
  'https://user:private-password@registry.example.test',
  'https://registry.example.test/?token=private-password',
])
  test('npm 源内含凭据：准备失败且不保存或展示凭据', async t => {
    const f = await createEnv(t);
    const machine = f.machine({
      npm: async args => {
        if (args[0] === 'config') return ok(registry);
        if (args[0] === 'root') return ok(path.join(f.root, 'npm/lib/node_modules'));
        if (args[0] === 'ls') return ok('{"dependencies":{}}');
        throw new Error('unexpected-npm-command');
      },
    });
    const plan = await f.ccw(machine, { platform: 'linux' }).plan({ task: 'install', selected: [{ id: 'claude' }] });
    assert.equal(plan.items[0].problem, 'source-registry-unconfirmed');
    assert.doesNotMatch(JSON.stringify(plan), /private-password/);
    assert.doesNotMatch(await fs.readFile(path.join(f.home, '.ccw/operation.json'), 'utf8'), /private-password/);
    assert.equal(
      f.calls.some(call => ['view', 'install'].includes(call.target)),
      false,
    );
  });
