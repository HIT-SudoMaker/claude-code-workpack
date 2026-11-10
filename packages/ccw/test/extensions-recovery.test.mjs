import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createEnv, ok, revision } from './env.mjs';

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
