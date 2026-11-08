import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createCcw } from '../dist/ccw.js';
import { createEnv, exists, ok } from './env.mjs';

const revision = '0123456789abcdef0123456789abcdef01234567';

/** 技能域世界：git 修订单源、来源载荷应答与 replaceTree/treeStamp 写入旋钮，只装技能安装所需能力 */
async function fixture(t) {
  const f = await createEnv(t, { layout: 'root' });
  const state = {
    failReplaceTree: null, // 成员基名：replaceTree 注入 fixture-write-failed
    failTreeStampOnce: null, // 目录路径：有写入后的首次确认 stamp 抛错（一次性）
    treeWrites: 0, // replaceTree 成功计数，配合 failTreeStampOnce
    sourcePayload: null, // 整体替换 source 载荷
  };
  const readJson = async file => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  };
  const base = f.machine({
    processes: async () => [],
    npm: async () => ok('{}'), // 检查页 npm 探测一律空依赖
    execute: async (file, args) => {
      if (file === 'git' && args[0] === 'ls-remote') return ok(`${revision}\tHEAD\n`);
      throw new Error(`Unexpected command: ${file}`);
    },
  });
  // env.mjs 的 machine 只透传 npm/execute/editJson：source/replaceTree/treeStamp 在其上局部包装
  const machine = {
    ...base,
    async source(repository, sourceRevision, folder) {
      if (state.sourcePayload !== null) return state.sourcePayload;
      if (folder === '.agents/skills' || folder === 'skills')
        return (
          repository.includes('mattpocock')
            ? ['engineering/tdd', 'engineering/code-review']
            : ['ssre2-design', 'ssre2-review']
        ).flatMap(name => [
          { path: `${name}/SKILL.md`, data: Buffer.from(`---\nname: ${path.basename(name)}\n---\n`) },
          { path: `${name}/assets/icon.bin`, data: Uint8Array.from([0, 128, 255]) },
        ]);
      return [
        { path: 'SKILL.md', data: Buffer.from(`---\nname: ${path.basename(folder)}\n---\nSee reference/details.md`) },
        { path: 'reference/details.md', data: Buffer.from('independent reference bytes') },
        { path: 'assets/icon.bin', data: Uint8Array.from([0, 128, 255]) },
      ];
    },
    async replaceTree(directory, files, expected, preserveAt) {
      if (state.failReplaceTree !== null && path.basename(directory) === state.failReplaceTree)
        throw new Error('fixture-write-failed');
      f.calls.push({ kind: 'replaceTree', target: directory });
      await base.replaceTree(directory, files, expected, preserveAt);
      state.treeWrites++;
    },
    async treeStamp(...args) {
      if (state.failTreeStampOnce !== null && args[0] === state.failTreeStampOnce && state.treeWrites > 0) {
        state.failTreeStampOnce = null;
        throw new Error('temporary-read-failed');
      }
      return base.treeStamp(...args);
    },
  };
  const ccw = createCcw({
    machine,
    home: f.home,
    claudeRoot: f.claudeRoot,
    cclineRoot: f.cclineRoot,
    platform: process.platform,
  });
  const apply = async input => {
    const plan = await ccw.plan(input);
    assert.ok(
      plan.items.every(item => item.problem === null),
      JSON.stringify(plan),
    );
    return ccw.apply(plan.id);
  };
  return { ...f, state, machine, ccw, readJson, apply };
}

test('安装技能：填充空目录', async t => {
  const f = await fixture(t);
  const directory = path.join(f.claudeRoot, 'skills/tdd');
  await fs.mkdir(directory, { recursive: true });
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  assert.equal(plan.items[0].problem, null);
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.ok((await f.ccw.inspect()).items.some(item => item.id === 'skill:tdd'));
});

test('重复安装技能：保护本地修改', async t => {
  const f = await fixture(t);
  const directory = path.join(f.claudeRoot, 'skills/tdd');
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  assert.equal(plan.items[0].problem, null);
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  await fs.unlink(path.join(directory, 'SKILL.md'));
  await f.write(path.join(directory, 'user.txt'), 'keep');
  const blocked = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  assert.equal(blocked.items[0].problem, 'local-edits-preserved');
  assert.equal(await fs.readFile(path.join(directory, 'user.txt'), 'utf8'), 'keep');
});

test('删除已装技能：阻止旧任务恢复', async t => {
  const f = await fixture(t);
  f.state.failReplaceTree = 'code-review';
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  const first = await f.ccw.apply(plan.id);
  const completed = path.join(f.claudeRoot, 'skills/tdd');
  await fs.rm(completed, { recursive: true });
  const rest = await f.ccw.plan({ resume: first.remaining });
  const stopped = await f.ccw.apply(rest.id);
  assert.equal(stopped.items[0].effects.at(-1).code, 'target-changed');
  assert.equal(await exists(completed), false);
  await f.ccw.plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
  await assert.rejects(f.ccw.plan({ resume: stopped.remaining }), /plan-unavailable/);
});

test('删除已有技能：阻止旧安装计划', async t => {
  const f = await fixture(t);
  const directory = path.join(f.claudeRoot, 'skills/tdd');
  await f.write(path.join(directory, 'SKILL.md'), 'existing');
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  assert.equal(plan.items[0].problem, null);
  await fs.rm(directory, { recursive: true });
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.items[0].effects.at(-1).code, 'target-changed');
  assert.equal(await exists(directory), false);
});

test('继续技能写后确认：不重复部署', async t => {
  const f = await fixture(t);
  const directory = path.join(f.claudeRoot, 'skills/ssre2-design');
  f.state.failTreeStampOnce = directory;
  const writes = () => f.calls.filter(call => call.kind === 'replaceTree' && call.target === directory).length;
  const first = await f.apply({ task: 'install', selected: [{ id: 'skill:ssre2-design' }] });
  assert.equal(first.state, 'partial');
  assert.ok(first.remaining);
  const retry = await f.apply({ resume: first.remaining });
  assert.equal(retry.state, 'done', JSON.stringify(retry));
  assert.equal(writes(), 1);
});

test('保存技能来源失败：保留安装结果', async t => {
  const f = await fixture(t);
  const directory = path.join(f.claudeRoot, 'skills/ssre2-design');
  const metadataFile = path.join(f.home, '.ccw/sources.json');
  f.faults.editJson.set(metadataFile, new Error('metadata-unavailable'));
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill:ssre2-design' }] });
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'done');
  assert.ok(first.items[0].effects.some(effect => effect.code === 'skill-installed'));
  const installedStamp = await f.machine.treeStamp(directory);
  assert.ok(installedStamp);
  f.faults.editJson.delete(metadataFile);
  assert.ok(first.items[0].effects.some(effect => effect.code === 'source-metadata-unavailable'));
});

test('安装技能：来源记录读取失败保持未知', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.home, '.ccw/sources.json'), 'not json');
  const blocked = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill:ssre2-design' }] });
  assert.equal(blocked.items[0].problem, 'source-metadata-unavailable');
  assert.equal(await exists(path.join(f.claudeRoot, 'skills/ssre2-design')), false);
});

test('重复安装技能：来源未知不误报本地修改', async t => {
  const f = await fixture(t);
  const directory = path.join(f.claudeRoot, 'skills/ssre2-design');
  await f.write(path.join(directory, 'user.txt'), 'keep');
  await f.write(path.join(f.home, '.ccw/sources.json'), 'not json');
  const blocked = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill:ssre2-design' }] });
  assert.equal(blocked.items[0].problem, 'source-metadata-unavailable');
  assert.equal(await fs.readFile(path.join(directory, 'user.txt'), 'utf8'), 'keep');
});

test('更新技能：来源记录读取失败保持未知', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.claudeRoot, 'skills/ssre2-design/SKILL.md'), 'my text');
  await f.write(path.join(f.home, '.ccw/sources.json'), 'not json');
  const blocked = await f.ccw.plan({
    task: 'install',
    selected: [{ id: 'skill:ssre2-design', maintenance: 'update' }],
  });
  assert.equal(blocked.items[0].problem, 'source-metadata-unavailable');
});

test('安装技能方案：来源记录读取失败保持未知', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.home, '.ccw/sources.json'), 'not json');
  const blocked = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  assert.equal(blocked.items[0].problem, 'source-metadata-unavailable');
  assert.equal(await exists(path.join(f.claudeRoot, 'skills/tdd')), false);
});

test('更新技能：来源记录冲突外部优先', async t => {
  const f = await fixture(t);
  const directory = path.join(f.claudeRoot, 'skills/ssre2-design');
  const metadataFile = path.join(f.home, '.ccw/sources.json');
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill:ssre2-design' }] });
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'done');
  assert.ok(first.items[0].effects.some(effect => effect.code === 'skill-installed'));
  const installedStamp = await f.machine.treeStamp(directory);
  assert.ok(installedStamp);
  await f.write(metadataFile, '{}');
  const retry = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill:ssre2-design', maintenance: 'update' }] });
  const externalRecord = { repository: 'external/repository', revision: 'external', stamp: installedStamp };
  await f.write(metadataFile, JSON.stringify({ [directory]: externalRecord }));
  const conflicted = await f.ccw.apply(retry.id);
  assert.equal(conflicted.state, 'done');
  assert.deepEqual((await f.readJson(metadataFile))[directory], externalRecord);
  await f.write(metadataFile, '{}');
  const repair = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill:ssre2-design', maintenance: 'update' }] });
  assert.equal((await f.ccw.apply(repair.id)).state, 'done');
  assert.equal(await f.machine.treeStamp(directory), installedStamp);
  const record = (await f.readJson(metadataFile))[directory];
  assert.equal(record.stamp, installedStamp);
  assert.equal(record.revision, revision);
});

test('保存整套来源失败：保留安装结果', async t => {
  const f = await fixture(t);
  const metadataFile = path.join(f.home, '.ccw/sources.json');
  f.faults.editJson.set(metadataFile, new Error('metadata-unavailable'));
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  const first = await f.ccw.apply(plan.id);
  assert.equal(first.state, 'done');
  assert.equal(await exists(path.join(f.claudeRoot, 'skills/code-review')), true);
  assert.equal(await exists(path.join(f.claudeRoot, 'skills/tdd')), true);
  f.faults.editJson.delete(metadataFile);
  const retry = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  assert.equal((await f.ccw.apply(retry.id)).state, 'done');
  assert.ok(await fs.readFile(path.join(f.claudeRoot, 'skills/code-review/SKILL.md')));
  assert.ok(await fs.readFile(path.join(f.claudeRoot, 'skills/tdd/SKILL.md')));
});

test('重复安装技能：仅补缺失成员', async t => {
  const f = await fixture(t);
  const file = path.join(f.claudeRoot, 'skills/ssre2-design/SKILL.md');
  await f.write(file, 'user changes');
  const selections = [{ id: 'skill-set:ssre2' }, { id: 'skill-set:mattpocock' }];
  assert.equal((await f.apply({ task: 'install', selected: selections })).state, 'done');
  assert.equal(await fs.readFile(file, 'utf8'), 'user changes');
  for (const name of ['ssre2-review', 'tdd', 'code-review'])
    assert.ok(await fs.readFile(path.join(f.claudeRoot, 'skills', name, 'SKILL.md')));
  const repeated = await f.apply({ task: 'install', selected: selections });
  assert.equal(repeated.state, 'done');
  assert.ok(repeated.items.every(item => item.effects.every(effect => effect.state === 'kept')));
  assert.equal(
    f.calls.some(call => call.kind === 'execute' && call.args.includes('plugin')),
    false,
  );
});

test('安装分类技能：保留资源目录', async t => {
  const f = await fixture(t);
  const payload = [
    ['engineering/tdd/SKILL.md', 'tdd entry'],
    ['engineering/tdd/reference/examples/demo/SKILL.md', 'nested example'],
    ['productivity/writing-for-agents/SKILL.md', 'writing entry'],
    ['engineering/README.md', 'category description'],
  ].map(([file, text]) => ({ path: file, data: Buffer.from(text) }));
  f.state.sourcePayload = payload;
  const selection = [{ id: 'skill-set:mattpocock' }];
  assert.equal((await f.apply({ task: 'install', selected: selection })).state, 'done');
  for (const [file, text] of [
    ['tdd/SKILL.md', 'tdd entry'],
    ['tdd/reference/examples/demo/SKILL.md', 'nested example'],
    ['writing-for-agents/SKILL.md', 'writing entry'],
  ]) {
    assert.equal(await fs.readFile(path.join(f.claudeRoot, 'skills', file), 'utf8'), text);
  }
  assert.deepEqual((await fs.readdir(path.join(f.claudeRoot, 'skills'))).sort(), ['tdd', 'writing-for-agents']);
  const view = await f.ccw.inspect();
  assert.equal(view.items.find(item => item.id === 'skill:tdd').skillSet, 'mattpocock');
  await f.write(path.join(f.claudeRoot, 'skills/tdd/SKILL.md'), 'user edit');
  assert.equal((await f.apply({ task: 'install', selected: selection })).state, 'done');
  assert.equal(await fs.readFile(path.join(f.claudeRoot, 'skills/tdd/SKILL.md'), 'utf8'), 'user edit');
});

test('安装同名技能：拒绝目录冲突', async t => {
  const f = await fixture(t);
  f.state.sourcePayload = ['engineering/shared/SKILL.md', 'productivity/shared/SKILL.md'].map(file => ({
    path: file,
    data: Buffer.from(file),
  }));
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  assert.equal(plan.items[0].problem, 'skill-name-conflict');
  assert.equal(await exists(path.join(f.claudeRoot, 'skills')), false);
});

test('替换已修改技能：保留旧副本', async t => {
  const f = await fixture(t);
  const directory = path.join(f.claudeRoot, 'skills/ssre2-design');
  await f.write(path.join(directory, 'SKILL.md'), 'my handwritten text');
  const blocked = await f.ccw.plan({
    task: 'install',
    selected: [{ id: 'skill:ssre2-design', maintenance: 'update' }],
  });
  assert.equal(blocked.items[0].problem, 'local-edits-preserved');
  const plan = await f.ccw.plan({
    task: 'install',
    selected: [{ id: 'skill:ssre2-design', maintenance: 'update', fields: { replace: 'yes' } }],
  });
  const backup = plan.items[0].changes.find(change => change.code === 'preserved-at').detail;
  assert.equal((await f.ccw.apply(plan.id)).state, 'done');
  assert.equal(await fs.readFile(path.join(backup, 'SKILL.md'), 'utf8'), 'my handwritten text');
  assert.equal(await fs.readFile(path.join(directory, 'reference/details.md'), 'utf8'), 'independent reference bytes');
});

test('替换技能链接：仅修改本端入口', async t => {
  const f = await fixture(t);
  const source = path.join(f.root, 'shared-design');
  await f.write(path.join(source, 'SKILL.md'), 'shared text');
  const entry = path.join(f.claudeRoot, 'skills/ssre2-design');
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.symlink(source, entry, process.platform === 'win32' ? 'junction' : 'dir');
  const item = (await f.ccw.inspect()).items.find(item => item.id === 'skill:ssre2-design');
  assert.ok(item.actions.includes('update'));
  assert.equal(
    (await f.ccw.plan({ task: 'install', selected: [{ id: item.id, maintenance: 'update' }] })).items[0].problem,
    'local-edits-preserved',
  );
  assert.equal(
    (await f.apply({ task: 'install', selected: [{ id: item.id, maintenance: 'update', fields: { replace: 'yes' } }] }))
      .state,
    'done',
  );
  assert.equal((await fs.lstat(entry)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), 'shared text');
});
