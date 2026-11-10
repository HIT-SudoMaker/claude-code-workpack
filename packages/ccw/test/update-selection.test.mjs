import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOME_TITLE } from '../dist/render.js';
import { runTerminal } from '../dist/terminal.js';
import { wait } from './env.mjs';

const office = {
  id: 'officecli:native:/home/test/.local/bin/officecli',
  title: 'OfficeCLI',
  kind: 'officecli',
  canInstall: true,
  facts: [{ code: 'program-exists', detail: 'native' }, { code: 'program-identity-unchecked' }],
  actions: ['update', 'reinstall', 'connect', 'uninstall'],
};

async function scenario(select, { items = [office], routes = ['进入更新'], home = [1, 4], choose } = {}) {
  let homes = 0;
  let routing = 0;
  const plans = [];
  await runTerminal(
    {
      inspect: async () => ({ items, problems: [] }),
      async plan(input) {
        plans.push(input);
        return {
          id: 'blocked',
          items: input.selected.map(pick => ({ id: pick.id, problem: 'source-unavailable' })),
          problem: null,
        };
      },
    },
    {
      wait,
      show() {},
      async choose(title, choices) {
        if (title === HOME_TITLE) return home[homes++] ?? 4;
        if (title.startsWith('检查套件')) return 0;
        if (choices.includes('进入更新')) return choices.indexOf(routes[routing++]);
        assert.ok(choose, `未预期的菜单：${title}`);
        return choose(title, choices);
      },
      select: (page, change) => select(page, change, plans),
    },
  );
  return plans;
}

for (const item of [
  office,
  { ...office, id: 'claude:native:/home/test/.local/bin/claude', title: 'Claude Code', kind: 'claude' },
  { ...office, id: 'plugin:github@official', title: 'GitHub', kind: 'plugin' },
  { id: 'skill:tdd', title: 'tdd', kind: 'skill', facts: [{ code: 'entry-exists' }], actions: ['update', 'detach'] },
])
  test(`${item.title} 检查进入更新：取消后重新勾选仍提交更新`, async () => {
    const plans = await scenario(
      async (page, change, plans) => {
        if (plans.length) return { kind: 'cancel', index: 0 };
        assert.equal(page.rows[0].checked, true);
        assert.match(page.rows[0].detail, /已选更新/);
        const unchecked = change({ kind: 'toggle', index: 0 });
        assert.equal(unchecked.rows[0].checked, false);
        assert.doesNotMatch(unchecked.rows[0].detail, /已选更新/);
        const rechecked = change({ kind: 'toggle', index: 0 });
        assert.equal(rechecked.rows[0].checked, true);
        assert.match(rechecked.rows[0].detail, /已选更新/);
        return { kind: 'submit', index: 1 };
      },
      { items: [item] },
    );
    assert.deepEqual(plans[0].selected, [{ id: item.id, maintenance: 'update' }]);
  });

test('取消更新后刷新：保留更新入口，全选普通项不重新勾选更新', async () => {
  const member = { id: 'skill:tdd', title: 'tdd', kind: 'skill', facts: [], actions: ['update', 'detach'] };
  const plain = {
    id: 'ccline',
    title: 'CCometixLine',
    kind: 'ccline',
    canInstall: true,
    facts: [],
    actions: ['install'],
  };
  let visits = 0;
  const plans = await scenario(
    async (page, change, plans) => {
      if (plans.length) return { kind: 'cancel', index: 0 };
      const index = page.rows.findIndex(row => row.label === 'tdd');
      assert.notEqual(index, -1, '刷新后更新入口仍可重新勾选');
      if (visits++ === 0) {
        change({ kind: 'toggle', index });
        return { kind: 'refresh', index };
      }
      assert.equal(page.rows[index].checked, false);
      const all = change({ kind: 'all' });
      assert.equal(all.rows[index].checked, false, '全选仅勾选普通项');
      change({ kind: 'all' });
      assert.match(change({ kind: 'toggle', index }).rows[index].detail, /已选更新/);
      return { kind: 'submit', index: page.rows.length };
    },
    { items: [member, plain] },
  );
  assert.deepEqual(plans[0].selected, [{ id: member.id, maintenance: 'update' }]);
});

test('更新准备失败：从错误详情取消再勾选仍为更新', async () => {
  let visits = 0;
  const plans = await scenario(
    async (page, change) => {
      if (visits++ === 0) return { kind: 'submit', index: 1 };
      if (visits === 2) return { kind: 'open', index: 0 };
      if (visits === 3) {
        assert.equal(page.rows[0].checked, false);
        assert.match(change({ kind: 'toggle', index: 0 }).rows[0].detail, /已选更新/);
        return { kind: 'submit', index: 1 };
      }
      return { kind: 'cancel', index: 0 };
    },
    { choose: (_title, choices) => choices.indexOf('取消选择') },
  );
  assert.equal(plans.length, 2);
  for (const plan of plans) assert.deepEqual(plan.selected, [{ id: office.id, maintenance: 'update' }]);
});

test('重新从检查页明确进入安装：替换旧的更新意图', async () => {
  let visits = 0;
  const plans = await scenario(
    async (page, _change, plans) => {
      if (plans.length) return { kind: 'cancel', index: 0 };
      if (visits++ === 0) {
        assert.match(page.rows[0].detail, /已选更新/);
        return { kind: 'cancel', index: 0 };
      }
      assert.equal(page.rows[0].checked, true);
      assert.doesNotMatch(page.rows[0].detail, /已选更新/);
      return { kind: 'submit', index: 1 };
    },
    { home: [1, 1, 4], routes: ['进入更新', '进入安装'] },
  );
  assert.deepEqual(plans[0].selected, [{ id: office.id }]);
});

test('更新草稿与卸载草稿隔离：进入卸载后仍可全选', async () => {
  let visits = 0;
  const plans = await scenario(
    async (page, change) => {
      if (visits++ === 0) {
        assert.match(page.rows[0].detail, /已选更新/);
        return { kind: 'cancel', index: 0 };
      }
      assert.match(page.title, /卸载套件/);
      assert.equal(page.rows[0].checked, false);
      const all = change({ kind: 'all' });
      assert.equal(all.rows[0].checked, true);
      assert.doesNotMatch(all.rows[0].detail, /已选更新/);
      return { kind: 'cancel', index: 0 };
    },
    { home: [1, 2, 4] },
  );
  assert.deepEqual(plans, []);
});
