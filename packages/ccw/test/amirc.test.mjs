import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createEnv, ok } from './env.mjs';

async function fixture(t, seed = {}) {
  const f = await createEnv(t, { seed });
  const ccw = f.ccw(f.machine({ npm: async () => ok('{}') }));
  const apply = async (id, task = 'install') => {
    const plan = await ccw.plan({ task, selected: [{ id }] });
    assert.equal(plan.items[0].problem, null, JSON.stringify(plan));
    return ccw.apply(plan.id);
  };
  return { ...f, ccw, apply, skill: path.join(f.claudeRoot, 'skills/amirc-research') };
}

test('安装随包 AMIRC 技能：离线重装保留内容', async t => {
  const f = await fixture(t, { settings: { permissions: { allow: ['Read'] } }, state: {} });
  const items = (await f.ccw.inspect()).items;
  assert.ok(items.some(item => item.id === 'skill:amirc-research' && item.canInstall));
  assert.equal(
    items.some(item => item.id === 'mcp:amirc'),
    false,
  );
  assert.equal((await f.apply('skill:amirc-research')).state, 'done');
  const text = await fs.readFile(path.join(f.skill, 'SKILL.md'), 'utf8');
  assert.match(text, /name: amirc-research/);
  assert.doesNotMatch(text, /organize_papers|structuredContent/);
  assert.deepEqual(await f.read(f.stateFile), {});
  assert.deepEqual(await f.read(f.settingsFile), { permissions: { allow: ['Read'] } });
  assert.equal(
    f.calls.some(call => call.kind === 'execute'),
    false,
  );
  await fs.appendFile(path.join(f.skill, 'SKILL.md'), '\nuser addition\n');
  assert.equal((await f.apply('skill:amirc-research')).state, 'done');
  assert.match(await fs.readFile(path.join(f.skill, 'SKILL.md'), 'utf8'), /user addition/);
  const update = await f.ccw.plan({
    task: 'install',
    selected: [{ id: 'skill:amirc-research', maintenance: 'update' }],
  });
  assert.equal(update.items[0].problem, 'local-edits-preserved');
});

test('解除随包 AMIRC 技能：保留可恢复副本', async t => {
  const f = await fixture(t);
  assert.equal((await f.apply('skill:amirc-research')).state, 'done');
  assert.equal((await f.apply('skill:amirc-research', 'detach')).state, 'done');
  await assert.rejects(fs.stat(f.skill), { code: 'ENOENT' });
  assert.ok((await fs.readdir(path.join(f.home, '.ccw/disabled'))).some(name => name.endsWith('-amirc-research')));
});

test('解除旧 AMIRC 注册：清 allow 精确项，保留技能与 ask/deny', async t => {
  const old = ['mcp__amirc__organize_papers', 'mcp__amirc__get_papers', 'mcp__amirc__search_papers'];
  const f = await fixture(t, {
    settings: { permissions: { allow: [...old, 'Read'], ask: old, deny: old } },
    state: { mcpServers: { amirc: { command: 'old runtime' }, external: { command: 'keep' } } },
  });
  assert.equal((await f.apply('skill:amirc-research')).state, 'done');
  assert.equal((await f.apply('mcp:amirc', 'detach')).state, 'done');
  assert.deepEqual((await f.read(f.settingsFile)).permissions, { allow: ['Read'], ask: old, deny: old });
  assert.deepEqual((await f.read(f.stateFile)).mcpServers, { external: { command: 'keep' } });
  assert.ok(await fs.stat(path.join(f.skill, 'SKILL.md')));
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'mcp:amirc' }] });
  assert.equal(plan.items[0].problem, 'action-unavailable');
});

test('执行 AMIRC 计划：拦截新建同名目录', async t => {
  const f = await fixture(t);
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill:amirc-research' }] });
  await f.write(path.join(f.skill, 'SKILL.md'), 'external');
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.items[0].effects.at(-1).code, 'target-changed');
  assert.equal(await fs.readFile(path.join(f.skill, 'SKILL.md'), 'utf8'), 'external');
});

async function ccwWithUnreadableSettings(t, isRegistered) {
  const f = await createEnv(t, {
    seed: {
      settings: { permissions: { allow: ['Read'] } },
      ...(isRegistered ? { state: { mcpServers: { amirc: { command: 'old runtime' } } } } : {}),
    },
  });
  return f.ccw(
    f.machine({
      npm: async () => ok('{}'),
      read: async (target, base) => {
        if (target === f.settingsFile) throw new Error('settings-unreadable');
        return base.read(target);
      },
    }),
  );
}

test('检查退役许可：读取失败保持未知', async t => {
  for (const isRegistered of [false, true]) {
    const ccw = await ccwWithUnreadableSettings(t, isRegistered);
    const amirc = (await ccw.inspect()).items.find(item => item.id === 'mcp:amirc');
    assert.ok(amirc, '读取失败时退役许可条目仍可见');
    assert.equal(amirc.problem, 'settings-unreadable');
    assert.deepEqual(amirc.actions, [], isRegistered ? '已注册：证据未知不授予解除资格' : '未注册：无注册无许可');
  }
});

test('检查退役许可：按注册状态陈述事实', async t => {
  for (const [isRegistered, code] of [
    [false, 'not-registered'],
    [true, 'registration-exists'],
  ]) {
    const ccw = await ccwWithUnreadableSettings(t, isRegistered);
    const amirc = (await ccw.inspect()).items.find(item => item.id === 'mcp:amirc');
    assert.ok(amirc, '读取失败时退役许可条目仍可见');
    assert.ok(amirc.facts.some(fact => fact.code === code));
  }
});
