import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createTestEnvironment, exists, ok, revision } from './test-environment.mjs';
import { createSkillsCliFixture } from './skills-cli-fixture.mjs';
import { describeInspection } from '../dist/render.js';
import { createCcw } from '../dist/ccw.js';

async function createSkillsScenario(testContext) {
  const workspace = await createTestEnvironment(testContext);
  const cli = createSkillsCliFixture(workspace);
  const machine = workspace.machine({
    npm: (args, options) => (args[0] === 'exec' ? cli.npm(args, options) : ok('{}')),
    execute: async (file, args) => {
      assert.equal(file, 'git');
      assert.equal(args[0], 'ls-remote');
      return ok(`${revision}\tHEAD\n`);
    },
  });
  const ccw = workspace.ccw(machine);
  const apply = async (selected, task = 'install') => {
    const plan = await ccw.plan({ task, selected: selected.map(id => ({ id })) });
    assert.ok(
      plan.items.every(item => item.problem === null),
      JSON.stringify(plan),
    );
    return ccw.apply(plan.id);
  };
  return { ...workspace, ...cli, machine, ccw, apply, records: path.join(workspace.home, '.ccw/sources.json') };
}

test('Skills CLI 静默全选、拷贝和自定义配置根，保留资源文件', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  assert.equal((await scenario.apply(['skill-set:mattpocock'])).state, 'done');
  assert.deepEqual((await fs.readdir(path.join(scenario.claudeRoot, 'skills'))).sort(), ['code-review', 'tdd']);
  assert.deepEqual(
    await fs.readFile(path.join(scenario.claudeRoot, 'skills/tdd/assets/icon.bin')),
    Buffer.from([0, 128, 255]),
  );
  const add = scenario.calls.find(call => call.kind === 'npm' && call.args.includes('--copy'));
  assert.ok(add.args.includes('*'));
  assert.equal(
    (await scenario.read(scenario.records))[path.join(scenario.claudeRoot, 'skills/tdd')].revision,
    revision,
  );
  assert.equal((await scenario.ccw.inspect()).items.find(item => item.id === 'skill:tdd').canUninstall, true);
});

test('套件状态按实际文件确认，删除后的旧来源记录不代表已安装', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  const empty = await scenario.ccw.inspect();
  assert.match(describeInspection(empty), /Matt Pocock\/Skills\s*：未安装/);
  await scenario.apply(['skill-set:mattpocock']);
  const installed = await scenario.ccw.inspect();
  assert.doesNotMatch(describeInspection(installed), /Matt Pocock\/Skills\s*：/);
  assert.equal(installed.items.find(item => item.id === 'skill-set:mattpocock').canUninstall, true);
  await fs.rm(path.join(scenario.claudeRoot, 'skills'), { recursive: true });
  const removed = await scenario.ccw.inspect();
  const suite = removed.items.find(item => item.id === 'skill-set:mattpocock');
  assert.equal(suite.canUninstall, false);
  assert.deepEqual(suite.facts, [{ code: 'not-installed' }]);
  assert.match(describeInspection(removed), /Matt Pocock\/Skills\s*：未安装/);
});

for (const damage of ['missing', 'empty', 'unreadable'])
  test(`技能状态检查入口文件并隔离单项错误：${damage}`, async testContext => {
    const scenario = await createSkillsScenario(testContext);
    await scenario.apply(['skill-set:mattpocock', 'skill-set:ssre2']);
    const file = path.join(scenario.claudeRoot, 'skills/tdd/SKILL.md');
    if (damage === 'missing') await fs.unlink(file);
    if (damage === 'empty') await scenario.write(file, '  \n');
    const machine = {
      ...scenario.machine,
      read: async target => {
        if (target === file && damage === 'unreadable') throw Object.assign(new Error('fixture'), { code: 'EACCES' });
        return scenario.machine.read(target);
      },
    };
    const view = await createCcw({
      machine,
      home: scenario.home,
      claudeRoot: scenario.claudeRoot,
      cclineRoot: scenario.cclineRoot,
      platform: process.platform,
    }).inspect();
    const broken = view.items.find(item => item.id === 'skill:tdd');
    assert.equal(broken.problem, damage === 'unreadable' ? 'EACCES' : 'skill-entry-missing');
    assert.ok(!broken.facts.some(fact => fact.code === 'entry-exists'));
    assert.ok(
      view.items.find(item => item.id === 'skill:code-review').facts.some(fact => fact.code === 'entry-exists'),
    );
    assert.equal(view.items.find(item => item.id === 'skill-set:ssre2').problem, undefined);
    assert.equal(view.items.find(item => item.id === 'skill-set:mattpocock').problem, broken.problem);
    assert.match(describeInspection(view), /Matt Pocock\/Skills\s*：/);
  });

test('来源更新：清除旧成员和旧文件，保留手写、其他来源及 OfficeCLI', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  await scenario.apply(['skill-set:mattpocock', 'skill-set:ssre2']);
  const root = path.join(scenario.claudeRoot, 'skills');
  await scenario.write(path.join(root, 'manual/SKILL.md'), 'handwritten');
  await scenario.write(path.join(root, 'officecli/SKILL.md'), 'version-matched OfficeCLI');
  const before = await scenario.machine.treeStamp(path.join(root, 'ssre2-design'));
  scenario.state.names.mattpocock = ['tdd', 'new-skill'];
  scenario.state.generation = 'second';
  assert.equal((await scenario.apply(['skill-set:mattpocock'])).state, 'done');
  assert.equal(await exists(path.join(root, 'code-review')), false);
  assert.match(await fs.readFile(path.join(root, 'tdd/SKILL.md'), 'utf8'), /second/);
  assert.equal(await fs.readFile(path.join(root, 'manual/SKILL.md'), 'utf8'), 'handwritten');
  assert.equal(await fs.readFile(path.join(root, 'officecli/SKILL.md'), 'utf8'), 'version-matched OfficeCLI');
  assert.equal(await scenario.machine.treeStamp(path.join(root, 'ssre2-design')), before);
  const records = await scenario.read(scenario.records);
  assert.equal(records[path.join(root, 'code-review')], undefined);
  assert.ok(records[path.join(root, 'new-skill')]);
  assert.equal(await exists(path.join(scenario.home, '.ccw/replaced')), false);
});

test('来源读取失败时，旧技能不先清空', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  await scenario.apply(['skill-set:mattpocock']);
  const before = await scenario.machine.treeStamp(path.join(scenario.claudeRoot, 'skills'));
  scenario.state.failSource = true;
  const plan = await scenario.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  assert.equal(plan.items[0].problem, 'skill-source-unavailable');
  assert.equal(await scenario.machine.treeStamp(path.join(scenario.claudeRoot, 'skills')), before);
});

for (const owned of [false, true])
  test(`保护${owned ? '修改过的 CCW' : '同名手写'}技能`, async testContext => {
    const scenario = await createSkillsScenario(testContext);
    if (owned) await scenario.apply(['skill-set:mattpocock']);
    const file = path.join(scenario.claudeRoot, 'skills/tdd/SKILL.md');
    await scenario.write(file, 'user content');
    const plan = await scenario.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
    assert.equal(plan.items[0].problem, 'local-edits-preserved');
    await scenario.ccw.apply(plan.id);
    assert.equal(await fs.readFile(file, 'utf8'), 'user content');
  });

test('旧链接入口刷新为拷贝，共享目标保持原样', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  const shared = path.join(scenario.home, 'shared/tdd');
  const directory = path.join(scenario.claudeRoot, 'skills/tdd');
  await scenario.write(path.join(shared, 'SKILL.md'), 'shared external content');
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.symlink(shared, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await scenario.json(scenario.records, {
    [directory]: {
      repository: 'https://github.com/mattpocock/skills',
      revision,
      stamp: await scenario.machine.treeStamp(directory),
    },
  });
  assert.equal((await scenario.apply(['skill-set:mattpocock'])).state, 'done');
  assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(path.join(shared, 'SKILL.md'), 'utf8'), 'shared external content');
});

test('CLI 部分失败：报告并记录已完成成员，下次可重新安装', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  scenario.state.failAfter = 1;
  const result = await scenario.apply(['skill-set:mattpocock']);
  assert.equal(result.state, 'partial');
  assert.ok((await scenario.read(scenario.records))[path.join(scenario.claudeRoot, 'skills/tdd')]);
  assert.equal(await exists(path.join(scenario.claudeRoot, 'skills/code-review')), false);
  scenario.state.failAfter = Infinity;
  assert.equal((await scenario.apply(['skill-set:mattpocock'])).state, 'done');
});

test('CLI 移除一部分后失败，保留真实结果并能继续重装', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  await scenario.apply(['skill-set:mattpocock']);
  scenario.state.removeAfter = 1;
  const result = await scenario.apply(['skill-set:mattpocock']);
  assert.equal(result.state, 'partial');
  const effects = result.items[0].effects;
  assert.ok(effects.some(effect => effect.state === 'failed' && effect.code === 'skill-remove-failed'));
  const removed = effects.filter(effect => effect.code === 'skill-removed');
  assert.equal(removed.length, 1);
  const records = await scenario.read(scenario.records);
  assert.equal(records[path.join(scenario.claudeRoot, 'skills', removed[0].detail)], undefined);
  assert.equal(Object.keys(records).length, 1);
  scenario.state.removeAfter = Infinity;
  assert.equal((await scenario.apply(['skill-set:mattpocock'])).state, 'done');
  assert.equal(Object.keys(await scenario.read(scenario.records)).length, 2);
});

test('预览后来源记录或目录改变，执行前拒绝清理', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  await scenario.apply(['skill-set:mattpocock']);
  const file = path.join(scenario.claudeRoot, 'skills/tdd/SKILL.md');
  const plan = await scenario.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  await scenario.write(file, 'changed after preview');
  const beforeCalls = scenario.calls.length;
  assert.equal((await scenario.ccw.apply(plan.id)).state, 'failed');
  assert.equal(await fs.readFile(file, 'utf8'), 'changed after preview');
  assert.equal(
    scenario.calls.slice(beforeCalls).some(call => call.args.includes('--copy')),
    false,
  );
});

test('套件与成员选择重叠时跳过成员，独立设置仍执行', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  await scenario.apply(['skill-set:mattpocock']);
  const plan = await scenario.ccw.plan({
    task: 'install',
    selected: [{ id: 'skill-set:mattpocock' }, { id: 'skill:tdd' }, { id: 'settings', fields: { language: '中文' } }],
  });
  assert.equal(plan.items.find(item => item.id === 'skill:tdd').problem, 'overlapping-selection');
  const result = await scenario.ccw.apply(plan.id);
  assert.equal(result.items.find(item => item.id === 'settings').state, 'done');
});

test('来源元数据不可读时不删除任何技能', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  await scenario.write(scenario.records, '{broken');
  const plan = await scenario.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  assert.equal(plan.items[0].problem, 'source-metadata-unavailable');
  assert.equal(
    scenario.calls.some(call => call.args.includes('--copy')),
    false,
  );
});

test('随包 AMIRC 也委托 Skills CLI；卸载仅移出该入口', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  assert.equal((await scenario.apply(['skill:amirc-research'])).state, 'done');
  const result = await scenario.apply(['skill:amirc-research'], 'uninstall');
  assert.equal(result.state, 'done');
  assert.equal(await exists(path.join(scenario.claudeRoot, 'skills/amirc-research')), false);
});

test('显示名包含空格时使用 CLI 的目录名，别名碰撞在清理前拒绝', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  scenario.state.names.mattpocock = ['Release Notes'];
  assert.equal((await scenario.apply(['skill-set:mattpocock'])).state, 'done');
  assert.ok((await scenario.read(scenario.records))[path.join(scenario.claudeRoot, 'skills/release-notes')]);
  const before = await scenario.machine.treeStamp(path.join(scenario.claudeRoot, 'skills'));
  scenario.state.names.mattpocock = ['A B', 'a-b'];
  const plan = await scenario.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  assert.equal(plan.items[0].problem, 'skill-name-conflict');
  assert.equal(await scenario.machine.treeStamp(path.join(scenario.claudeRoot, 'skills')), before);
});

test('Skills 根目录是共享链接时不交给 CLI 写入', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  const shared = path.join(scenario.home, 'shared-skills');
  await scenario.write(path.join(shared, 'keep'), 'external');
  await fs.mkdir(scenario.claudeRoot, { recursive: true });
  await fs.symlink(shared, path.join(scenario.claudeRoot, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  const plan = await scenario.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  assert.equal(plan.items[0].problem, 'linked-parent');
  assert.equal(
    scenario.calls.some(call => call.args.includes('--copy')),
    false,
  );
  assert.equal(await fs.readFile(path.join(shared, 'keep'), 'utf8'), 'external');
});

test('官方来源的已有共享链接可用 CLI 卸载重装，不修改共享目标', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  const shared = path.join(scenario.home, '.agents/skills/tdd');
  const directory = path.join(scenario.claudeRoot, 'skills/tdd');
  await scenario.write(path.join(shared, 'SKILL.md'), 'original shared content');
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.symlink(shared, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await scenario.json(path.join(scenario.home, '.agents/.skill-lock.json'), {
    version: 3,
    skills: { tdd: { source: 'mattpocock/skills', sourceType: 'github' } },
  });
  const result = await scenario.apply(['skill-set:mattpocock']);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(path.join(shared, 'SKILL.md'), 'utf8'), 'original shared content');
  assert.ok(scenario.calls.some(call => call.kind === 'npm' && call.args.includes('remove')));
});

test('同批 AMIRC 先写共享锁后，两套远程 Skills 仍正常安装和更新', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  const selected = ['skill:amirc-research', 'skill-set:mattpocock', 'skill-set:ssre2'];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await scenario.apply(selected);
    assert.equal(result.state, 'done', JSON.stringify(result));
    assert.ok(result.items.every(item => item.state === 'done'));
  }
});

test('准备后当前技能对应的官方锁来源改变时仍拒绝重装', async testContext => {
  const scenario = await createSkillsScenario(testContext);
  await scenario.apply(['skill-set:mattpocock']);
  const plan = await scenario.ccw.plan({ task: 'install', selected: [{ id: 'skill-set:mattpocock' }] });
  const lockFile = path.join(scenario.home, '.ccw/skills/.skill-lock.json');
  const lock = await scenario.read(lockFile);
  lock.skills.tdd.source = 'different/owner';
  await scenario.json(lockFile, lock);
  const result = await scenario.ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.ok(result.items[0].effects.some(effect => effect.code === 'target-changed'));
});
