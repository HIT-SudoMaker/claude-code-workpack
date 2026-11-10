import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import stringWidth from 'string-width';

import { createMachine } from '../dist/machine.js';
import { createCcw } from '../dist/ccw.js';
import { runTerminal as run } from '../dist/terminal.js';
import { createTerminal } from '../dist/terminal-view.js';
import { createRunPresentation } from '../dist/run-presentation.js';

const runTerminal = (ccw, ...args) =>
  run({ recovery: async () => undefined, abandon: async () => {}, ...ccw }, ...args);

let cancelled = false;
const terminal = createTerminal(() => {
  cancelled = true;
});
const scenario = process.argv[2];
if (scenario === 'recovery' || scenario === 'recovery-unknown') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccw-terminal-recovery-')));
  const home = path.join(root, 'home');
  const claudeRoot = path.join(home, '.claude');
  const settingsFile = path.join(claudeRoot, 'settings.json');
  let approved = false;
  let previews = 0;
  let recoveryMenus = 0;
  const base = createMachine({}, root);
  const machine = {
    ...base,
    async editJson(file, edit) {
      if (file === settingsFile) assert.equal(approved, true, '恢复必须先经用户确认');
      return base.editJson(file, edit);
    },
  };
  const options = {
    machine,
    home,
    claudeRoot,
    cclineRoot: path.join(claudeRoot, 'ccline'),
    platform: process.platform,
  };
  try {
    await fs.mkdir(claudeRoot, { recursive: true });
    await fs.writeFile(settingsFile, JSON.stringify({ language: 'English', keep: true }));
    await createCcw(options).plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
    if (scenario === 'recovery-unknown')
      await fs.writeFile(settingsFile, JSON.stringify({ language: 'external value', keep: true }));
    const restarted = createCcw(options);
    await runTerminal(restarted, {
      ...terminal,
      async choose(title, ...args) {
        if (typeof title === 'string' && title.startsWith('未完成任务')) recoveryMenus++;
        const choice = await terminal.choose(title, ...args);
        if (typeof title === 'string' && title.startsWith('变更预览')) {
          previews++;
          assert.equal(JSON.parse(await fs.readFile(settingsFile, 'utf8')).language, 'English');
          if (choice === 0) approved = true;
        }
        return choice;
      },
    });
    await terminal.close();
    const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    assert.equal(settings.language, scenario === 'recovery' ? '中文' : 'external value');
    assert.equal(settings.keep, true);
    assert.equal(await restarted.recovery(), undefined);
    if (scenario === 'recovery') assert.equal(previews, 2, '返回修改后重新核对且再次预览');
    else assert.equal(recoveryMenus, 2, '重新检查从中央重新核对任务');
    assert.equal(process.stdin.isRaw, false);
    console.log(scenario === 'recovery' ? 'RECOVERY_DONE' : 'RECOVERY_UNKNOWN_DONE');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
} else if (scenario === 'cleanup') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccw-terminal-cleanup-')));
  const home = path.join(root, 'home');
  const claudeRoot = path.join(home, '.claude');
  const files = [
    'debug/a.log',
    'projects/p/tool-results/result.txt',
    'projects/p/memory/MEMORY.md',
    'backups/settings.json',
    'jobs/pending.json',
    'daemon/dispatch/task.json',
    'daemon.lock',
    'sessions/session.json',
    'shell-snapshots/shell.sh',
    'usage-data/stats.json',
    'stats-cache.json',
  ];
  const kept = ['settings.json', '.credentials.json', 'skills/test/SKILL.md'];
  try {
    for (const relative of [...files, ...kept]) {
      const file = path.join(claudeRoot, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, relative);
    }
    await runTerminal(
      createCcw({
        machine: { ...createMachine({}, root), processes: async () => [] },
        home,
        claudeRoot,
        cclineRoot: path.join(claudeRoot, 'ccline'),
        platform: process.platform,
      }),
      terminal,
    );
    await terminal.close();
    for (const relative of files)
      assert.equal(
        await fs.stat(path.join(claudeRoot, relative)).then(
          () => true,
          () => false,
        ),
        false,
        relative,
      );
    for (const relative of kept) assert.equal(await fs.readFile(path.join(claudeRoot, relative), 'utf8'), relative);
    assert.equal(process.stdin.isRaw, false);
    console.log('CLEANUP_DONE');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
} else if (scenario === 'uninstall' || scenario === 'uninstall-data') {
  const removeData = scenario === 'uninstall-data';
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccw-terminal-removal-')));
  const home = path.join(root, 'home');
  const claudeRoot = path.join(home, '.claude');
  const cclineRoot = path.join(claudeRoot, 'ccline');
  const npmRoot = path.join(root, 'npm/node_modules');
  const claudeBinary = path.join(npmRoot, '@anthropic-ai/claude-code/cli.js');
  const cclineBinary = path.join(cclineRoot, process.platform === 'win32' ? 'ccline.exe' : 'ccline');
  const settings = path.join(claudeRoot, 'settings.json');
  const stateFile = path.join(home, '.claude.json');
  const outsideDocument = path.join(home, 'Documents', 'keep.txt');
  const packages = new Map([
    ['@anthropic-ai/claude-code', '2.1.311'],
    ['@cometix/ccline', '2.0.1'],
  ]);
  const write = async (file, text) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  const ok = (stdout = '') => ({ code: 0, failed: false, stdout });
  try {
    await write(claudeBinary, 'isolated Claude program');
    await write(
      path.join(npmRoot, '@anthropic-ai/claude-code/package.json'),
      JSON.stringify({ bin: { claude: 'cli.js' } }),
    );
    await write(cclineBinary, 'isolated CCometixLine program');
    await write(path.join(cclineRoot, 'config.toml'), 'version = 2\n');
    await write(settings, JSON.stringify({ statusLine: { type: 'command', command: 'ccline' }, language: '保留' }));
    await write(stateFile, JSON.stringify({ oauthAccount: { accountUuid: 'fixture' } }));
    await write(outsideDocument, 'outside Claude data');
    const machine = {
      ...createMachine({}, root),
      locate: async () => [],
      processes: async () => [],
      async execute(binary, args) {
        assert.equal(binary, cclineBinary);
        assert.deepEqual(args, ['--version']);
        return ok('ccline 2.0.1');
      },
      async npm(args) {
        if (args[0] === 'root') return ok(npmRoot);
        if (args[0] === 'ls') {
          const name = args.at(-1);
          return ok(
            JSON.stringify({ dependencies: packages.has(name) ? { [name]: { version: packages.get(name) } } : {} }),
          );
        }
        assert.equal(args[0], 'uninstall');
        assert.equal(args.at(-1), '@anthropic-ai/claude-code');
        packages.delete(args.at(-1));
        await fs.rm(path.join(npmRoot, args.at(-1)), { recursive: true });
        return ok();
      },
    };
    await runTerminal(createCcw({ machine, home, claudeRoot, cclineRoot, platform: process.platform }), terminal);
    await terminal.close();
    assert.equal(
      await fs.stat(claudeBinary).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(packages.has('@cometix/ccline'), true);
    assert.equal(await fs.readFile(outsideDocument, 'utf8'), 'outside Claude data');
    if (removeData) {
      assert.equal(
        await fs.stat(claudeRoot).then(
          () => true,
          () => false,
        ),
        false,
      );
      assert.equal(
        await fs.stat(stateFile).then(
          () => true,
          () => false,
        ),
        false,
      );
    } else {
      assert.equal(await fs.readFile(cclineBinary, 'utf8'), 'isolated CCometixLine program');
      assert.equal(await fs.readFile(path.join(cclineRoot, 'config.toml'), 'utf8'), 'version = 2\n');
      assert.deepEqual(JSON.parse(await fs.readFile(settings, 'utf8')), { language: '保留' });
      assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), { oauthAccount: { accountUuid: 'fixture' } });
    }
    assert.equal(process.stdin.isRaw, false);
    console.log(removeData ? 'UNINSTALL_DATA_DONE' : 'UNINSTALL_DONE');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
} else if (scenario === 'skills-cancel') {
  let planRequest;
  let planAborted = false;
  let applications = 0;
  const item = {
    id: 'skill-set:ssre2',
    title: 'HIT-SudoMaker/SSRE2',
    kind: 'skill',
    canInstall: true,
    facts: [{ code: 'not-installed' }],
    actions: ['install'],
  };
  await runTerminal(
    {
      async inspect() {
        return { items: [item], problems: [] };
      },
      async plan(request, signal, progress) {
        planRequest = request;
        assert.ok(signal);
        for (const stage of ['inspect', 'metadata', 'source'])
          await progress?.({ id: item.id, title: item.title, stage });
        return new Promise((_resolve, reject) => {
          const cancel = () => {
            planAborted = signal.aborted;
            reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled'));
          };
          if (signal.aborted) cancel();
          else signal.addEventListener('abort', cancel, { once: true });
        });
      },
      async apply() {
        applications++;
        assert.fail('cancelled preparation must not apply');
      },
    },
    terminal,
  );
  await terminal.close();
  assert.deepEqual(planRequest, {
    task: 'install',
    selected: [{ id: item.id }],
  });
  assert.equal(planAborted, true);
  assert.equal(applications, 0);
  assert.equal(process.stdin.isRaw, false);
  console.log('SKILLS_CANCEL_DONE');
} else if (scenario === 'settings' || scenario === 'selection') {
  let output = '';
  let planned;
  let applications = 0;
  let inspections = 0;
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    output += String(chunk);
    return write(chunk, ...args);
  };
  const items = (
    scenario === 'selection'
      ? [
          { id: 'plugin:code-simplifier', title: 'Code Simplifier', kind: 'plugin' },
          { id: 'plugin:github@official', title: 'GitHub', kind: 'plugin' },
          { id: 'mcp:context7', title: 'Context7', kind: 'mcp' },
          { id: 'officecli', title: 'OfficeCLI', kind: 'officecli' },
        ]
      : [
          { id: 'claude', title: 'Claude Code', kind: 'claude' },
          { id: 'settings', title: '模型配置', kind: 'settings', actions: ['configure'], values: {} },
          { id: 'plugin:code-simplifier', title: 'Code Simplifier', kind: 'plugin' },
          { id: 'mcp:context7', title: 'Context7', kind: 'mcp' },
          { id: 'skill-set:ssre2', title: 'HIT-SudoMaker/SSRE2', kind: 'skill' },
          { id: 'ccline', title: 'CCometixLine', kind: 'ccline' },
          { id: 'officecli', title: 'OfficeCLI', kind: 'officecli' },
        ]
  ).map(item => ({ facts: [], canInstall: true, actions: ['install'], ...item }));
  await runTerminal(
    {
      async inspect() {
        inspections++;
        return { items, problems: [] };
      },
      async plan({ selected: selections }) {
        assert.equal(planned, undefined);
        planned = selections;
        if (scenario === 'selection') await new Promise(resolve => setTimeout(resolve, 100));
        return {
          id: 'installation',
          problem: null,
          items: selections.map(selection => ({
            id: selection.id,
            title: items.find(entry => entry.id === selection.id)?.title ?? selection.id,
            action: 'install',
            changes: [],
            problem: null,
          })),
        };
      },
      async apply(id) {
        assert.equal(id, 'installation');
        applications++;
        return { state: 'done', items: planned.map(selection => ({ id: selection.id, state: 'done', effects: [] })) };
      },
    },
    terminal,
  );
  await terminal.close();
  process.stdout.write = write;
  assert.equal(applications, 1, '连续提交只执行一次');
  assert.equal(process.stdin.isRaw, false);
  assert.equal(output.includes('变更预览'), true);
  assert.equal(output.includes('fixture-settings-key'), false);
  const text = stripVTControlCharacters(output);
  if (scenario === 'settings') {
    assert.doesNotMatch(text, /CCW · Base URL|CCW · API Key|CCW · Default Model/);
    assert.deepEqual(planned, [
      {
        id: 'settings',
        fields: {
          mode: 'api',
          auth: 'key',
          baseUrl: 'https://gateway.example.test',
          secret: 'fixture-settings-key',
          model: 'gateway[1m]',
          language: 'English',
          outputStyle: 'Learning',
        },
      },
    ]);
    assert.equal(inspections, 1);
    assert.match(text, /开始安装（1 项）/);
    for (const group of ['基础配置', 'Plugins', 'MCPs', 'Skills', '附加工具']) {
      const heading = text.match(new RegExp(`── ${group} ─+`))?.[0];
      assert.ok(heading, `缺少分组 ${group}`);
      assert.equal(stringWidth(heading), 60, `${group} 分组横线宽度，不含两列缩进`);
    }
  } else {
    assert.deepEqual(planned, [
      { id: 'plugin:code-simplifier' },
      { id: 'plugin:github@official' },
      { id: 'mcp:context7' },
      { id: 'officecli' },
    ]);
    assert.equal(inspections, 2, '勾选不重查，主动刷新重新检查');
    assert.doesNotMatch(text, /GitHub Token|Context7 API Key|OfficeCLI 接入方式/);
    assert.match(text, /4 项）/);
  }
  console.log(scenario === 'settings' ? 'SETTINGS_DONE' : 'SELECTION_DONE');
} else if (scenario === 'brand') {
  let inspections = 0;
  const ccw = {
    async inspect() {
      inspections++;
      return {
        items: [
          {
            id: 'ccline',
            title: 'CCometixLine',
            kind: 'ccline',
            canInstall: true,
            facts: [{ code: 'not-installed' }],
            actions: ['install'],
          },
        ],
        problems: [],
      };
    },
    async plan() {
      throw new Error('Unexpected write preparation');
    },
    async apply() {
      throw new Error('Unexpected write');
    },
  };
  await runTerminal(ccw, terminal);
  await terminal.close();
  assert.equal(inspections, 2, '安装与检查各读取一次，详情返回不重查');
  assert.equal(process.stdin.isRaw, false);
  console.log('BRAND_DONE');
} else if (scenario === 'form-details') {
  let output = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    output += String(chunk);
    return write(chunk, ...args);
  };
  let attempts = 0;
  const paginationDetail = [
    '保存配置失败：地址需使用 HTTP 或 HTTPS',
    '代码：fixture-detail-code',
    ...Array.from({ length: 9 }, (_, index) => `NOTE_${String(index + 3).padStart(2, '0')}`),
    'DETAIL_LAST_LINE_12',
  ].join('\n');
  const result = await terminal.form('DETAIL_FORM', [{ key: 'baseUrl', label: '地址', value: '' }], form => {
    attempts++;
    if (!form.baseUrl) return { message: '请填写地址', field: 'baseUrl', detail: '保存配置失败：缺少 Base URL' };
    if (form.baseUrl !== 'https://fixture.example')
      return { message: '地址无效', field: 'baseUrl', detail: paginationDetail };
    return null;
  });
  await terminal.close();
  process.stdout.write = write;
  const text = stripVTControlCharacters(output);
  assert.deepEqual(result, { baseUrl: 'https://fixture.example' }, '详情往返后草稿保留，改写后提交');
  assert.equal(attempts, 3);
  assert.match(text, /! 请填写地址/);
  assert.match(text, /! 地址无效/);
  assert.match(text, /填写说明/);
  assert.match(text, /保存配置失败：地址需使用 HTTP 或 HTTPS/);
  assert.match(text, /代码：fixture-detail-code/);
  assert.match(text, /DETAIL_LAST_LINE_12/);
  assert.equal(process.stdin.isRaw, false);
  console.log('FORM_DETAILS_DONE');
} else if (scenario === 'form') {
  assert.deepEqual(await terminal.form('FORM_INPUT', [{ key: 'value', label: '文本', value: 'ab' }], () => null), {
    value: 'a中',
  });
  assert.deepEqual(
    await terminal.form('SECRET_INPUT', [{ key: 'value', label: '密钥', value: '', secret: true }], () => null),
    { value: 'fixture-secret' },
  );
  const selected = new Set();
  const page = () => ({
    title: 'BATCH_SELECT',
    submitLabel: '提交',
    rows: Array.from({ length: 40 }, (_, index) => ({
      label: `Item ${index}`,
      group: '',
      checked: selected.has(index),
      enter: 'toggle',
    })),
  });
  const selection = await terminal.select(page(), event => {
    if (event.kind === 'all') {
      if (selected.size === 40) selected.clear();
      else for (let index = 0; index < 40; index++) selected.add(index);
    } else if (selected.has(event.index)) selected.delete(event.index);
    else selected.add(event.index);
    return page();
  });
  assert.deepEqual(selection, { kind: 'submit', index: 40 });
  assert.deepEqual(
    [...selected].sort((a, b) => a - b),
    Array.from({ length: 39 }, (_, index) => index + 1),
  );
  assert.equal(
    await terminal.choose(
      ['LONG_PREVIEW', ...Array.from({ length: 51 }, (_, index) => `line-${index}`)].join('\n'),
      ['Apply', 'Back'],
      1,
    ),
    1,
  );
  await terminal.close();
  assert.equal(process.stdin.isRaw, false);
  console.log('FORM_DONE');
} else if (scenario === 'progress' || scenario === 'progress-narrow') {
  let output = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    output += String(chunk);
    return write(chunk, ...args);
  };
  assert.equal(await terminal.choose('PROGRESS_START', ['Start']), 0);
  const items = Array.from({ length: 24 }, (_, index) => ({
    id: String(index),
    state: index === 23 ? 'running' : index === 0 ? 'failed' : index === 1 ? 'failed' : 'done',
    effects:
      index === 0
        ? [{ state: 'failed', code: 'npm-install-failed' }]
        : index === 1
          ? [{ state: 'skipped', code: 'dependency-not-ready' }]
          : [],
  }));
  const names = new Map(items.map((item, index) => [item.id, `Entry ${String(index + 1).padStart(2, '0')}`]));
  const presentation = createRunPresentation({
    items: items.map(item => ({ id: item.id, title: names.get(item.id) })),
  });
  for (const item of items) {
    presentation.progress(
      item.state === 'running' ? { kind: 'started', id: item.id } : { kind: 'finished', id: item.id, result: item },
    );
  }
  terminal.show(presentation.progress());
  await createMachine(process.env, process.cwd(), terminal.handoff).execute(process.execPath, [
    '-e',
    'setTimeout(() => {}, 2000)',
  ]);
  assert.equal(process.stdin.isRaw, true);
  assert.equal(output.includes('\x1b[?1049l'), false, '执行期间不退出 TUI 备用屏幕');
  const results = items.map(item =>
    item.state === 'running'
      ? { id: item.id, state: 'cancelled', effects: [{ state: 'skipped', code: 'cancelled' }] }
      : item,
  );
  assert.equal(await terminal.choose(presentation.result({ state: 'partial', items: results }), ['Return']), 0);
  await terminal.close();
  process.stdout.write = write;
  const text = stripVTControlCharacters(output);
  if (scenario === 'progress') {
    assert.match(text, /✕ 操作失败 {2}Entry 01/);
    assert.match(text, /○ 已跳过 {4}Entry 02/);
    assert.match(text, /○ 已停止 {4}Entry 24/);
  } else {
    assert.match(text, /✕ 操作失败 {2}Entry 01/);
    assert.match(text, /○ 已跳过 {2}Entry 02/);
    assert.match(text, /○ 已停止 {2}Entry 24/);
  }
  assert.equal(process.stdin.isRaw, false);
  console.log(scenario === 'progress' ? 'PROGRESS_DONE' : 'PROGRESS_NARROW_DONE');
} else if (scenario === 'multiline-result') {
  let output = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    output += String(chunk);
    return write(chunk, ...args);
  };
  const presentation = createRunPresentation({ items: [{ id: 'program', title: 'PROGRAM\nMULTILINE' }] });
  const details = Array.from({ length: 30 }, (_, index) =>
    index === 29 ? 'LAST_COPY_30' : `COPY_${String(index + 1).padStart(2, '0')}`,
  ).join('\n');
  const result = presentation.details(
    {
      state: 'done',
      items: [
        {
          id: 'program',
          state: 'done',
          effects: [{ state: 'kept', code: 'program-other-copies-kept', detail: details }],
        },
      ],
    },
    'program',
  );
  assert.equal(await terminal.choose(result, ['RESULT_RETURN']), 0);
  await terminal.close();
  process.stdout.write = write;
  const text = stripVTControlCharacters(output);
  assert.match(text, /PROGRAM MULTILINE/);
  assert.match(text, /COPY_01/);
  assert.match(text, /LAST_COPY_30/);
  assert.equal(process.stdin.isRaw, false);
  console.log('MULTILINE_RESULT_DONE');
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
} else if (scenario === 'render') {
  let fullPaints = 0;
  let outputBytes = 0;
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    fullPaints += String(chunk).split('\x1b[2J').length - 1;
    outputBytes += Buffer.byteLength(chunk);
    return write(chunk, ...args);
  };
  const index = await terminal.choose(
    'RENDER_READY',
    Array.from({ length: 500 }, (_, index) => `检查项 ${index}`),
  );
  await terminal.close();
  process.stdout.write = write;
  assert.equal(index, 10);
  assert.ok(fullPaints <= 2, `移动选择不清屏重画：${fullPaints} 次清屏`);
  assert.ok(outputBytes < 6_000, `10 次移动输出过多：${outputBytes} bytes`);
  console.log(`RENDER_DONE bytes=${outputBytes}`);
} else throw new Error('Unknown scenario');
