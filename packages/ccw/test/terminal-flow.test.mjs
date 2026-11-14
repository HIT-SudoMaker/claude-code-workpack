import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTerminal } from '../dist/terminal.js';
import { HOME_TITLE, reason } from '../dist/render.js';

function createTerminalScenario({ cancel = false, inspectOnly = false } = {}) {
  const requests = [];
  let applied = 0,
    homes = 0,
    selected = false;
  const item = {
    id: 'claude',
    title: 'Claude Code',
    kind: 'claude',
    facts: [{ code: 'not-installed' }],
    canInstall: true,
  };
  const ccw = {
    inspect: async () => ({ items: [item], problems: [] }),
    plan: async input => {
      requests.push(input);
      return {
        id: 'plan',
        problem: null,
        items: [
          { id: item.id, title: item.title, action: 'install', changes: [{ code: 'program-install' }], problem: null },
        ],
      };
    },
    apply: async () => {
      applied++;
      return { state: 'done', items: [{ id: item.id, title: item.title, state: 'done', effects: [] }] };
    },
  };
  const terminal = {
    wait: (_title, work) => work(new AbortController().signal),
    show() {},
    async choose(title, choices, defaultIndex) {
      if (title === HOME_TITLE) {
        assert.deepEqual(choices, ['安装配置', '检查状态', '移除程序', '清理数据', '退出程序']);
        return homes++ === 0 ? (inspectOnly ? 1 : 0) : 4;
      }
      if (typeof title === 'string' && title.startsWith('变更预览')) {
        assert.equal(defaultIndex, 1);
        return cancel ? 1 : 0;
      }
      assert.equal(choices.length, 1);
      return 0;
    },
    async select(page, change) {
      assert.equal(page.rows[0].label, item.title);
      if (selected && cancel) return 'cancel';
      const next = change({ kind: 'toggle', index: 0 });
      assert.equal(next.rows[0].checked, true);
      selected = true;
      return 'submit';
    },
    form() {
      throw new Error('unneeded configuration');
    },
  };
  return { ccw, terminal, requests, applied: () => applied };
}

test('主页提供四类操作，勾选对象后预览并执行', async () => {
  const scenario = createTerminalScenario();
  await runTerminal(scenario.ccw, scenario.terminal);
  assert.deepEqual(scenario.requests, [{ task: 'install', selected: [{ id: 'claude' }] }]);
  assert.equal(scenario.applied(), 1);
});

test('检查页只读，单步返回首页', async () => {
  const scenario = createTerminalScenario({ inspectOnly: true });
  await runTerminal(scenario.ccw, scenario.terminal);
  assert.deepEqual(scenario.requests, []);
  assert.equal(scenario.applied(), 0);
});

for (const [homeChoice, kind, id, ability] of [
  [0, 'plugin', 'plugin:serena@claude-plugins-official', 'canInstall'],
  [2, 'plugin', 'plugin:serena@claude-plugins-official', 'canUninstall'],
  [3, 'data', 'data:cache', 'canClean'],
])
  for (const hasAvailable of [false, true])
    test(`操作列表保留不可操作项目与检查失败原因：${homeChoice}/${hasAvailable}`, async () => {
      let homes = 0,
        shown = false;
      const items = [{ id, title: '问题项目', kind, facts: [], problem: 'inspection-timeout', [ability]: false }];
      if (hasAvailable) items.push({ id: 'available', title: '可操作项目', kind, facts: [], [ability]: true });
      const check = title => {
        shown = true;
        assert.match(title, /问题项目：检查超时/);
        assert.match(title, /来源检查/);
        assert.doesNotMatch(title, /没有可/);
      };
      await runTerminal(
        {
          inspect: async () => ({ items, problems: [{ code: 'inspection-timeout', detail: '来源检查' }] }),
          plan() {
            throw new Error('不应生成计划');
          },
          apply() {
            throw new Error('不应执行变更');
          },
        },
        {
          wait: (_title, work) => work(new AbortController().signal),
          choose: async title => {
            if (title === HOME_TITLE) return homes++ ? 4 : homeChoice;
            check(title);
            return 0;
          },
          select: async page => {
            check(page.title);
            assert.deepEqual(
              page.rows.map(row => row.label),
              ['可操作项目'],
            );
            return 'cancel';
          },
        },
      );
      assert.equal(shown, true);
    });

for (const scenario of [
  { editors: [1], fields: { language: 'English' } },
  { editors: [2], fields: { outputStyle: 'Concise' } },
  { editors: [1, 2], fields: { language: 'English', outputStyle: 'Concise' } },
  { editors: [1, 2], deselect: 1, fields: { outputStyle: 'Concise' } },
  { editors: [1, 1], cancelOn: 1, fields: { language: 'English' } },
  { editors: [1], cancelOn: 0 },
])
  test(`独立编辑设置：${JSON.stringify(scenario)}`, async () => {
    const item = {
      id: 'settings',
      title: '模型配置',
      kind: 'settings',
      canInstall: true,
      facts: [{ code: 'api-configured' }],
      values: { language: 'Simplified Chinese', outputStyle: 'Explanatory', model: 'keep-model' },
    };
    const requests = [];
    let home = 0,
      edit = 0,
      chosen = 0;
    await runTerminal(
      {
        inspect: async () => ({ items: [item], problems: [] }),
        plan: async request => {
          requests.push(request);
          return {
            id: 'settings-plan',
            problem: null,
            items: [{ id: 'settings', title: '模型配置', action: 'configure', changes: [], problem: null }],
          };
        },
        apply: async () => ({ state: 'done', items: [] }),
      },
      {
        wait: (_title, work) => work(new AbortController().signal),
        show() {},
        choose: async (title, choices) => {
          if (title === HOME_TITLE) return home++ ? 4 : 0;
          if ((title === '默认语言' || title === '输出风格') && chosen++ === scenario.cancelOn)
            return choices.length - 1;
          if (title === '默认语言') {
            assert.ok(choices.includes('英文'));
            return choices.indexOf('英文');
          }
          if (title === '输出风格') {
            assert.ok(choices.includes('简洁型 · Concise'));
            return choices.indexOf('简洁型 · Concise');
          }
          return 0;
        },
        select: async (page, change) => {
          assert.deepEqual(
            page.rows.map(row => row.label),
            ['模型配置', '默认语言', '输出风格'],
          );
          if (edit < scenario.editors.length) return { kind: 'edit', index: scenario.editors[edit++] };
          if (scenario.deselect !== undefined) page = change({ kind: 'toggle', index: scenario.deselect });
          assert.equal(page.rows[0].checked, false);
          if (!scenario.fields) {
            assert.ok(page.rows.every(row => !row.checked));
            return 'cancel';
          }
          if (scenario.fields.language) assert.equal(page.rows[1].detail, '英文');
          if (scenario.fields.outputStyle) assert.equal(page.rows[2].detail, '简洁型 · Concise');
          if (scenario.deselect !== undefined) assert.equal(page.rows[scenario.deselect].checked, false);
          return 'submit';
        },
        form() {
          throw new Error('偏好编辑不应打开凭据表单');
        },
      },
    );
    assert.deepEqual(
      requests,
      scenario.fields ? [{ task: 'install', selected: [{ id: 'settings', fields: scenario.fields }] }] : [],
    );
  });

test('模型配置表单读取并提交 Fable 模型', async () => {
  const item = {
    id: 'settings',
    title: '模型配置',
    kind: 'settings',
    canInstall: true,
    facts: [{ code: 'api-configured' }],
    hasCredential: true,
    values: { mode: 'api', baseUrl: 'https://gateway.example.test', fable: 'previous-fable' },
  };
  let home = 0;
  let selections = 0;
  let request;
  await runTerminal(
    {
      inspect: async () => ({ items: [item], problems: [] }),
      plan: async value => {
        request = value;
        return {
          id: 'settings-plan',
          problem: null,
          items: [{ id: 'settings', title: '模型配置', action: 'configure', changes: [], problem: null }],
        };
      },
    },
    {
      wait: (_title, work) => work(new AbortController().signal),
      choose: async title => {
        if (title === HOME_TITLE) return home++ ? 4 : 0;
        if (title === '模型配置') return 1;
        assert.ok(title.startsWith('变更预览'));
        return 1;
      },
      select: async () => {
        if (selections++ === 0) return { kind: 'edit', index: 0 };
        return selections === 2 ? 'submit' : 'cancel';
      },
      form: async (title, fields, validate) => {
        assert.equal(title, '第三方 API');
        assert.deepEqual(
          fields.map(field => field.key),
          ['baseUrl', 'secret', 'model', 'fable', 'opus', 'sonnet', 'haiku'],
        );
        assert.equal(fields.find(field => field.key === 'fable').value, 'previous-fable');
        const values = Object.fromEntries(fields.map(field => [field.key, field.value]));
        values.fable = 'updated-fable';
        assert.equal(validate(values), null);
        return values;
      },
    },
  );
  assert.equal(request.selected[0].fields.fable, 'updated-fable');
});

test('取消预览不执行，返回列表后可退出', async () => {
  const scenario = createTerminalScenario({ cancel: true });
  await runTerminal(scenario.ccw, scenario.terminal);
  assert.equal(scenario.applied(), 0);
});

test('GitHub、Context7 和 Serena 直接安装，不提供令牌编辑或询问', async () => {
  const items = [
    { id: 'plugin:github@claude-plugins-official', title: 'GitHub', kind: 'plugin' },
    { id: 'plugin:context7@claude-plugins-official', title: 'Context7', kind: 'plugin' },
    { id: 'plugin:serena@claude-plugins-official', title: 'Serena', kind: 'plugin' },
  ].map(item => ({ ...item, canInstall: true, facts: [] }));
  const requests = [];
  let homes = 0,
    previews = 0,
    applied = 0;
  await runTerminal(
    {
      inspect: async () => ({ items, problems: [] }),
      plan: async request => {
        requests.push(request);
        return {
          id: 'default-install',
          problem: null,
          items: items.map(item => ({ id: item.id, title: item.title, action: 'install', changes: [], problem: null })),
        };
      },
      apply: async () => {
        applied++;
        return { state: 'done', items: [] };
      },
    },
    {
      wait: (_title, work) => work(new AbortController().signal),
      show() {},
      choose: async title => {
        if (title === HOME_TITLE) return homes++ ? 4 : 0;
        if (title.startsWith('变更预览')) return previews++ === 0 ? 1 : 0;
        return 0;
      },
      select: async (page, change) => {
        assert.ok(page.rows.every(row => !row.editable));
        assert.doesNotMatch(JSON.stringify(page), /令牌|credential|secret/);
        if (!page.rows.every(row => row.checked)) change({ kind: 'all' });
        return 'submit';
      },
      form() {
        throw new Error('插件安装不应询问令牌');
      },
    },
  );
  assert.equal(applied, 1);
  assert.deepEqual(
    requests,
    Array.from({ length: 2 }, () => ({
      task: 'install',
      selected: items.map(item => ({ id: item.id })),
    })),
  );
});

for (const details of [false, true])
  test(`检查与操作异常${details ? '显示' : '隐藏'}原因码且不泄露原始异常`, async () => {
    const screens = [];
    const homeChoices = [1, 0, 4];
    let selections = 0;
    const item = { id: 'claude', title: 'Claude Code', kind: 'claude', facts: [], canInstall: true };
    const ccw = {
      inspect: async () => ({ items: [item], problems: [{ code: 'invalid-settings' }] }),
      plan: async () => {
        throw Object.assign(new Error('private-token=never-display'), { code: 'invalid-settings' });
      },
    };
    const terminal = {
      wait: (_title, work) => work(new AbortController().signal),
      choose: async title => {
        if (title === HOME_TITLE) return homeChoices.shift();
        screens.push(title);
        return 0;
      },
      select: async (_page, change) => {
        if (selections++) return 'cancel';
        change({ kind: 'toggle', index: 0 });
        return 'submit';
      },
    };
    await runTerminal(ccw, terminal, undefined, details);
    assert.equal(screens.length, 2);
    assert.ok(screens[0].startsWith('检查状态\n'));
    assert.ok(screens[1].startsWith('操作失败：'));
    for (const screen of screens) {
      assert.ok(screen.includes(reason('invalid-settings')));
      assert.equal(screen.includes('代码：invalid-settings'), details);
      assert.doesNotMatch(screen, /private-token|never-display|Error:|\bat .*terminal-flow/);
    }
  });

for (const mode of ['api', 'official'])
  test(`已有${mode}连接、语言和风格：直接生成计划，不重复询问`, async () => {
    const item = {
      id: 'settings',
      title: '模型配置',
      kind: 'settings',
      canInstall: true,
      facts: [{ code: mode === 'api' ? 'api-configured' : 'official-connection' }],
      hasCredential: mode === 'api',
      values: {
        mode,
        baseUrl: 'https://gateway.example.test',
        auth: 'token',
        language: 'English',
        outputStyle: 'Concise',
      },
    };
    let home = 0;
    const requests = [];
    await runTerminal(
      {
        inspect: async () => ({ items: [item], problems: [] }),
        plan: async request => {
          requests.push(request);
          return {
            id: 'reuse-settings',
            problem: null,
            items: [{ id: item.id, title: item.title, action: 'configure', changes: [], problem: null }],
          };
        },
        apply: async () => ({ state: 'done', items: [] }),
      },
      {
        wait: (_title, work) => work(new AbortController().signal),
        show() {},
        select: async (_page, change) => {
          change({ kind: 'all' });
          return 'submit';
        },
        choose: async title => {
          if (title === HOME_TITLE) return home++ ? 4 : 0;
          assert.ok(title.startsWith('变更预览') || title.startsWith('运行结果'), title);
          return 0;
        },
        form: async () => {
          throw new Error('已有配置不应重复询问');
        },
      },
    );
    assert.deepEqual(requests, [
      { task: 'install', selected: [{ id: 'settings', fields: { language: 'English', outputStyle: 'Concise' } }] },
    ]);
  });

test('移除入口说明数据范围，不使用卸载或括号文案', async () => {
  let home = 0;
  await runTerminal(
    {
      inspect: async () => ({
        items: [{ id: 'claude', title: 'Claude Code', kind: 'claude', facts: [], canUninstall: true }],
        problems: [],
      }),
    },
    {
      wait: (_title, work) => work(new AbortController().signal),
      choose: async title => (title === HOME_TITLE && home++ === 0 ? 2 : 4),
      select: async page => {
        assert.match(page.title, /移除程序/);
        assert.match(page.title, /保留会话记录和个人文件/);
        assert.doesNotMatch(page.title + page.submitLabel, /卸载|[（）()]/);
        return 'cancel';
      },
    },
  );
});
