import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';

import { ERROR_MESSAGES } from '../dist/errors.js';
import { describeRun } from '../dist/run-presentation.js';
import { HOME_TITLE, TEXT } from '../dist/render.js';
import { runTerminal } from '../dist/terminal.js';
import { WARNING_MESSAGES } from '../dist/warnings.js';

const wait = (_title, work) => work(new AbortController().signal);

test('拒绝目录外抛出码', async () => {
  const catalog = new Set([...Object.keys(ERROR_MESSAGES), ...Object.keys(WARNING_MESSAGES), ...Object.keys(TEXT)]);
  // 终端视图内部控制流码：被视图自身捕获消化，永不进入用户文案
  const internal = new Set(['terminal-closed', 'terminal-prompt-in-progress']);
  const thrown = new Set();
  const root = new URL('../src/', import.meta.url);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    for (const match of (await fs.readFile(new URL(entry.name, root), 'utf8')).matchAll(
      /new Error\('([a-z][a-z-]+)'\)/g,
    ))
      thrown.add(match[1]);
  }
  assert.deepEqual([...thrown].filter(code => !catalog.has(code) && !internal.has(code)).sort(), []);
});

test('拒绝文案目录重复码', () => {
  const codes = [...Object.keys(ERROR_MESSAGES), ...Object.keys(WARNING_MESSAGES), ...Object.keys(TEXT)];
  assert.equal(new Set(codes).size, codes.length);
});

test('限制诊断简报长度', () => {
  for (const [code, message] of [
    ...Object.entries(ERROR_MESSAGES),
    ...Object.entries(WARNING_MESSAGES),
    ...Object.entries(TEXT),
  ]) {
    assert.ok(Array.from(message.brief).length <= 10, code);
    assert.ok(message.detail.length > 0, code);
  }
});

test('钉文案目录边界键', () => {
  assert.equal(WARNING_MESSAGES['office-local-skill-kept'], undefined);
  assert.equal(ERROR_MESSAGES['local-edits-preserved'].brief, '替换未执行');
});

test('浏览结果详情：保留续办和选择', async () => {
  const items = [
    { id: 'claude', title: 'Claude Code', kind: 'claude', facts: [], actions: ['install'], canInstall: true },
    { id: 'mcp:context7', title: 'Context7', kind: 'mcp', facts: [], actions: ['install'], canInstall: true },
  ];
  const requests = [];
  let homes = 0;
  let inspections = 0;
  let applications = 0;
  let selections = 0;
  let resultVisits = 0;
  let detailSelections = 0;
  let details = 0;
  await runTerminal(
    {
      async inspect() {
        inspections++;
        return { items, problems: [] };
      },
      async plan(request) {
        requests.push(request);
        return {
          id: requests.length === 1 ? 'initial' : 'resumed',
          problem: null,
          items: items.map(item => ({ id: item.id, title: item.title, action: 'install', changes: [], problem: null })),
        };
      },
      async apply(id) {
        applications++;
        assert.equal(id, applications === 1 ? 'initial' : 'resumed');
        return applications === 1
          ? {
              state: 'partial',
              remaining: 'frozen-remaining',
              items: [
                {
                  ...items[0],
                  state: 'partial',
                  isPending: true,
                  effects: [
                    { state: 'done', code: 'program-file-ready' },
                    { state: 'failed', code: 'settings-changed' },
                  ],
                },
                {
                  ...items[1],
                  state: 'failed',
                  isPending: true,
                  effects: [{ state: 'failed', code: 'source-timeout' }],
                },
              ],
            }
          : { state: 'done', items: items.map(item => ({ ...item, state: 'done', effects: [], isPending: false })) };
      },
    },
    {
      wait,
      show() {},
      async select(page, change, focus) {
        selections++;
        if (selections === 1) change({ kind: 'all' });
        else {
          assert.ok(page.rows.every(row => row.checked));
          assert.equal(focus, 0);
        }
        return { kind: 'submit', index: 0 };
      },
      async choose(title, choices, focus, cancelIndex) {
        if (title === HOME_TITLE) return homes++ ? 4 : 0;
        if (title === '选择结果') {
          assert.deepEqual([inspections, requests.length, applications], [1, 1, 1]);
          return detailSelections++;
        }
        if (typeof title !== 'string' && title.title === '结果详情') {
          assert.deepEqual([inspections, requests.length, applications], [1, 1, 1]);
          assert.equal(title.rows.length, 1);
          const text = describeRun(title);
          assert.match(text, /本次仍有可续办任务/);
          if (details++ === 0) {
            assert.match(text, /代码：program-file-ready/);
            assert.match(text, /代码：settings-changed/);
            assert.doesNotMatch(text, /source-timeout/);
          } else {
            assert.match(text, /代码：source-timeout/);
            assert.doesNotMatch(text, /settings-changed/);
          }
          return 0;
        }
        assert.equal(typeof title, 'object');
        assert.ok(title.rows.every(row => row.details.length === 0));
        assert.equal(cancelIndex, 1);
        assert.deepEqual(choices, [applications === 1 ? '重试未完成项' : '返回列表', '返回主菜单', '查看详情']);
        if (applications === 2) return 1;
        assert.equal(focus, resultVisits === 0 ? 1 : 2);
        return resultVisits++ < 2 ? 2 : 0;
      },
    },
  );
  assert.equal(details, 2);
  assert.equal(applications, 2);
  assert.deepEqual(requests, [
    { task: 'install', selected: [{ id: 'claude' }, { id: 'mcp:context7' }] },
    { resume: 'frozen-remaining' },
  ]);
});

test('浏览准备失败详情：保留问题行焦点', async () => {
  const item = {
    id: 'officecli',
    title: 'OfficeCLI',
    kind: 'officecli',
    facts: [],
    actions: ['install'],
    canInstall: true,
  };
  let homes = 0;
  let pages = 0;
  let briefVisits = 0;
  let inspections = 0;
  let plans = 0;
  let details = 0;
  await runTerminal(
    {
      async inspect() {
        inspections++;
        return { items: [item], problems: [] };
      },
      async plan() {
        plans++;
        return {
          id: 'blocked',
          problem: null,
          items: [
            {
              id: item.id,
              title: item.title,
              action: 'install',
              changes: [],
              problem: 'installation-state-unconfirmed',
            },
          ],
        };
      },
      async apply() {
        assert.fail('阻断的安装不能执行');
      },
    },
    {
      wait,
      async select(page, change, focus) {
        pages++;
        if (pages === 1) {
          change({ kind: 'toggle', index: 0 });
          return { kind: 'submit', index: 0 };
        }
        assert.equal(focus, 0);
        assert.ok(page.rows[0].checked);
        assert.equal(page.rows[0].detail, '安装失败');
        assert.equal(page.rows[0].enter, 'open');
        return { kind: pages === 2 ? 'open' : 'cancel', index: 0 };
      },
      async choose(title, choices, focus, cancelIndex) {
        if (title === HOME_TITLE) return homes++ ? 4 : 0;
        assert.deepEqual([inspections, plans], [1, 1]);
        if (choices.length === 1) {
          details++;
          assert.match(title, /代码：installation-state-unconfirmed/);
          return 0;
        }
        assert.equal(title, 'OfficeCLI\n安装失败');
        assert.deepEqual(choices, ['取消选择', '返回', '查看详情']);
        assert.equal(cancelIndex, 1);
        assert.equal(focus, briefVisits === 0 ? 1 : 2);
        return briefVisits++ === 0 ? 2 : 1;
      },
    },
  );
  assert.equal(details, 1);
  assert.deepEqual([inspections, plans], [1, 1]);
});

test('浏览未知对象：不新增安装资格', async () => {
  const item = {
    id: 'claude',
    title: 'Claude Code',
    kind: 'claude',
    facts: [],
    actions: [],
    problem: 'inspection-timeout',
  };
  let homes = 0;
  let lists = 0;
  let briefs = 0;
  let inspections = 0;
  await runTerminal(
    {
      async inspect() {
        inspections++;
        return { items: [item], problems: [] };
      },
      async plan() {
        assert.fail('只读详情不能准备变更');
      },
      async apply() {
        assert.fail('只读详情不能执行变更');
      },
    },
    {
      wait,
      async choose(title, choices) {
        if (title === HOME_TITLE) return homes++ ? 4 : 1;
        if (title.startsWith('检查套件')) {
          assert.equal(choices[0].detail, '待确认');
          return lists++ === 0 ? 0 : 2;
        }
        if (choices.length === 1) {
          assert.match(title, /代码：inspection-timeout/);
          return 0;
        }
        assert.equal(title, 'Claude Code\n待确认');
        assert.deepEqual(choices, ['返回', '查看详情']);
        return briefs++ === 0 ? 1 : 0;
      },
    },
  );
  assert.equal(inspections, 1);
});

test('就地校验连接字段', async () => {
  const item = {
    id: 'settings',
    title: '模型配置',
    kind: 'settings',
    facts: [],
    actions: ['configure'],
    canInstall: true,
  };
  let homes = 0;
  let pages = 0;
  let forms = 0;
  await runTerminal(
    {
      async inspect() {
        return { items: [item], problems: [] };
      },
      async plan() {
        assert.fail('无效字段不能提交');
      },
    },
    {
      wait,
      async select() {
        return { kind: pages++ === 0 ? 'open' : 'cancel', index: 0 };
      },
      async choose(title) {
        if (title === HOME_TITLE) return homes++ ? 4 : 0;
        assert.equal(title, '模型配置');
        return 1;
      },
      async form(_title, fields, validate) {
        forms++;
        assert.equal(fields.find(field => field.key === 'secret').secret, true);
        for (const [values, message, field] of [
          [{ baseUrl: '', secret: '' }, '请补全连接项', 'baseUrl'],
          [{ baseUrl: '', secret: 'private-value' }, '请填写地址', 'baseUrl'],
          [{ baseUrl: 'ftp://example.test', secret: 'private-value' }, '地址无效', 'baseUrl'],
          [{ baseUrl: 'https://example.test', secret: '' }, '请填写密钥', 'secret'],
        ]) {
          const problem = validate(values);
          assert.equal(problem.message, message);
          assert.equal(problem.field, field);
          assert.doesNotMatch(problem.detail, /private-value/);
          if (message === '地址无效') assert.match(problem.detail, /HTTP 或 HTTPS/);
        }
        return null;
      },
    },
  );
  assert.equal(forms, 1);
});
