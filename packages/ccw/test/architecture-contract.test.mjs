import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createTestEnvironment, ok, npmConfig, revision } from './test-environment.mjs';
import { runTerminal } from '../dist/terminal.js';
import { HOME_TITLE, createRunPresentation } from '../dist/render.js';
import { createSkillsCliFixture } from './skills-cli-fixture.mjs';

// 检查凭据与运行进度
for (const [env, hasCredential, auth] of [
  [{ ANTHROPIC_BASE_URL: 'https://gateway.example.test' }, false, 'key'],
  [{ ANTHROPIC_API_KEY: '' }, false, 'key'],
  [{ ANTHROPIC_API_KEY: 'key', ANTHROPIC_AUTH_TOKEN: '  ' }, true, 'key'],
  [{ ANTHROPIC_AUTH_TOKEN: 'token' }, true, 'token'],
])
  test('凭据状态独立于 API 配置：' + JSON.stringify(env), async testContext => {
    const workspace = await createTestEnvironment(testContext, { seed: { settings: { env } } });
    const item = (await workspace.ccw(workspace.machine({ npm: async () => ok('{}') })).inspect()).items.find(
      item => item.id === 'settings',
    );
    assert.equal(item.hasCredential, hasCredential);
    assert.equal(item.values.auth, auth);
  });

test('下一项开始前，已核对项目不再显示执行中', async testContext => {
  const workspace = await createTestEnvironment(testContext, {
    seed: {
      settings: { enabledPlugins: { 'github@claude-plugins-official': true, 'serena@claude-plugins-official': true } },
    },
  });
  const ccw = workspace.ccw(workspace.machine());
  const plan = await ccw.plan({
    task: 'uninstall',
    selected: [{ id: 'plugin:github@claude-plugins-official' }, { id: 'plugin:serena@claude-plugins-official' }],
  });
  const presentation = createRunPresentation(plan);
  let duringSecond;
  const result = await ccw.apply(plan.id, undefined, event => {
    const view = presentation.progress(event);
    if (event.kind === 'started' && event.id === 'plugin:serena@claude-plugins-official') duringSecond = view;
  });
  assert.equal(result.state, 'done');
  assert.equal(duringSecond.rows[0].status, '完成');
  assert.equal(duringSecond.rows[1].status, '执行中');
  assert.match(duringSecond.summary, /处理 1\/2.*完成 1/);
});

// 输入与来源变化的保护
test('没有有效凭据时，表单立即拒绝空 API Key', async () => {
  let homes = 0,
    selections = 0;
  const item = {
    id: 'settings',
    title: '模型配置',
    kind: 'settings',
    canInstall: true,
    hasCredential: false,
    values: { baseUrl: 'https://gateway.example.test' },
    facts: [{ code: 'api-configured' }],
  };
  await runTerminal(
    {
      inspect: async () => ({ items: [item], problems: [] }),
      plan: async () => {
        throw new Error('invalid draft reached planner');
      },
    },
    {
      wait: (_title, work) => work(new AbortController().signal),
      choose: async title => (title === HOME_TITLE ? (homes++ === 0 ? 0 : 4) : 1),
      select: async (_page, change) => {
        if (selections++) return 'cancel';
        change({ kind: 'toggle', index: 0 });
        return 'submit';
      },
      form: async (_title, fields, validate) => {
        const problem = validate(Object.fromEntries(fields.map(field => [field.key, field.value])));
        assert.equal(problem.field, 'secret');
        return null;
      },
    },
  );
});

test('首次安装 Skill：预览后来源记录漂移时不写入文件', async testContext => {
  const workspace = await createTestEnvironment(testContext);
  const directory = path.join(workspace.claudeRoot, 'skills/ssre2-design');
  const sources = path.join(workspace.home, '.ccw/sources.json');
  const cli = createSkillsCliFixture(workspace);
  const base = workspace.machine({ execute: async () => ok(revision), npm: cli.npm });
  const ccw = workspace.ccw(base);
  const plan = await ccw.plan({ task: 'install', selected: [{ id: 'skill:ssre2-design' }] });
  assert.equal(plan.items[0].problem, null);
  const foreign = { repository: 'https://example.test/foreign', revision: 'foreign', stamp: 'foreign' };
  await workspace.json(sources, { [directory]: foreign });
  const result = await ccw.apply(plan.id);
  assert.equal(result.state, 'failed');
  assert.equal(
    workspace.calls.some(call => call.kind === 'npm' && call.args.includes('--copy')),
    false,
  );
  assert.equal(await base.treeStamp(directory), null);
  assert.deepEqual((await workspace.read(sources))[directory], foreign);
});

for (const replacement of ['discovery', 'content'])
  test(`插件绑定预览时的 Claude：${replacement}`, async testContext => {
    const workspace = await createTestEnvironment(testContext, { seed: { settings: {}, state: {} } });
    const first = path.join(workspace.home, 'first/claude.exe');
    const second = path.join(workspace.home, 'second/claude.exe');
    await workspace.write(first, 'first executable');
    await workspace.write(second, 'second executable');
    await workspace.json(path.join(workspace.claudeRoot, 'plugins/known_marketplaces.json'), {
      'claude-plugins-official': { source: { repo: 'anthropics/claude-plugins-official' } },
    });
    let executable = first;
    const invoked = [];
    const plugin = 'github@claude-plugins-official';
    const ccw = workspace.ccw(
      workspace.machine({
        npm: async () => ok('{}'),
        locate: async name => (name === 'claude' ? [executable] : []),
        execute: async (binary, args) => {
          invoked.push(binary);
          assert.deepEqual(args, ['plugin', 'install', plugin, '--scope', 'user']);
          const installPath = path.join(workspace.claudeRoot, 'plugins/cache/github');
          await workspace.write(path.join(installPath, '.claude-plugin/plugin.json'), '{}');
          await workspace.json(path.join(workspace.claudeRoot, 'plugins/installed_plugins.json'), {
            plugins: { [plugin]: [{ scope: 'user', installPath }] },
          });
          await workspace.json(workspace.settingsFile, { enabledPlugins: { [plugin]: true } });
          return ok();
        },
      }),
    );
    const title = (await ccw.inspect()).items.find(item => item.id === 'plugin:' + plugin).title;
    const plan = await ccw.plan({ task: 'install', selected: [{ id: 'plugin:' + plugin }] });
    assert.equal(plan.items[0].problem, null);
    assert.equal(plan.items[0].title, title);
    if (replacement === 'discovery') executable = second;
    else await workspace.write(first, 'changed executable');
    const result = await ccw.apply(plan.id);
    assert.deepEqual(invoked, replacement === 'discovery' ? [first] : []);
    assert.equal(result.state, replacement === 'discovery' ? 'done' : 'failed');
  });

// 已发生效果的确认与取消
for (const { title, task = 'install', cancelled = false, receipt = 'returned', capture = 'normal', problem } of [
  { title: 'npm 安装完成后取消：仍核验程序且不继续配置', cancelled: true },
  { title: 'npm 安装丢失回执：仍按版本和捕获的入口确认完成', receipt: 'lost' },
  { title: 'npm 卸载丢失回执：仍按版本和入口缺失确认完成', task: 'uninstall', receipt: 'lost' },
  {
    title: 'npm 首次入口捕获失败：后续读取成功仍不确认安装',
    capture: 'failed',
    problem: 'program-installation-unconfirmed',
  },
  { title: 'npm 捕获后入口变化：拒绝使用新身份完成安装', capture: 'changed', problem: 'program-changed' },
])
  test(title, async testContext => {
    const workspace = await createTestEnvironment(testContext);
    const abort = new AbortController();
    const root = path.join(workspace.home, 'npm/node_modules');
    const name = '@anthropic-ai/claude-code';
    const binary = path.join(root, name, 'cli.js');
    let version = task === 'uninstall' ? '2.1.318' : null;
    let dispatched = false;
    let fingerprintReads = 0;
    if (version !== null) {
      await workspace.json(path.join(root, name, 'package.json'), { name, version, bin: { claude: 'cli.js' } });
      await workspace.write(binary, 'installed binary');
    }
    const base = workspace.machine({
      processes: async () => [],
      npm: async args => {
        if (args[0] === 'root') return ok(root);
        if (args[0] === 'ls') return ok(JSON.stringify({ dependencies: version ? { [name]: { version } } : {} }));
        if (args[0] === 'config') return npmConfig(args);
        if (args[0] === 'view') return ok(JSON.stringify('2.1.318'));
        assert.equal(args[0], task);
        if (task === 'uninstall') {
          version = null;
          await fs.unlink(binary);
        } else {
          version = '2.1.318';
          await workspace.json(path.join(root, name, 'package.json'), { name, version, bin: { claude: 'cli.js' } });
          await workspace.write(binary, 'installed binary');
        }
        dispatched = true;
        if (cancelled) abort.abort();
        if (receipt === 'lost') throw new Error('lost-receipt');
        return ok();
      },
      execute: async () => ok('2.1.318 (Claude Code)'),
    });
    const machine = {
      ...base,
      npmIdentity: async () => ({ entry: 'fixed-npm', binary: 'fixed-node', stamp: 'fixed-stamp' }),
      async fingerprint(file, signal) {
        const stamp = await base.fingerprint(file, signal);
        if (dispatched && file === binary) {
          fingerprintReads++;
          if (fingerprintReads === 1) {
            if (capture === 'failed') throw new Error('fingerprint-unavailable');
            if (capture === 'changed') await workspace.write(binary, 'changed binary');
          }
        }
        return stamp;
      },
    };
    const ccw = workspace.ccw(machine);
    const plan = await ccw.plan({ task, selected: [{ id: 'claude' }] });
    assert.equal(plan.items[0].problem, null);
    const result = await ccw.apply(plan.id, abort.signal);
    assert.equal(
      await machine.read(binary),
      task === 'uninstall' ? null : capture === 'changed' ? 'changed binary' : 'installed binary',
    );
    assert.equal(result.state, problem ? 'failed' : cancelled ? 'cancelled' : 'done');
    assert.equal(result.items[0].state, problem ? 'failed' : cancelled ? 'partial' : 'done');
    if (problem) {
      assert.ok(result.items[0].effects.some(effect => effect.code === problem && effect.state === 'failed'));
      assert.ok(!result.items[0].effects.some(effect => effect.code === 'program-ready' && effect.state === 'done'));
      assert.equal(workspace.calls.filter(call => call.kind === 'execute').length, 0);
      assert.ok(fingerprintReads >= 2);
    } else {
      const code = task === 'uninstall' ? 'program-removed' : 'program-ready';
      assert.ok(result.items[0].effects.some(effect => effect.code === code && effect.state === 'done'));
      assert.ok(!result.items[0].effects.some(effect => effect.state === 'failed'));
    }
    if (cancelled || problem) assert.equal(await machine.read(workspace.settingsFile), null);
    assert.equal(workspace.calls.filter(call => call.kind === 'npm' && call.args[0] === task).length, 1);
  });
