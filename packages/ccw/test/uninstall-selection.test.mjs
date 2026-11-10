import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOME_TITLE } from '../dist/render.js';
import { runTerminal } from './terminal-test.mjs';

const contents = [
  {
    id: 'claude:npm:selected',
    title: 'Claude Code',
    kind: 'claude',
    facts: [{ code: 'program-exists' }],
    actions: ['uninstall'],
  },
  {
    id: 'officecli:native:selected',
    title: 'OfficeCLI',
    kind: 'officecli',
    facts: [{ code: 'program-exists' }, { code: 'connected' }],
    actions: ['uninstall', 'detach'],
  },
  {
    id: 'mcp:external',
    title: '外部 MCP',
    kind: 'mcp',
    facts: [{ code: 'registration-exists' }],
    actions: ['detach'],
  },
];

for (const [route, label] of [
  ['detail', '查看详情'],
  ['preview', '返回修改'],
  ['home', '返回主菜单'],
])
  test(`${label}：保留卸载计划`, async () => {
    let homes = 0;
    let pages = 0;
    let applies = 0;
    let previews = 0;
    const requests = [];
    const item = contents[1];
    await runTerminal(
      {
        async recovery() {
          return applies === 1
            ? {
                id: 'frozen',
                intent: { task: 'uninstall' },
                items: [{ id: item.id, title: item.title, state: 'pending' }],
                inputs: [],
              }
            : undefined;
        },
        async inspect() {
          return { items: [item], problems: [] };
        },
        async plan(input) {
          requests.push(input);
          return {
            id: `p${requests.length}`,
            problem: null,
            items: [{ id: item.id, title: item.title, action: 'uninstall', changes: [], problem: null }],
          };
        },
        async apply() {
          return ++applies === 1
            ? {
                state: 'partial',
                remaining: 'frozen',
                items: [{ id: item.id, state: 'partial', isPending: true, effects: [] }],
              }
            : { state: 'done', items: [{ id: item.id, state: 'done', effects: [] }] };
        },
      },
      {
        wait: (_title, work) => work(new AbortController().signal),
        show() {},
        async select(_page, change) {
          pages++;
          if (pages === 1) change({ kind: 'toggle', index: 0 });
          return { kind: route === 'detail' && pages === 2 ? 'open' : 'submit', index: 0 };
        },
        async choose(title, choices) {
          if (typeof title !== 'string') return applies === 1 && route !== 'home' ? 0 : 1;
          if (title === HOME_TITLE) return homes++ === 0 ? 2 : 4;
          if (title.startsWith('未完成任务')) return 0;
          if (title.startsWith('变更预览')) return route === 'preview' && ++previews === 2 ? 1 : 0;
          if (choices.includes('取消选择')) return choices.indexOf('返回');
          return applies === 1 && route !== 'home' ? 0 : 1;
        },
      },
    );
    assert.deepEqual(requests, [
      { task: 'uninstall', selected: [{ id: item.id }] },
      { resume: 'frozen' },
      ...(route === 'preview' ? [{ resume: 'frozen' }] : []),
    ]);
    assert.equal(applies, 2);
  });

test('转入卸载：保留解除接入选择', async () => {
  const item = contents[1];
  let homes = 0;
  let pages = 0;
  await runTerminal(
    {
      async inspect() {
        return { items: [item], problems: [] };
      },
    },
    {
      wait: (_title, work) => work(new AbortController().signal),
      show() {},
      async choose(title, choices) {
        if (title === HOME_TITLE) return [2, 1, 4][homes++];
        if (title.startsWith('检查套件')) return 0;
        if (choices.includes('取消选择')) return choices.indexOf('解除接入');
        return choices.indexOf('进入卸载');
      },
      async select(page) {
        if (++pages === 1) return { kind: 'open', index: 0 };
        assert.match(page.rows[0].detail, /仅解除接入/);
        return { kind: 'cancel', index: 0 };
      },
    },
  );
});

test('准备卸载失败：定位问题并保留选择', async () => {
  let homes = 0;
  let pages = 0;
  await runTerminal(
    {
      async inspect() {
        return { items: [contents[1]], problems: [] };
      },
      async plan() {
        return {
          id: 'blocked',
          problem: null,
          items: [
            { id: contents[1].id, title: 'OfficeCLI', action: 'uninstall', changes: [], problem: 'program-changed' },
          ],
        };
      },
      async apply() {
        assert.fail('blocked operation must not run');
      },
    },
    {
      wait: (_title, work) => work(new AbortController().signal),
      show() {},
      async choose(title) {
        assert.equal(title, HOME_TITLE);
        return homes++ ? 4 : 2;
      },
      async select(page, change) {
        if (++pages === 1) {
          change({ kind: 'toggle', index: 0 });
          return { kind: 'submit', index: 0 };
        }
        assert.ok(page.rows[0].checked);
        assert.match(page.rows[0].detail, /卸载失败/);
        return { kind: 'cancel', index: 0 };
      },
    },
  );
});

async function interact({ select, detail, preview, result, resultsPage, items = contents }) {
  const requests = [];
  let homes = 0;
  let planned = [];
  await runTerminal(
    {
      async inspect() {
        return { items, problems: [] };
      },
      async plan(input) {
        requests.push(input);
        planned = [
          ...input.selected.map(pick => ({
            id: pick.id,
            title: pick.id,
            action: pick.removal === 'detach' || pick.id.startsWith('mcp:') ? 'detach' : 'uninstall',
            changes: [],
            problem: null,
          })),
          ...(input.removeData
            ? [{ id: 'data:claude', title: 'Claude 用户数据', action: 'uninstall', changes: [], problem: null }]
            : []),
        ];
        return { id: 'removal', problem: null, items: planned };
      },
      async apply() {
        return result ?? { state: 'done', items: planned.map(item => ({ id: item.id, state: 'done', effects: [] })) };
      },
    },
    {
      wait: (_title, work) => work(new AbortController().signal),
      show() {},
      select,
      async choose(title, choices) {
        if (typeof title !== 'string') {
          resultsPage?.(choices);
          return 1;
        }
        if (title === HOME_TITLE) return homes++ ? 4 : 2;
        if (title.startsWith('变更预览')) return preview?.(title, choices) ?? 0;
        if (choices.includes('取消选择')) return detail(choices);
        assert.fail(`未预期的菜单：${title}`);
      },
    },
  );
  return requests;
}

test('全选卸载：合并程序与入口', async () => {
  const requests = await interact({
    async select(page, change) {
      assert.match(page.title, /保留用户配置与数据/);
      assert.match(page.rows.find(row => row.label === 'Claude Code').detail, /卸载程序/);
      assert.equal(
        page.rows.some(row => row.label.startsWith('删除 Claude 用户数据')),
        false,
      );
      const updated = change({ kind: 'all' });
      const data = updated.rows.find(row => row.label.startsWith('删除 Claude 用户数据'));
      assert.ok(data);
      assert.equal(data.checked, false);
      return { kind: 'submit', index: updated.rows.length };
    },
  });
  assert.deepEqual(requests, [
    {
      task: 'uninstall',
      selected: [{ id: contents[0].id }, { id: contents[2].id, removal: 'detach' }, { id: contents[1].id }],
    },
  ]);
});

test('取消 Claude 卸载：清除数据选项', async () => {
  const requests = await interact({
    async select(page, change) {
      assert.equal(
        page.rows.some(row => row.label.startsWith('删除 Claude 用户数据')),
        false,
      );
      const claude = page.rows.findIndex(row => row.label.startsWith('Claude Code'));
      let updated = change({ kind: 'toggle', index: claude });
      let data = updated.rows.findIndex(row => row.label.startsWith('删除 Claude 用户数据'));
      assert.ok(data >= 0);
      assert.equal(updated.rows[data].checked, false);
      updated = change({ kind: 'toggle', index: data });
      assert.equal(updated.rows[data].checked, true);
      updated = change({ kind: 'toggle', index: claude });
      assert.equal(
        updated.rows.some(row => row.label.startsWith('删除 Claude 用户数据')),
        false,
      );
      return { kind: 'cancel', index: claude };
    },
  });
  assert.deepEqual(requests, []);
});

test('修改或刷新预览：保留数据选项', async () => {
  let pages = 0;
  let previews = 0;
  const requests = await interact({
    async select(page, change) {
      pages++;
      const claude = page.rows.findIndex(row => row.label.startsWith('Claude Code'));
      if (pages === 1) {
        let updated = change({ kind: 'toggle', index: claude });
        const data = updated.rows.findIndex(row => row.label.startsWith('删除 Claude 用户数据'));
        updated = change({ kind: 'toggle', index: data });
        assert.equal(updated.rows[data].checked, true);
        return { kind: 'submit', index: updated.rows.length };
      }
      const data = page.rows.find(row => row.label.startsWith('删除 Claude 用户数据'));
      assert.ok(data);
      assert.equal(data.checked, true);
      return { kind: pages === 2 ? 'refresh' : 'submit', index: page.rows.length };
    },
    preview(title) {
      previews++;
      assert.match(title, /删除 Claude 用户数据/);
      return previews === 1 ? 1 : 0;
    },
  });
  assert.equal(pages, 3);
  assert.equal(previews, 2);
  assert.deepEqual(
    requests,
    Array.from({ length: 2 }, () => ({ task: 'uninstall', selected: [{ id: contents[0].id }], removeData: true })),
  );
});

test('准备数据失败：允许取消选项', async () => {
  let homes = 0;
  let pages = 0;
  let confirmations = 0;
  const requests = [];
  await runTerminal(
    {
      async inspect() {
        return { items: [contents[0]], problems: [] };
      },
      async plan(input) {
        requests.push(input);
        return {
          id: 'blocked-data',
          problem: null,
          items: [
            { id: contents[0].id, title: 'Claude Code', action: 'uninstall', changes: [], problem: null },
            {
              id: 'data:claude',
              title: 'Claude 用户数据',
              action: 'uninstall',
              changes: [],
              problem: 'cleanup-inspection-incomplete',
            },
          ],
        };
      },
      async apply() {
        assert.fail('blocked operation must not run');
      },
    },
    {
      wait: (_title, work) => work(new AbortController().signal),
      show() {},
      async select(page, change, focus) {
        pages++;
        if (pages === 1) {
          let updated = change({ kind: 'toggle', index: 0 });
          const data = updated.rows.findIndex(row => row.label.startsWith('删除 Claude 用户数据'));
          updated = change({ kind: 'toggle', index: data });
          return { kind: 'submit', index: updated.rows.length };
        }
        const data = page.rows.findIndex(row => row.label.startsWith('删除 Claude 用户数据'));
        assert.equal(focus, data);
        assert.equal(page.rows[data].detail, '卸载失败');
        const updated = change({ kind: 'toggle', index: data });
        assert.equal(updated.rows[data].checked, false);
        assert.equal(updated.rows[data].detail, undefined);
        return { kind: 'cancel', index: data };
      },
      async choose(title) {
        if (title === HOME_TITLE) return homes++ ? 4 : 2;
        if (typeof title === 'string' && title.startsWith('变更预览')) confirmations++;
        return 1;
      },
    },
  );
  assert.equal(confirmations, 1);
  assert.deepEqual(requests, [{ task: 'uninstall', selected: [{ id: contents[0].id }], removeData: true }]);
});

test('完成程序卸载：继续剩余数据删除', async () => {
  let homes = 0;
  let pages = 0;
  let applies = 0;
  const requests = [];
  await runTerminal(
    {
      async recovery() {
        return applies === 1
          ? {
              id: 'data-frozen',
              intent: { task: 'uninstall', removeData: true },
              items: [
                { id: contents[0].id, title: 'Claude Code', state: 'done' },
                { id: 'data:claude', title: 'Claude 用户数据', state: 'pending' },
              ],
              inputs: [],
            }
          : undefined;
      },
      async inspect() {
        return { items: applies ? [] : [contents[0]], problems: [] };
      },
      async plan(input) {
        requests.push(input);
        return 'resume' in input
          ? {
              id: 'data-resume',
              problem: null,
              items: [{ id: 'data:claude', title: 'Claude 用户数据', action: 'uninstall', changes: [], problem: null }],
            }
          : {
              id: 'program-and-data',
              problem: null,
              items: [
                { id: contents[0].id, title: 'Claude Code', action: 'uninstall', changes: [], problem: null },
                { id: 'data:claude', title: 'Claude 用户数据', action: 'uninstall', changes: [], problem: null },
              ],
            };
      },
      async apply() {
        applies++;
        return applies === 1
          ? {
              state: 'partial',
              remaining: 'data-frozen',
              items: [
                { id: contents[0].id, state: 'done', isPending: false, effects: [] },
                { id: 'data:claude', state: 'partial', isPending: true, effects: [] },
              ],
            }
          : { state: 'done', items: [{ id: 'data:claude', state: 'done', isPending: false, effects: [] }] };
      },
    },
    {
      wait: (_title, work) => work(new AbortController().signal),
      show() {},
      async select(page, change) {
        pages++;
        if (pages === 1) {
          let updated = change({ kind: 'toggle', index: 0 });
          const data = updated.rows.findIndex(row => row.label.startsWith('删除 Claude 用户数据'));
          updated = change({ kind: 'toggle', index: data });
          return { kind: 'submit', index: updated.rows.length };
        }
        assert.equal(page.rows.length, 1);
        assert.match(page.rows[0].label, /^删除 Claude 用户数据/);
        assert.equal(page.rows[0].checked, true);
        return { kind: 'submit', index: 1 };
      },
      async choose(title, choices) {
        if (title === HOME_TITLE) return homes++ ? 4 : 2;
        if (typeof title === 'string' && title.startsWith('未完成任务')) {
          assert.match(title, /已完成 · Claude Code/);
          assert.match(title, /未执行 · Claude 用户数据/);
          return 0;
        }
        if (typeof title === 'string' && title.startsWith('变更预览')) return 0;
        assert.equal(choices[0], applies === 1 ? '继续未完成任务' : '返回列表');
        return applies === 1 ? 0 : 1;
      },
    },
  );
  assert.equal(applies, 2);
  assert.equal(pages, 1, '剩余工作从中央任务查询展示，不另建列表续办状态');
  assert.deepEqual(requests, [
    { task: 'uninstall', selected: [{ id: contents[0].id }], removeData: true },
    { resume: 'data-frozen' },
  ]);
});

test('选择解除接入：提交并回显意图', async () => {
  let pages = 0;
  const requests = await interact({
    async select(page, change) {
      const index = page.rows.findIndex(row => row.label.startsWith('OfficeCLI'));
      if (!pages++) return { kind: 'open', index };
      assert.match(page.rows[index].detail, /仅解除接入/);
      assert.equal(page.rows[index].checked, true);
      const updated = change({ kind: 'all' });
      assert.match(updated.rows[index].detail, /仅解除接入/);
      return { kind: 'submit', index: page.rows.length };
    },
    detail: choices => choices.indexOf('解除接入'),
  });
  assert.deepEqual(requests, [
    {
      task: 'uninstall',
      selected: [
        { id: contents[1].id, removal: 'detach' },
        { id: contents[0].id },
        { id: contents[2].id, removal: 'detach' },
      ],
    },
  ]);
});

test('末步取消：不重试已完成卸载', async () => {
  await interact({
    async select(page, change) {
      change({ kind: 'toggle', index: 0 });
      return { kind: 'submit', index: page.rows.length };
    },
    result: {
      state: 'cancelled',
      items: [
        {
          id: contents[0].id,
          state: 'cancelled',
          effects: [{ state: 'done', code: 'program-removed' }],
          isPending: false,
        },
      ],
    },
    resultsPage: choices => assert.equal(choices[0], '返回列表'),
  });
});

test('解除手工工具：保留程序', async () => {
  const manual = { ...contents[1], id: 'officecli:manual:selected', actions: ['connect', 'detach'] };
  const requests = await interact({
    items: [manual],
    async select(page, change) {
      change({ kind: 'toggle', index: 0 });
      return { kind: 'submit', index: page.rows.length };
    },
  });
  assert.deepEqual(requests, [{ task: 'uninstall', selected: [{ id: manual.id, removal: 'detach' }] }]);
});
