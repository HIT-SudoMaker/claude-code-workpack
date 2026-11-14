import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createMachine } from '../dist/machine.js';
import { runTerminal } from '../dist/terminal.js';
import { createTerminal } from '../dist/terminal-view.js';
import { contentRow } from '../dist/render.js';
let cancelled = false;
const terminal = createTerminal(() => {
  cancelled = true;
});
const scenario = process.argv[2];
if (scenario === 'home' || scenario === 'narrow') {
  await runTerminal(
    {
      inspect: async () => ({ items: [], problems: [] }),
      apply: () => {
        throw new Error('unexpected apply');
      },
    },
    terminal,
  );
  await terminal.close();
  assert.equal(process.stdin.isRaw, false);
  console.log(scenario === 'home' ? 'HOME_DONE' : 'NARROW_DONE');
} else if (scenario === 'inspection') {
  const lines = [
    'FIRST_ENTRY',
    ...Array.from({ length: 30 }, (_, i) => `入口 ${i + 1}：已安装 /path/${i + 1}`),
    'LAST_ENTRY',
  ];
  await terminal.choose('检查状态\n' + lines.join('\n'), ['返回主菜单']);
  await terminal.close();
  console.log('INSPECTION_DONE');
} else if (scenario === 'selection') {
  const checked = new Set();
  const items = [
    ['claude', 'Claude Code'],
    ['settings', '模型配置'],
    ['plugin', 'GitHub'],
    ['plugin', 'Serena'],
    ['skill', 'SSRE2'],
    ['officecli', 'OfficeCLI'],
    ['ccline', 'CCometixLine'],
  ].map(([kind, title]) => ({ id: kind, kind, title, facts: [] }));
  const page = () => ({
    title: 'SELECTION',
    rows: items.map(contentRow).map((row, index) => ({
      ...row,
      checked: checked.has(index),
    })),
    submitLabel: checked.size === 0 ? 'EMPTY' : checked.size === 1 ? 'SINGLE' : 'ALL',
  });
  const result = await terminal.select(page(), event => {
    const indices = event.kind === 'all' ? items.map((_item, index) => index) : [event.index];
    const add = event.kind === 'all' && checked.size < items.length;
    for (const i of indices) {
      if (event.kind === 'all' ? add : !checked.has(i)) checked.add(i);
      else checked.delete(i);
    }
    return page();
  });
  assert.equal(result, 'submit');
  assert.deepEqual([...checked], [0, 1, 2, 3, 4, 5, 6]);
  await terminal.close();
  assert.equal(process.stdin.isRaw, false);
  console.log('SELECTION_DONE');
} else if (scenario === 'settings') {
  let planned = false;
  await runTerminal(
    {
      inspect: async () => ({
        items: [
          {
            id: 'settings',
            title: '模型配置',
            kind: 'settings',
            canInstall: true,
            facts: [{ code: 'api-configured' }],
            values: { language: 'Simplified Chinese', outputStyle: 'Explanatory' },
          },
        ],
        problems: [],
      }),
      plan: async request => {
        assert.deepEqual(request, { task: 'install', selected: [{ id: 'settings', fields: { language: 'English' } }] });
        planned = true;
        return {
          id: 'settings-plan',
          problem: null,
          items: [{ id: 'settings', title: '默认语言', action: 'configure', changes: [], problem: null }],
        };
      },
      apply: async () => {
        throw new Error('未确认时不应写入');
      },
    },
    terminal,
  );
  assert.equal(planned, true);
  await terminal.close();
  console.log('SETTINGS_DONE');
} else if (scenario === 'form') {
  const values = await terminal.form(
    'FORM_INPUT',
    [
      { key: 'name', label: 'NAME', value: '' },
      { key: 'secret', label: 'SECRET', value: '', secret: true },
    ],
    v => (v.name ? null : { message: 'NAME_REQUIRED', field: 'name' }),
  );
  assert.deepEqual(values, { name: '中文 name', secret: 'private-token' });
  await terminal.close();
  assert.equal(process.stdin.isRaw, false);
  console.log('FORM_DONE');
} else if (scenario === 'handoff') {
  assert.equal(await terminal.choose('HANDOFF_START', ['Start', 'Back']), 0);
  const machine = createMachine(process.env, process.cwd(), terminal.handoff);
  assert.equal((await machine.execute(process.execPath, ['-e', 'process.exit(0)'])).code, 0);
  assert.equal(process.stdin.isRaw, true, '非交互命令执行期间保留 TUI 输入');
  const result = await machine.execute(process.execPath, [fileURLToPath(import.meta.url), 'child'], {
    isInteractive: true,
  });
  assert.equal(result.code, 0);
  assert.equal(await terminal.choose('AFTER_CHILD', ['A', 'B']), 1);
  await terminal.close();
  assert.equal(process.stdin.isRaw, false);
  console.log('HANDOFF_DONE');
} else if (scenario === 'child') {
  const input = createInterface({ input: process.stdin });
  console.log('CHILD_READY');
  const value = await new Promise(resolve => input.once('line', resolve));
  assert.equal(value, 'hello');
  input.close();
  process.stdin.pause();
  console.log('CHILD_OK');
} else if (scenario === 'cancel') {
  assert.equal(await terminal.form('CANCEL_READY', [{ key: 'value', label: '文本', value: '' }], () => null), null);
  await terminal.close();
  assert.equal(cancelled, true);
  assert.equal(process.stdin.isRaw, false);
  console.log('RAW_RESTORED');
  process.exitCode = 130;
} else if (scenario === 'waiting') {
  const late = Promise.withResolvers();
  let aborted = false;
  assert.equal(
    await terminal.wait('WAIT_READY', signal => {
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
        },
        { once: true },
      );
      return late.promise;
    }),
    null,
  );
  assert.equal(aborted, true);
  late.reject(new Error('late inspection failure'));
  assert.equal(await terminal.choose('AFTER_WAIT', ['A', 'B']), 1);
  await terminal.close();
  assert.equal(process.stdin.isRaw, false);
  console.log('WAIT_DONE');
} else throw new Error('Unknown scenario');
