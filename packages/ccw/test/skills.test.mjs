import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createCcw } from '../dist/ccw.js';
import { createEnv, exists, ok, revision } from './env.mjs';

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

test('公共计划阻止技能套件与成员更新范围重叠，仍执行独立配置', async t => {
  const f = await fixture(t);
  assert.equal((await f.apply({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] })).state, 'done');
  const directory = path.join(f.claudeRoot, 'skills/tdd');
  const before = await f.machine.treeStamp(directory);
  const plan = await f.ccw.plan({
    task: 'install',
    selected: [
      { id: 'skill-set:mattpocock' },
      { id: 'skill:tdd', maintenance: 'update' },
      { id: 'settings', fields: { language: '中文' } },
    ],
  });
  assert.equal(plan.items.find(item => item.id === 'skill:tdd').problem, 'overlapping-selection');
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.items.find(item => item.id === 'skill:tdd').state, 'failed');
  assert.equal(result.items.find(item => item.id === 'settings').state, 'done');
  assert.equal(await f.machine.treeStamp(directory), before);
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
  await assert.rejects(
    f.ccw.plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] }),
    /unfinished-operation/,
  );
  await f.ccw.abandon(stopped.remaining);
  await f.ccw.plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
  await assert.rejects(f.ccw.plan({ resume: stopped.remaining }), /plan-unavailable/);
});

test('技能套件保留不同成员的所有失败原因', async t => {
  const f = await fixture(t);
  f.state.failReplaceTree = 'code-review';
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  const first = await f.ccw.apply(plan.id);
  await fs.rm(path.join(f.claudeRoot, 'skills/tdd'), { recursive: true });
  const resumed = await f.ccw.plan({ resume: first.remaining });
  const result = await f.ccw.apply(resumed.id);
  assert.ok(result.items[0].effects.some(effect => effect.code === 'target-changed'));
  assert.ok(result.items[0].effects.some(effect => effect.code === 'fixture-write-failed'));
});

test('删除已有技能：阻止旧安装计划', async t => {
  const f = await fixture(t);
  const directory = path.join(f.claudeRoot, 'skills/tdd');
  await f.write(path.join(directory, 'SKILL.md'), 'existing');
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  assert.equal(plan.items[0].problem, null);
  await fs.rm(directory, { recursive: true });
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.state, 'partial');
  assert.equal(result.items[0].effects.at(-1).code, 'target-changed');
  assert.equal(await exists(directory), false);
  assert.equal(await exists(path.join(f.claudeRoot, 'skills/code-review/SKILL.md')), true);
});

test('技能写后短暂读取失败：立即复核且不重复部署', async t => {
  const f = await fixture(t);
  const directory = path.join(f.claudeRoot, 'skills/ssre2-design');
  f.state.failTreeStampOnce = directory;
  const writes = () => f.calls.filter(call => call.kind === 'replaceTree' && call.target === directory).length;
  const first = await f.apply({ task: 'install', selected: [{ id: 'skill:ssre2-design' }] });
  assert.equal(first.state, 'done', JSON.stringify(first));
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

test('安装未收录技能：记录库不可读不以目录查无代替未知', async t => {
  const f = await fixture(t);
  await f.write(path.join(f.home, '.ccw/sources.json'), 'not json');
  const blocked = await f.ccw.plan({ task: 'install', selected: [{ id: 'skill:not-in-any-catalog' }] });
  assert.equal(blocked.items[0].problem, 'source-metadata-unavailable');
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

test('套件入口：干净环境推导未安装状态', async t => {
  const f = await fixture(t);
  const items = (await f.ccw.inspect()).items;
  for (const id of ['skill-set:mattpocock', 'skill-set:ssre2'])
    assert.deepEqual(items.find(item => item.id === id).facts, [{ code: 'not-installed' }], id);
});

test('套件入口：聚合已发现的动态成员', async t => {
  const f = await fixture(t);
  await f.apply({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  const items = (await f.ccw.inspect()).items;
  assert.deepEqual(items.find(item => item.id === 'skill-set:mattpocock').facts, [
    { code: 'skill-members-present', detail: '2' },
  ]);
  assert.deepEqual(items.find(item => item.id === 'skill-set:ssre2').facts, [{ code: 'not-installed' }]);
});

test('套件入口：登记成员显示已装比例', async t => {
  const f = await fixture(t);
  await f.apply({ task: 'install', selected: [{ id: 'skill:ssre2-design' }] });
  assert.deepEqual((await f.ccw.inspect()).items.find(item => item.id === 'skill-set:ssre2').facts, [
    { code: 'skill-members-present', detail: '1/2' },
  ]);
});

test('套件成员凭来源记录获得更新资格', async t => {
  const f = await fixture(t);
  await f.apply({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  const member = (await f.ccw.inspect()).items.find(item => item.id === 'skill:tdd');
  assert.equal(member.skillSet, 'mattpocock');
  assert.ok(member.actions.includes('update'));
  assert.equal(
    (await f.apply({ task: 'install', selected: [{ id: 'skill:tdd', maintenance: 'update' }] })).state,
    'done',
  );
});

test('解除技能：清除过期来源记录，同路径新内容不再误归属', async t => {
  const f = await fixture(t);
  await f.apply({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  const directory = path.join(f.claudeRoot, 'skills/tdd');
  const records = path.join(f.home, '.ccw/sources.json');
  assert.ok(Object.hasOwn(await f.readJson(records), directory));
  await f.apply({ task: 'uninstall', selected: [{ id: 'skill:tdd' }] });
  assert.equal((await f.readJson(records))[directory], undefined);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), '---\nname: tdd\n---\nforeign copy\n');
  const foreign = (await f.ccw.inspect()).items.find(item => item.id === 'skill:tdd');
  assert.equal(foreign.skillSet, undefined);
  assert.ok(!foreign.actions.includes('update'));
});

test('解除技能：来源记录不可读时降级提示', async t => {
  const f = await fixture(t);
  await f.apply({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  await fs.writeFile(path.join(f.home, '.ccw/sources.json'), '{broken json');
  const result = await f.apply({ task: 'uninstall', selected: [{ id: 'skill:tdd' }] });
  assert.equal(result.state, 'done');
  assert.ok(
    result.items[0].effects.some(effect => effect.state === 'kept' && effect.code === 'source-metadata-unavailable'),
  );
});
