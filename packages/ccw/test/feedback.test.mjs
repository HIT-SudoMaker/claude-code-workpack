import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import stringWidth from 'string-width';

import { MESSAGES } from '../dist/messages.js';
import { knownTitle, catalogEntry } from '../dist/management-catalog.js';
import { claudePrograms } from '../dist/claude-program.js';
import { createTestEnvironment, ok } from './test-environment.mjs';
import {
  createRunPresentation,
  contentRow,
  describeChange,
  describeInspection,
  describePlan,
  describeRun,
  reason,
  startupFailure,
} from '../dist/render.js';

test('原因目录使用一份直接文案', () => {
  for (const [code, message] of Object.entries(MESSAGES)) {
    assert.equal(typeof message, 'string', code);
    assert.ok(message.trim().length > 0, code);
  }
  assert.equal(MESSAGES['operation-unconfirmed'], '无法确认操作结果');
  assert.equal(MESSAGES['target-changed'], '目标已变化');
  for (const key of ['constructor', 'toString', '__proto__']) {
    assert.equal(reason(key), '原因未知');
    assert.equal(knownTitle(key, '未知项目'), '未知项目');
  }
  assert.equal(describeChange({ code: 'constructor' }), '原因未知');
  const catalog = { constructor: 'own entry', empty: '' };
  assert.equal(catalogEntry(catalog, 'constructor'), 'own entry');
  assert.equal(catalogEntry(catalog, 'empty'), '');
  assert.equal(catalogEntry(catalog, 'toString'), undefined);
  assert.equal(catalogEntry(catalog, 'missing'), undefined);
});

test('结果文案区分失败、跳过和取消，正常保留不提示', () => {
  const cases = [
    ['done', 'kept', 'keep-user-data', /^完成$/],
    ['failed', 'failed', 'invalid-settings', /^配置失败：配置文件格式无效$/],
    ['skipped', 'skipped', 'dependency-not-ready', /^已跳过：所需程序尚未通过核验/],
    ['cancelled', 'skipped', 'cancelled', /^已停止(?:：.*)?$/],
  ];
  const plan = {
    items: cases.map(([state]) => ({ id: state, title: state, action: 'configure', changes: [], problem: null })),
  };
  const result = {
    state: 'partial',
    items: cases.map(([state, effectState, code]) => ({
      id: state,
      title: state,
      state,
      effects: [{ state: effectState, code }],
    })),
  };
  const view = createRunPresentation(plan, 'install').result(result);
  for (const [index, [, , , expected]] of cases.entries()) assert.match(view.rows[index].status, expected);
  const normal = describeRun(view);
  assert.doesNotMatch(normal, /提示：|代码：|keep-user-data|invalid-settings|dependency-not-ready/);
  const details = describeRun(createRunPresentation(plan, 'install', true).result(result));
  assert.match(details, /invalid-settings/);
  assert.match(details, /dependency-not-ready/);
  assert.doesNotMatch(details, /提示：/);
});

test('检查页按类别显示状态、模型和路径，省略来源与管理说明', () => {
  const inspection = {
    items: [
      {
        id: 'claude',
        title: 'Claude Code',
        kind: 'claude',
        location: '/npm/cli.js',
        canUninstall: true,
        facts: [
          { code: 'program-exists', detail: 'npm' },
          { code: 'program-version', detail: '2.1.311' },
        ],
      },
      ...['/native/claude', '/other/claude'].map(location => ({
        id: location,
        title: 'Claude Code',
        kind: 'claude',
        location,
        facts: [{ code: 'program-exists', detail: 'manual' }, { code: 'external-program-preserved' }],
      })),
      {
        id: 'settings',
        title: '模型配置',
        kind: 'settings',
        location: '/settings.json',
        facts: [{ code: 'api-configured' }],
        values: { model: 'test-model' },
        hasCredential: true,
      },
    ],
    problems: [],
  };
  const text = describeInspection(inspection);
  for (const value of [
    '── 基础配置',
    '/npm/cli.js',
    '/native/claude',
    '/other/claude',
    '2.1.311',
    '仅查看',
    'test-model',
  ])
    assert.ok(text.includes(value), value);
  assert.doesNotMatch(text, /代码：|program-exists|凭据|来源：|管理：/);
});

test('检查页不把缺失入口、未配置状态栏或未知版本写成正常安装', () => {
  const text = describeInspection({
    items: [
      {
        id: 'claude',
        title: 'Claude Code',
        kind: 'claude',
        facts: [
          { code: 'program-missing', detail: 'npm' },
          { code: 'program-version', detail: '2.1.311' },
        ],
      },
      {
        id: 'ccline',
        title: 'CCometixLine',
        kind: 'ccline',
        facts: [{ code: 'program-exists' }, { code: 'not-connected' }],
      },
    ],
    problems: [],
  });
  assert.match(text, /入口缺失/);
  assert.doesNotMatch(text, /版本未确认/);
  assert.match(text, /状态栏：未配置/);
  assert.match(describeInspection({ items: [], problems: [] }), /未发现可展示的项目/);
});

test('检查页对齐模型字段和同组状态，共用插件路径只显示一次', () => {
  const text = describeInspection({
    items: [
      {
        id: 'settings',
        title: '模型配置',
        kind: 'settings',
        facts: [],
        location: '/settings.json',
        values: {
          model: 'model-default',
          fable: 'model-fable',
          opus: 'model-opus',
          sonnet: 'model-sonnet',
          haiku: 'model-haiku',
          language: '中文',
          outputStyle: 'Explanatory',
        },
      },
      ...['GitHub', 'Frontend Design', 'Serena'].map(title => ({
        id: 'plugin:' + title,
        title,
        kind: 'plugin',
        location: '/settings.json',
        facts: [{ code: 'plugin-installed' }],
      })),
    ],
    problems: [],
  });
  const lines = text.split('\n');
  const fields = lines.filter(line => /^ {2}(默认模型|Fable|Opus|Sonnet|Haiku|默认语言|输出风格|路径)/.test(line));
  const modelFields = fields.slice(0, 8);
  assert.equal(modelFields.length, 8);
  assert.match(text, /Fable\s*：model-fable/);
  assert.equal(new Set(modelFields.map(line => stringWidth(line.split('：')[0]))).size, 1);
  const pluginLines = lines.filter(line => /^(GitHub|Frontend Design|Serena)/.test(line));
  assert.equal(pluginLines.length, 3);
  assert.equal(new Set(pluginLines.map(line => stringWidth(line.split('：')[0]))).size, 1);
  const pluginSection = text.slice(text.indexOf('── Plugins'));
  assert.equal(pluginSection.split('/settings.json').length - 1, 1);
  const detailed = describeInspection({
    items: [
      { id: 'plugin:github', title: 'GitHub', kind: 'plugin', location: '/github/settings.json', facts: [] },
      { id: 'plugin:serena', title: 'Serena', kind: 'plugin', location: '/serena/settings.json', facts: [] },
    ],
    problems: [],
  });
  assert.match(detailed, /\/github\/settings.json/);
  assert.match(detailed, /\/serena\/settings.json/);
});

test('选择列表使用简洁且符合对象含义的状态', () => {
  const rows = [
    {
      id: 'ccline',
      title: 'CCometixLine',
      kind: 'ccline',
      facts: [{ code: 'program-exists' }, { code: 'program-version', detail: '2.0.1' }, { code: 'connected' }],
    },
    {
      id: 'plugin:serena@claude-plugins-official',
      title: 'Serena',
      kind: 'plugin',
      facts: [{ code: 'plugin-installed' }],
    },
    { id: 'plugin:serena@claude-plugins-official', title: 'Serena', kind: 'plugin', facts: [] },
  ].map(contentRow);
  assert.deepEqual(
    rows.map(row => row.detail),
    ['已安装', '已安装', '未安装'],
  );
});

test('CCometixLine 的 npm 记录不能代替实际程序入口', async testContext => {
  const workspace = await createTestEnvironment(testContext);
  const ccw = workspace.ccw(
    workspace.machine({
      npm: async () => ok(JSON.stringify({ dependencies: { '@cometix/ccline': { version: '2.0.1' } } })),
    }),
  );
  const item = (await ccw.inspect()).items.find(item => item.id === 'ccline');
  assert.equal(item.canInstall, true);
  assert.equal(item.canUninstall, true);
  assert.ok(item.facts.some(fact => fact.code === 'program-missing'));
  assert.equal(contentRow(item).detail, '程序入口缺失');
});

test('同一 npm 安装的 Windows 启动脚本归入原安装，不接管其他脚本', async testContext => {
  const workspace = await createTestEnvironment(testContext);
  const prefix = path.join(workspace.root, 'npm');
  const npmRoot = path.join(prefix, 'node_modules');
  const binary = path.join(npmRoot, '@anthropic-ai/claude-code/bin/claude.exe');
  await workspace.json(path.join(npmRoot, '@anthropic-ai/claude-code/package.json'), {
    bin: { claude: 'bin/claude.exe' },
  });
  await workspace.write(binary, 'program');
  const relative = 'node_modules/@anthropic-ai/claude-code/bin/claude.exe';
  const scripts = [
    ['claude.cmd', `@echo off\n"%dp0%\\${relative.replaceAll('/', '\\')}" %*`],
    ['claude.ps1', `& "$basedir/${relative}" $args`],
    ['claude', `exec "$basedir/${relative}" "$@"`],
  ];
  for (const [name, source] of scripts) await workspace.write(path.join(prefix, name), source);
  const other = path.join(workspace.root, 'other/claude.cmd');
  await workspace.write(other, `echo "${relative}"`);
  const machine = workspace.machine({
    locate: async () => [...scripts.map(([name]) => path.join(prefix, name)), other],
    npm: async args =>
      args[0] === 'root'
        ? ok(npmRoot)
        : ok(JSON.stringify({ dependencies: { '@anthropic-ai/claude-code': { version: '2.1.311' } } })),
  });
  const found = await claudePrograms({ machine, home: workspace.home, platform: 'win32' });
  assert.equal(found.items.filter(item => item.launcherFor === 'claude').length, 3);
  assert.equal(found.items.find(item => item.location === other).launcherFor, undefined);
  assert.ok(found.items.filter(item => item.launcherFor).every(item => !item.canInstall && !item.canUninstall));
  const summary = describeInspection({ items: found.items, problems: [] });
  assert.equal(summary.match(/^Claude Code：/gm).length, 2);
  assert.doesNotMatch(summary, /启动脚本：/);
  const details = describeInspection({ items: found.items, problems: [] }, true);
  assert.equal(details.match(/Claude Code：npm 启动脚本/g).length, 3);
  await workspace.write(path.join(prefix, 'claude.cmd'), 'echo unrelated');
  const changed = await claudePrograms({ machine, home: workspace.home, platform: 'win32' });
  assert.equal(changed.items.find(item => item.location === path.join(prefix, 'claude.cmd')).launcherFor, undefined);
});

test('检查诊断默认隐藏代码，详细模式包含问题与事实代码', () => {
  const inspection = {
    items: [
      {
        id: 'skill:test',
        title: '测试技能',
        kind: 'skill',
        facts: [{ code: 'entry-exists' }],
        problem: 'invalid-settings',
        location: '/skill-location',
      },
    ],
    problems: [{ code: 'inspection-timeout', detail: '来源检查' }],
  };
  const normal = describeInspection(inspection);
  assert.match(normal, /配置文件格式无效/);
  assert.match(normal, /检查超时：来源检查/);
  assert.doesNotMatch(normal, /代码：|invalid-settings|inspection-timeout|entry-exists/);
  assert.match(normal, /skill-location/);
  const details = describeInspection(inspection, true);
  for (const value of ['invalid-settings', 'inspection-timeout', 'entry-exists', '/skill-location'])
    assert.ok(details.includes(value), value);
});

test('变更与启动文案共用代码显示规则，非法代码不回显', () => {
  for (const render of [
    details => describeChange({ code: 'target-changed', detail: '目标文件' }, details),
    details => startupFailure('target-changed', details),
  ]) {
    assert.match(render(false), /目标已变化/);
    assert.doesNotMatch(render(false), /target-changed|代码：/);
    assert.match(render(true), /target-changed/);
  }
  const text = describeChange({ code: 'private value\u001b[31m' }, true);
  assert.doesNotMatch(text, /private value/);
  assert.equal(text.includes('\u001b'), false);
  assert.match(text, /operation-failed/);
});

test('拒绝目录外抛出码', async () => {
  const catalog = new Set(Object.keys(MESSAGES));
  // 终端视图内部控制流码：被视图自身捕获消化，永不进入用户文案
  const internal = new Set(['terminal-closed', 'terminal-prompt-in-progress']);
  const thrown = new Set();
  const root = new URL('../src/', import.meta.url);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    for (const match of (await fs.readFile(new URL(entry.name, root), 'utf8')).matchAll(
      /(?:new Error\(|(?:code|problem|reason|failure):\s*)'([a-z][a-z-]+)'/g,
    ))
      thrown.add(match[1]);
  }
  assert.deepEqual([...thrown].filter(code => !catalog.has(code) && !internal.has(code)).sort(), []);
});

test('版本只显示于 Claude，检查页不重复列出技能套件数量', () => {
  const programs = ['claude', 'officecli', 'ccline'].map((kind, index) => ({
    id: kind,
    title: kind,
    kind,
    location: '/config/' + kind,
    facts: [
      { code: 'program-exists', detail: 'native' },
      { code: 'program-version', detail: `${index + 2}.1.1` },
    ],
  }));
  const skills = [
    {
      id: 'skill-set:ssre2',
      title: 'SSRE2 套件',
      kind: 'skill',
      facts: [{ code: 'skill-members-present', detail: '2' }],
    },
    {
      id: 'skill:ssre2-design',
      title: 'ssre2-design',
      kind: 'skill',
      location: '/skills/ssre2-design',
      facts: [{ code: 'entry-exists' }],
    },
  ];
  const text = describeInspection({ items: [...programs, ...skills], problems: [] });
  assert.match(text, /claude：已安装 2\.1\.1/);
  assert.match(text, /officecli：已安装\n/);
  assert.match(text, /ccline\s*：已安装\n/);
  assert.match(text, /路径：\/skills\/ssre2-design/);
  assert.doesNotMatch(text, /3\.1\.1|4\.1\.1|SSRE2 套件|已装 2 项|原生安装|版本未确认|管理：/);
});

test('变更预览分组对齐，合并重复配置路径和插件提示', () => {
  const file = 'C:\\Users\\someone\\.claude\\settings.json';
  const plugin = (name, action) => ({
    id: 'plugin:' + name + '@claude-plugins-official',
    title: name,
    action,
    problem: null,
    changes: [
      { code: action === 'update' ? 'plugin-update' : 'plugin-install', detail: name + '@claude-plugins-official' },
      { code: 'new-session-required' },
    ],
  });
  const plan = {
    id: 'preview',
    problem: null,
    items: [
      {
        id: 'claude',
        title: 'Claude Code',
        action: 'update',
        problem: null,
        changes: [
          { code: 'program-update', detail: '2.1.311' },
          { code: 'keep-user-data' },
          { code: 'settings-edit', detail: file },
        ],
      },
      {
        id: 'settings',
        title: '模型配置',
        action: 'configure',
        problem: null,
        changes: [{ code: 'settings-edit', detail: file }],
      },
      plugin('Code Simplifier', 'update'),
      plugin('Frontend Design', 'update'),
      plugin('Context7', 'install'),
    ],
  };
  const text = describePlan(plan);
  assert.match(text, /^共 5 项 · 更新 3 · 配置 1 · 安装 1/);
  assert.ok(text.indexOf('── 基础配置') < text.indexOf('── Plugins'));
  assert.match(text, /更新 +Claude Code +2\.1\.311/);
  assert.match(text, /安装 +Context7/);
  assert.equal(text.split(file).length - 1, 1);
  assert.equal(text.split('新会话或重新加载后生效').length - 1, 1);
  assert.doesNotMatch(text, /原因未知|@claude-plugins-official|保留用户数据|修改设置/);
  const detailed = describePlan(plan, true);
  assert.match(detailed, /更新插件：Code Simplifier@claude-plugins-official/);
  assert.match(detailed, /代码：plugin-update/);
  assert.doesNotMatch(detailed, /原因未知/);
});

test('简洁预览保留不可执行原因、技能替换和移除范围', () => {
  const text = describePlan({
    id: 'scope',
    problem: null,
    items: [
      { id: 'claude', title: 'Claude Code', action: 'uninstall', problem: null, changes: [{ code: 'keep-user-data' }] },
      {
        id: 'skill-set:ssre2',
        title: 'SSRE2',
        action: 'update',
        problem: null,
        changes: [{ code: 'skills-refresh', detail: '2 · repository' }],
      },
      { id: 'plugin:github', title: 'GitHub', action: 'install', problem: 'claude-not-installed', changes: [] },
    ],
  });
  assert.match(text, /不可执行 1/);
  assert.match(text, /GitHub +无法执行：/);
  assert.match(text, /清理此来源的旧技能并重新安装/);
  assert.match(text, /保留会话记录和个人文件/);
});

test('进度和结果的中文名称使用相同宽度，状态列保持对齐', () => {
  const plan = {
    items: ['Claude Code', '模型配置', 'HIT-SudoMaker/SSRE2'].map((title, i) => ({
      id: String(i),
      title,
      action: 'install',
      changes: [],
      problem: null,
    })),
  };
  const view = createRunPresentation(plan).progress();
  const lines = describeRun(view)
    .split('\n')
    .filter(line => line.startsWith('·'));
  const widths = lines.map(line =>
    [...line.slice(0, line.indexOf('等待'))].reduce((sum, c) => sum + (c.charCodeAt(0) > 255 ? 2 : 1), 0),
  );
  assert.equal(new Set(widths).size, 1, lines.join('\n'));
});
