import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOME_TITLE } from '../dist/render.js';
import { runTerminal } from '../dist/terminal.js';

const item = (id, kind, name, actions = ['install']) => ({
  id,
  kind,
  name,
  title: name,
  canInstall: true,
  actions,
  facts: [],
});
const contents = [
  item('settings', 'settings', '模型配置', ['configure', 'login']),
  item('plugin:github@official', 'plugin', 'GitHub'),
  item('mcp:context7', 'mcp', 'Context7'),
  item('officecli', 'officecli', 'OfficeCLI'),
];
const indexOf = (page, name) => page.rows.findIndex(row => row.label.startsWith(name));
const checked = page => page.rows.filter(row => row.checked).map(row => row.label);

async function scenario(select, { items = contents, choose, plan, inspect, apply, resultChoice = 1 } = {}) {
  const plans = [];
  const applications = [];
  let homes = 0;
  await runTerminal(
    {
      async inspect() {
        return { items: inspect ? inspect() : items, problems: [] };
      },
      async plan(input) {
        const selections = input.selected;
        plans.push(selections);
        return plan ? plan(selections) : { id: 'fixture', items: [], problem: null };
      },
      async apply(id) {
        applications.push(id);
        return apply
          ? apply(plans.at(-1))
          : {
              state: 'done',
              items: plans.at(-1).map(selection => ({
                id: selection.id,
                title: contents.find(entry => entry.id === selection.id)?.title ?? selection.id,
                state: 'done',
                effects: [],
              })),
            };
      },
    },
    {
      wait: (_title, work) => work(new AbortController().signal),
      handoff: work => work(),
      show() {},
      select,
      async choose(title, choices, focus) {
        if (typeof title !== 'string') {
          assert.equal(title.phase, 'result');
          return resultChoice;
        }
        if (title === HOME_TITLE) return homes++ ? 4 : 0;
        assert.doesNotMatch(title, /变更预览/);
        if (choose) return choose(title, choices, focus);
        assert.fail(`不应出现额外菜单：${title}`);
      },
    },
  );
  return { plans, applications };
}

test('全选普通内容：提交整体安装计划', async () => {
  const result = await scenario(async (page, change) => {
    assert.deepEqual(checked(page), []);
    const updated = change({ kind: 'all' });
    assert.deepEqual(checked(updated), ['GitHub', 'Context7', 'OfficeCLI']);
    assert.equal(updated.submitLabel, '开始安装（3 项）');
    return { kind: 'submit', index: updated.rows.length };
  });
  assert.deepEqual(
    result.plans[0].map(selection => selection.id),
    ['plugin:github@official', 'mcp:context7', 'officecli'],
  );
  assert.deepEqual(result.applications, ['fixture']);
});

test('刷新列表：保留勾选', async () => {
  let steps = 0;
  let inspections = 0;
  const result = await scenario(
    async (page, change) => {
      const index = indexOf(page, 'Context7');
      if (steps++ === 0) {
        assert.deepEqual(checked(change({ kind: 'toggle', index })), ['Context7']);
        return { kind: 'refresh', index };
      }
      assert.deepEqual(checked(page), ['Context7']);
      return { kind: 'submit', index: page.rows.length };
    },
    {
      inspect() {
        inspections++;
        return inspections === 1 ? contents : [contents[3], contents[2], contents[1], contents[0]];
      },
      choose: (_title, choices) => choices.indexOf('返回'),
    },
  );
  assert.equal(inspections, 2);
  assert.deepEqual(
    result.plans[0].map(selection => selection.id),
    ['mcp:context7'],
  );
});

test('安装页禁用更新与重装', async () => {
  const result = await scenario(
    async (page, change) => {
      assert.equal(page.rows.length, 2);
      assert.doesNotMatch(change({ kind: 'toggle', index: 1 }).rows[1].label, /更新|重装/);
      return { kind: 'submit', index: page.rows.length };
    },
    {
      items: [
        item('claude:installed', 'claude', 'Claude Code', ['update', 'reinstall']),
        item('plugin:code-simplifier@official', 'plugin', 'Code Simplifier', ['update', 'reinstall', 'connect']),
      ],
    },
  );
  assert.deepEqual(result.plans[0][0], { id: 'plugin:code-simplifier@official' });
});

test('准备失败：保留选择并阻止执行', async () => {
  let steps = 0;
  const result = await scenario(
    async (page, change) => {
      if (steps++ === 0) {
        change({ kind: 'all' });
        return { kind: 'submit', index: page.rows.length };
      }
      assert.deepEqual(checked(page), ['GitHub', 'Context7', 'OfficeCLI']);
      assert.match(page.title, /安装失败/);
      assert.equal(page.rows[indexOf(page, 'Context7')].detail, '安装失败');
      return { kind: 'cancel', index: 0 };
    },
    {
      plan: selections => ({
        id: 'blocked',
        problem: null,
        items: selections.map(selection => ({
          ...selection,
          title: contents.find(entry => entry.id === selection.id)?.title ?? selection.id,
          changes: [],
          problem: selection.id === 'mcp:context7' ? 'invalid-base-url' : null,
        })),
      }),
    },
  );
  assert.deepEqual(result.applications, []);
});

test('安装错误：提供取消和主动详情', async () => {
  let steps = 0;
  const result = await scenario(
    async (page, change) => {
      const index = indexOf(page, 'Context7');
      if (steps++ === 0) {
        change({ kind: 'toggle', index });
        return { kind: 'submit', index: page.rows.length };
      }
      if (steps === 2) return { kind: 'open', index };
      assert.deepEqual(checked(page), []);
      return { kind: 'cancel', index: 0 };
    },
    {
      plan: () => ({
        id: 'blocked',
        problem: null,
        items: [{ id: 'mcp:context7', title: 'Context7', problem: 'source-unavailable' }],
      }),
      choose: (title, choices) => {
        assert.equal(title, 'Context7\n安装失败');
        assert.deepEqual(choices, ['取消选择', '返回', '查看详情']);
        return 0;
      },
    },
  );
  assert.deepEqual(result.applications, []);
});

test('直接勾选免配置内容', async () => {
  const result = await scenario(async (page, change) => {
    for (const name of ['GitHub', 'Context7', 'OfficeCLI']) {
      const index = indexOf(page, name);
      assert.equal(page.rows[index].enter, 'toggle');
      assert.doesNotMatch(page.rows[index].label, /›/);
      change({ kind: 'toggle', index });
    }
    return { kind: 'submit', index: page.rows.length };
  });
  assert.deepEqual(result.plans[0], [{ id: 'plugin:github@official' }, { id: 'mcp:context7' }, { id: 'officecli' }]);
});

for (const replace of [true, false])
  test(`处理本地冲突：${replace ? '备份替换' : '取消选择'}`, async () => {
    const items = [
      item('plugin:code-simplifier@official', 'plugin', 'Code Simplifier'),
      item('skill:ssre2', 'skill', 'HIT-SudoMaker/SSRE2'),
    ];
    let steps = 0;
    let choices = 0;
    const result = await scenario(
      async (page, change) => {
        if (steps++ === 0) {
          change({ kind: 'all' });
          return { kind: 'submit', index: page.rows.length };
        }
        const index = indexOf(page, 'HIT-SudoMaker/SSRE2');
        if (steps === 2) {
          assert.equal(page.rows[index].enter, 'open');
          assert.equal(page.rows[index].checked, true);
          return { kind: 'open', index };
        }
        assert.deepEqual(checked(page), replace ? ['Code Simplifier', 'HIT-SudoMaker/SSRE2'] : ['Code Simplifier']);
        return { kind: 'submit', index: page.rows.length };
      },
      {
        items,
        choose: (_title, options) => {
          choices++;
          assert.deepEqual(options, ['备份并替换', '取消选择', '返回', '查看详情']);
          return replace ? 0 : 1;
        },
        plan: selections => ({
          id: 'valid',
          problem: null,
          items: selections.map(selection => ({
            ...selection,
            title: contents.find(entry => entry.id === selection.id)?.title ?? selection.id,
            changes: [],
            problem:
              selection.id === 'skill:ssre2' && selection.fields?.replace !== 'yes' ? 'local-edits-preserved' : null,
          })),
        }),
      },
    );
    assert.equal(choices, 1);
    assert.equal(result.plans.length, 2);
    assert.deepEqual(result.applications, ['valid']);
    assert.deepEqual(
      result.plans[1].map(selection => selection.id),
      replace ? ['plugin:code-simplifier@official', 'skill:ssre2'] : ['plugin:code-simplifier@official'],
    );
    if (replace) assert.equal(result.plans[1][1].fields.replace, 'yes');
  });

test('刷新目标缺失：阻止批量安装', async () => {
  let steps = 0;
  let inspections = 0;
  const result = await scenario(
    async (page, change) => {
      if (steps++ === 0) {
        change({ kind: 'all' });
        return { kind: 'refresh', index: 0 };
      }
      const index = indexOf(page, 'Context7');
      assert.match(page.rows[index].detail, /安装失败/);
      if (steps === 2) return { kind: 'submit', index: page.rows.length };
      const updated = change({ kind: 'toggle', index });
      assert.deepEqual(checked(updated), ['GitHub', 'OfficeCLI']);
      return { kind: 'submit', index: page.rows.length };
    },
    { inspect: () => (++inspections === 1 ? contents : contents.filter(item => item.id !== 'mcp:context7')) },
  );
  assert.equal(result.plans.length, 1);
  assert.deepEqual(
    result.plans[0].map(selection => selection.id),
    ['plugin:github@official', 'officecli'],
  );
});

test('取消缺失配置的一组字段：保留其他选择的问题', async () => {
  let steps = 0;
  let inspections = 0;
  const result = await scenario(
    async (page, change) => {
      steps++;
      if (steps <= 2) return { kind: 'open', index: indexOf(page, steps === 1 ? '默认输出语言' : '输出风格') };
      if (steps === 3) return { kind: 'refresh', index: 0 };
      const language = indexOf(page, '默认输出语言');
      const style = indexOf(page, '输出风格');
      const updated = change({ kind: 'toggle', index: language });
      assert.equal(updated.rows[language].checked, false);
      assert.equal(updated.rows[style].checked, true);
      assert.equal(updated.rows[style].detail, '安装失败');
      const cleared = change({ kind: 'toggle', index: style });
      assert.equal(cleared.rows[style].checked, false);
      assert.doesNotMatch(cleared.rows[style].detail, /安装失败/);
      return { kind: 'cancel', index: style };
    },
    {
      inspect: () => (++inspections === 1 ? contents : contents.slice(1)),
      choose: title => (title === '默认输出语言' ? 1 : 2),
    },
  );
  assert.deepEqual(result.plans, []);
  assert.deepEqual(result.applications, []);
});

test('重试安装：跳过完成项', async () => {
  let steps = 0;
  let applications = 0;
  const result = await scenario(
    async (page, change) => {
      if (steps++ === 0) change({ kind: 'all' });
      else if (steps === 2) assert.deepEqual(checked(page), ['Context7']);
      else {
        assert.deepEqual(checked(page), []);
        return { kind: 'cancel', index: 0 };
      }
      return { kind: 'submit', index: page.rows.length };
    },
    {
      items: contents.slice(1, 3),
      resultChoice: 0,
      apply: selections =>
        ++applications === 1
          ? {
              state: 'partial',
              items: [
                { id: 'plugin:github@official', title: 'GitHub', state: 'done', effects: [] },
                { id: 'mcp:context7', title: 'Context7', state: 'failed', effects: [] },
              ],
            }
          : {
              state: 'done',
              items: selections.map(selection => ({
                id: selection.id,
                title: contents.find(entry => entry.id === selection.id)?.title ?? selection.id,
                state: 'done',
                effects: [],
              })),
            },
    },
  );
  assert.deepEqual(
    result.plans.map(plan => plan.map(selection => selection.id)),
    [['plugin:github@official', 'mcp:context7'], ['mcp:context7']],
  );
  assert.equal(result.applications.length, 2);
});
