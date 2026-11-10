import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createCcw } from '../dist/ccw.js';
import { createEnv, exists, ok } from './env.mjs';

async function fixture(t) {
  const f = await createEnv(t, {
    seed: { settings: { language: 'user', env: { ANTHROPIC_API_KEY: 'saved-key' } }, state: { projects: {} } },
  });
  const npmRoot = path.join(f.root, 'npm/node_modules');
  const packageRoot = path.join(npmRoot, '@anthropic-ai/claude-code');
  const native = path.join(f.home, '.local/bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  await f.write(native, 'native Claude');
  await f.write(path.join(f.home, '.local/share/claude/versions/2.1.311'), 'native Claude');
  const state = { npmVersion: null, leavePackage: false, loseRootReceipt: false, unreadable: false };
  let rootRemovals = 0;
  const base = f.machine({
    locate: async name => (name === 'claude' ? [native] : []),
    processes: async () => [],
    execute: async (_file, args) => (args.includes('--version') ? ok('2.1.311 Claude Code') : ok()),
    npm: async args => {
      if (args[0] === 'root') return ok(npmRoot);
      if (args[0] === 'ls')
        return ok(
          JSON.stringify({
            dependencies:
              state.npmVersion === null ? {} : { '@anthropic-ai/claude-code': { version: state.npmVersion } },
          }),
        );
      if (args[0] === 'uninstall') {
        if (!state.leavePackage) {
          state.npmVersion = null;
          await fs.rm(packageRoot, { recursive: true, force: true });
        }
        return state.leavePackage ? { code: 1, failed: false, stdout: '' } : ok();
      }
      throw new Error('unexpected-npm-' + args[0]);
    },
  });
  const machine = {
    ...base,
    async treeStamp(file, signal) {
      if (state.unreadable && file === f.claudeRoot) throw new Error('root-unreadable');
      return base.treeStamp(file, signal);
    },
    async removeTree(file, stamp, backup) {
      if (file === f.claudeRoot) rootRemovals++;
      await base.removeTree(file, stamp, backup);
      if (file === f.claudeRoot && state.loseRootReceipt) {
        state.unreadable = true;
        throw new Error('receipt-lost');
      }
    },
  };
  const ccw = () =>
    createCcw({
      machine,
      home: f.home,
      claudeRoot: f.claudeRoot,
      cclineRoot: f.cclineRoot,
      platform: process.platform,
    });
  return {
    ...f,
    machine,
    state,
    ccw,
    rootRemovals: () => rootRemovals,
    async seedNpm() {
      state.npmVersion = '2.1.311';
      await f.json(path.join(packageRoot, 'package.json'), {
        name: '@anthropic-ai/claude-code',
        version: state.npmVersion,
        bin: { claude: 'cli.js' },
      });
      await f.write(path.join(packageRoot, 'cli.js'), 'npm Claude');
    },
  };
}

test('Claude 数据删除回执丢失：新实例只核对并删除剩余状态', async t => {
  const f = await fixture(t);
  const firstCcw = f.ccw();
  f.state.loseRootReceipt = true;
  const first = await firstCcw.apply(
    (await firstCcw.plan({ task: 'uninstall', selected: [{ id: 'claude' }], removeData: true })).id,
  );
  assert.ok(first.remaining);
  assert.equal(await exists(f.claudeRoot), false);
  assert.equal(await exists(f.stateFile), true);
  assert.ok(!first.items.at(-1).effects.some(effect => effect.code === 'claude-data-cleared'));
  f.state.unreadable = false;
  f.state.loseRootReceipt = false;
  const restarted = f.ccw();
  const resumed = await restarted.plan({ resume: first.remaining });
  const resumedResult = await restarted.apply(resumed.id);
  assert.equal(resumedResult.state, 'done', JSON.stringify(resumedResult));
  assert.equal(f.rootRemovals(), 1);
  assert.equal(await exists(f.stateFile), false);
});

test('Claude 数据目录重建：新实例保护新目录及尚未删除的状态', async t => {
  const f = await fixture(t);
  const firstCcw = f.ccw();
  const abort = new AbortController();
  const first = await firstCcw.apply(
    (await firstCcw.plan({ task: 'uninstall', selected: [{ id: 'claude' }], removeData: true })).id,
    abort.signal,
    event => {
      if (event.kind === 'effect' && event.effect.code === 'claude-data-removed') abort.abort();
    },
  );
  assert.equal(first.state, 'cancelled');
  await f.json(f.settingsFile, { language: 'new user data' });
  const restarted = f.ccw();
  const resumed = await restarted.plan({ resume: first.remaining });
  const result = await restarted.apply(resumed.id);
  assert.notEqual(result.state, 'done');
  assert.equal(f.rootRemovals(), 1);
  assert.deepEqual(await f.read(f.settingsFile), { language: 'new user data' });
  assert.equal(await exists(f.stateFile), true);
});

test('删除 Claude 数据：等待所有已选择程序的卸载验收', async t => {
  const f = await fixture(t);
  await f.seedNpm();
  f.state.leavePackage = true;
  const firstCcw = f.ccw();
  const programs = (await firstCcw.inspect()).items.filter(
    item => item.kind === 'claude' && item.actions.includes('uninstall'),
  );
  assert.equal(programs.length, 2);
  const first = await firstCcw.apply(
    (await firstCcw.plan({ task: 'uninstall', selected: programs.map(item => ({ id: item.id })), removeData: true }))
      .id,
  );
  assert.ok(first.remaining);
  assert.equal(f.rootRemovals(), 0);
  assert.equal(await exists(f.settingsFile), true);
  assert.ok(!first.items.at(-1).effects.some(effect => effect.code === 'claude-data-cleared'));
  f.state.leavePackage = false;
  const restarted = f.ccw();
  const resumed = await restarted.plan({ resume: first.remaining });
  assert.equal((await restarted.apply(resumed.id)).state, 'done');
  assert.equal(f.rootRemovals(), 1);
});

test('Claude 卸载准备失败：数据暂停且独立解除接入仍可执行', async t => {
  const f = await fixture(t);
  await f.json(f.settingsFile, { statusLine: { type: 'command', command: 'ccline' }, language: 'user' });
  const ccw = f.ccw();
  const plan = await ccw.plan({
    task: 'uninstall',
    selected: [{ id: 'claude:missing-copy' }, { id: 'ccline', removal: 'detach' }],
    removeData: true,
  });
  assert.equal(plan.items.find(item => item.id === 'data:claude').problem, 'dependency-not-ready');
  assert.equal((await ccw.apply(plan.id)).state, 'partial');
  assert.equal((await f.read(f.settingsFile)).statusLine, undefined);
  assert.equal(await exists(f.claudeRoot), true);
  assert.equal(f.rootRemovals(), 0);
});
