import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOME_TITLE } from '../dist/render.js';
import { runTerminal } from './terminal-test.mjs';
import { isIgnoredText } from '../dist/terminal-view.js';
import { wait } from './env.mjs';

const item = {
  id: 'ccline',
  title: 'CCometixLine',
  kind: 'ccline',
  canInstall: true,
  facts: [{ code: 'not-installed' }],
  actions: ['install'],
};

test('浏览检查详情：复用快照', async () => {
  let inspections = 0;
  let homes = 0;
  let lists = 0;
  let details = 0;
  let summaryVisits = 0;
  const ccw = {
    async inspect() {
      inspections++;
      return { items: [item], problems: [] };
    },
  };
  const terminal = {
    wait,
    async choose(title, choices, _focus, cancelIndex) {
      if (title === HOME_TITLE) return homes++ ? 4 : 1;
      assert.equal(inspections, 1);
      if (title.startsWith('检查套件')) return lists++ < 2 ? 0 : 2;
      if (choices.length === 1) {
        assert.match(title, /代码：not-installed/);
        details++;
        return 0;
      }
      assert.deepEqual(choices, ['进入安装', '返回', '查看详情']);
      assert.equal(cancelIndex, 1);
      return summaryVisits++ % 2 === 0 ? 2 : 1;
    },
    show() {},
  };
  await runTerminal(ccw, terminal);
  assert.equal(inspections, 1, '浏览两次详情不应触发三次完整检查');
  assert.equal(details, 2);
});

test('开始检查：立即显示等待', async () => {
  const inspection = Promise.withResolvers();
  const events = [];
  const choices = [1, 2, 4];
  const terminal = {
    wait(title, work) {
      events.push(title);
      return wait(title, work);
    },
    async choose(title) {
      events.push(title);
      assert.ok(choices.length);
      return choices.shift();
    },
    show(text) {
      events.push(text);
    },
  };
  const running = runTerminal(
    {
      inspect() {
        return inspection.promise;
      },
    },
    terminal,
  );
  await new Promise(resolve => setImmediate(resolve));
  const hasFeedback = events.some(text => /检查环境/.test(text));
  inspection.resolve({ items: [item], problems: [] });
  await running;
  assert.equal(hasFeedback, true, '慢探测期间必须立即给出等待反馈');
});

test('刷新或重进检查：读取新状态', async () => {
  let inspections = 0;
  const choices = [1, 1, 2, 1, 2, 4];
  await runTerminal(
    {
      async inspect() {
        inspections++;
        return { items: [item], problems: [] };
      },
    },
    {
      wait,
      async choose() {
        assert.ok(choices.length);
        return choices.shift();
      },
      show() {},
    },
  );
  assert.equal(inspections, 3);
});

test('完成变更：重新检查状态', async () => {
  let inspections = 0;
  let selects = 0;
  const choices = [0, 0, 4];
  await runTerminal(
    {
      async inspect() {
        inspections++;
        return { items: [item], problems: [] };
      },
      async plan() {
        return { id: 'plan', items: [], problem: null };
      },
      async apply() {
        return { state: 'done', items: [] };
      },
    },
    {
      wait,
      handoff: work => work(),
      show() {},
      async choose() {
        assert.ok(choices.length);
        return choices.shift();
      },
      async select(_page, change) {
        if (selects++ === 0) {
          change({ kind: 'toggle', index: 0 });
          return { kind: 'submit', index: 1 };
        }
        return { kind: 'cancel', index: 0 };
      },
    },
  );
  assert.equal(inspections, 2);
});

test('检查技能：只显示实际成员', async () => {
  let homes = 0;
  let lists = 0;
  const member = {
    id: 'skill:ssre2-design',
    title: 'ssre2-design',
    kind: 'skill',
    skillSet: 'ssre2',
    facts: [{ code: 'shared-link' }],
    actions: ['update', 'detach'],
  };
  const review = {
    ...member,
    id: 'skill:ssre2-review',
    name: 'ssre2-review',
    title: 'ssre2-review',
    facts: [{ code: 'entry-exists' }],
  };
  const missing = {
    ...member,
    id: 'skill:missing',
    name: 'missing',
    title: 'missing',
    facts: [{ code: 'not-installed' }],
    actions: ['install'],
  };
  const bundle = {
    id: 'skill-set:ssre2',
    title: 'HIT-SudoMaker/SSRE2',
    kind: 'skill',
    canInstall: true,
    facts: [],
    actions: ['install'],
  };
  await runTerminal(
    {
      async inspect() {
        return { items: [member, review, missing, bundle], problems: [] };
      },
    },
    {
      wait,
      show() {},
      handoff: work => work(),
      async choose(title, choices) {
        if (title === HOME_TITLE) return [1, 0, 4][homes++];
        if (title.startsWith('检查套件')) {
          assert.deepEqual(choices, [
            { label: 'ssre2-design', detail: '已安装', group: 'Skills' },
            { label: 'ssre2-review', detail: '已安装', group: 'Skills' },
            '刷新检查',
            '返回主菜单',
          ]);
          return lists++ ? 3 : 0;
        }
        assert.ok(title.startsWith('ssre2-design'));
        assert.deepEqual(choices, ['进入更新', '进入卸载', '返回', '查看详情']);
        return 2;
      },
      async select(page) {
        assert.equal(page.rows.length, 1);
        assert.equal(page.rows[0].label.trim(), 'HIT-SudoMaker/SSRE2');
        return { kind: 'cancel', index: 0 };
      },
    },
  );
});

test('程序缺少接入：显示待接入', async () => {
  let homes = 0;
  const partial = {
    ...item,
    facts: [
      { code: 'program-exists', detail: 'npm' },
      { code: 'program-version', detail: '2.0.1' },
      { code: 'not-connected' },
    ],
  };
  await runTerminal(
    {
      async inspect() {
        return { items: [partial], problems: [] };
      },
    },
    {
      wait,
      async choose(title, choices) {
        if (title === HOME_TITLE) return homes++ ? 4 : 1;
        assert.deepEqual(choices[0], { label: 'CCometixLine', detail: '待接入 2.0.1', group: '附加工具' });
        return 2;
      },
    },
  );
});

test('检查项无操作：仅提供只读去向', async () => {
  let homes = 0;
  let lists = 0;
  await runTerminal(
    {
      async inspect() {
        return { items: [{ ...item, canInstall: false, actions: [] }], problems: [] };
      },
    },
    {
      wait,
      async choose(title, choices) {
        if (title === HOME_TITLE) return homes++ ? 4 : 1;
        if (title.startsWith('检查套件')) return lists++ ? 2 : 0;
        assert.deepEqual(choices, ['返回', '查看详情']);
        return 0;
      },
    },
  );
});

test('清理数据：空选择不确认', async () => {
  let homes = 0;
  let selects = 0;
  let plans = 0;
  const cleanup = { id: 'data:cache', title: '缓存', kind: 'data', facts: [], actions: ['clean'] };
  await runTerminal(
    {
      async inspect() {
        return { items: [cleanup], problems: [] };
      },
      async plan(input) {
        plans++;
        assert.deepEqual(input, { task: 'clean', selected: [{ id: cleanup.id }] });
        return {
          id: 'cleanup',
          problem: null,
          items: [{ id: cleanup.id, title: cleanup.title, action: 'clean', changes: [], problem: null }],
        };
      },
      async apply() {
        assert.fail('取消预览不能执行清理');
      },
    },
    {
      wait,
      show() {},
      async select(page, change) {
        assert.equal(page.rows[0].enter, 'toggle');
        if (selects++ === 0) return { kind: 'submit', index: 1 };
        if (selects === 2) {
          assert.equal(plans, 0);
          change({ kind: 'toggle', index: 0 });
          return { kind: 'submit', index: 1 };
        }
        return { kind: 'cancel', index: 0 };
      },
      async choose(title, choices, focus) {
        if (title === HOME_TITLE) return homes++ ? 4 : 3;
        assert.match(title, /^变更预览/);
        assert.deepEqual(choices, ['确认清理', '返回修改']);
        assert.equal(focus, 1);
        return 1;
      },
    },
  );
  assert.equal(plans, 1);
});

test('成员更新与套件整装冲突：展示核心计划结果', async () => {
  const member = {
    id: 'skill:tdd',
    title: 'tdd',
    kind: 'skill',
    skillSet: 'mattpocock',
    actions: ['update', 'detach'],
    facts: [{ code: 'entry-exists' }],
  };
  const suite = {
    id: 'skill-set:mattpocock',
    title: 'Matt Pocock/Skills',
    kind: 'skill',
    canInstall: true,
    actions: ['install'],
    facts: [{ code: 'skill-members-present', detail: '2' }],
  };
  let homes = 0;
  let selections = 0;
  let planned = 0;
  await runTerminal(
    {
      async inspect() {
        return { items: [member, suite], problems: [] };
      },
      async plan(request) {
        planned++;
        assert.deepEqual(request.selected, [{ id: member.id, maintenance: 'update' }, { id: suite.id }]);
        return {
          id: 'conflict',
          problem: null,
          items: [
            { id: member.id, title: member.title, action: 'update', problem: 'overlapping-selection', changes: [] },
          ],
        };
      },
    },
    {
      wait,
      show() {},
      handoff: work => work(),
      async choose(title, choices) {
        if (title === HOME_TITLE) return [1, 4][homes++];
        if (title.startsWith('检查套件')) {
          assert.deepEqual(choices, [{ label: 'tdd', detail: '已安装', group: 'Skills' }, '刷新检查', '返回主菜单']);
          return 0;
        }
        assert.ok(title.startsWith('tdd'), String(title));
        assert.deepEqual(choices, ['进入更新', '进入卸载', '返回', '查看详情']);
        return 0;
      },
      async select(page, change) {
        if (selections++ === 0) {
          assert.equal(page.rows.length, 2);
          assert.deepEqual(page.rows[0], {
            label: 'tdd',
            detail: '已安装 · 已选更新',
            group: 'Skills',
            checked: true,
            enter: 'toggle',
          });
          assert.equal(page.rows[1].detail, '已装 2 项');
          const afterAll = change({ kind: 'all' });
          assert.equal(afterAll.rows[0].checked, true, '全选不得降级更新勾选');
          assert.equal(afterAll.rows[0].detail, '已安装 · 已选更新');
          assert.equal(afterAll.rows[1].checked, true);
          return { kind: 'submit', index: 2 };
        }
        assert.match(page.title, /! 安装失败/, page.title);
        assert.equal(page.rows[0].detail, '安装失败 · 已选更新');
        assert.equal(page.rows[0].enter, 'open');
        return { kind: 'cancel', index: 0 };
      },
    },
  );
  assert.equal(planned, 1, '选择与冲突统一由核心计划处理');
});

test('输入闸门：仅放行非命名的自由文本', () => {
  const key = over => ({
    escape: false,
    return: false,
    tab: false,
    backspace: false,
    delete: false,
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    home: false,
    end: false,
    ctrl: false,
    meta: false,
    ...over,
  });
  assert.equal(isIgnoredText('你好', key()), true);
  assert.equal(isIgnoredText('ｒ', key()), true);
  assert.equal(isIgnoredText('　', key()), true);
  assert.equal(isIgnoredText('r', key()), true);
  assert.equal(isIgnoredText('', key()), false);
  for (const flag of [
    'escape',
    'return',
    'tab',
    'backspace',
    'delete',
    'upArrow',
    'downArrow',
    'leftArrow',
    'rightArrow',
    'pageUp',
    'pageDown',
    'home',
    'end',
    'ctrl',
    'meta',
  ])
    assert.equal(isIgnoredText('你', key({ [flag]: true })), false, flag);
});
