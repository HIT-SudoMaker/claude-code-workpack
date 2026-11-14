import { createRequire } from 'node:module';
import stringWidth from 'string-width';
import { MESSAGES } from './messages.js';
import { isObject } from './machine.js';
import type {
  Action,
  Change,
  Effect,
  Inspection,
  Item,
  ItemResult,
  Kind,
  Plan,
  PlanItem,
  PreparationProgress,
  Progress,
  Request,
  RunResult,
} from './model.js';

const FIRST_PRINTABLE_ASCII_CODE = 0x20;
const ASCII_DELETE_CODE = 0x7f;

/** 菜单行的标签与可选补充说明 */
export interface MenuRow {
  readonly label: string;
  readonly detail?: string;
  readonly group?: string;
}

type RunState = ItemResult['state'] | 'waiting' | 'running';

interface RunRow {
  readonly symbol: string;
  readonly status: string;
  readonly title: string;
  readonly titleWidth?: number;
  /** 不改变项目状态的附加提示 */
  readonly notice?: string;
}

/** 执行进度与最终结果共用的终端视图 */
export interface RunView {
  readonly title: string;
  readonly summary: string;
  readonly rows: readonly RunRow[];
}

interface ExecutionItem {
  readonly id: string;
  readonly title: string;
  readonly action?: Action;
  readonly state: ItemResult['state'] | 'waiting' | 'running';
  readonly effects: readonly Effect[];
}

const manifest: unknown = createRequire(import.meta.url)('../package.json');

const packageVersion = isObject(manifest) && typeof manifest.version === 'string' ? manifest.version : '';

/** 从包清单取得的终端品牌与版本 */
export const BRAND = {
  title: 'Claude Code Workpack',
  versionNumber: packageVersion,
  credit: 'Designed By AMIRC',
  logo: [
    ' ██████╗  ██████╗  ██╗    ██╗',
    '██╔════╝ ██╔════╝ ██║    ██║',
    '██║      ██║      ██║ █╗ ██║',
    '██║      ██║      ██║███╗██║',
    '╚██████╗ ╚██████╗ ╚███╔███╔╝',
    ' ╚═════╝  ╚═════╝  ╚══╝╚══╝',
  ],
};

/** 命令行帮助正文 */
export const HELP_TEXT = `CCW ${BRAND.versionNumber}\n无参数：打开菜单\n--inspect：检查状态\n--version：查看版本\n--help：查看帮助\n--details：显示诊断代码与检查明细\n安装配置、移除程序、清理数据：选择后预览确认\n检查状态：只读查看\n`;

/** 主菜单显示标题 */
export const HOME_TITLE = 'CCW ' + BRAND.versionNumber;

/** 返回主菜单的共用选项文案 */
export const BACK_TO_HOME = '返回主菜单';

const ACTION_NAMES: Readonly<Record<Action, string>> = {
  install: '安装',
  update: '更新',
  configure: '配置',
  detach: '解除接入',
  uninstall: '移除程序',
  clean: '清理',
};

/** 模型配置表单的字段键与显示顺序 */
export const MODEL_FIELDS = [
  { key: 'model', label: '默认模型' },
  { key: 'opus', label: 'Opus' },
  { key: 'sonnet', label: 'Sonnet' },
  { key: 'haiku', label: 'Haiku' },
] as const;

/** 配置表单在缺少已有值时采用的偏好 */
export const DEFAULT_PREFERENCES = { language: 'Simplified Chinese', outputStyle: 'Explanatory' } as const;

/** 模型连接、语言和风格分别编辑，计划阶段仍合并为同一配置对象 */
export const SETTINGS_EDITORS = ['connection', 'language', 'outputStyle'] as const;
export type SettingsEditor = (typeof SETTINGS_EDITORS)[number];

/** 语言和风格选择的显示标签与实际配置值 */
export const SETTINGS_LANGUAGES = [
  { value: 'Simplified Chinese', label: '中文' },
  { value: 'English', label: '英文' },
] as const;
export const SETTINGS_STYLES = [
  { value: 'Default', label: '默认型 · Default' },
  { value: 'Proactive', label: '主动型 · Proactive' },
  { value: 'Concise', label: '简洁型 · Concise' },
  { value: 'Explanatory', label: '解释型 · Explanatory' },
  { value: 'Learning', label: '学习型 · Learning' },
] as const;

const INDICATORS: Readonly<Record<RunState, Pick<RunRow, 'symbol' | 'status'>>> = {
  waiting: { symbol: '·', status: '等待' },
  running: { symbol: '▶', status: '执行中' },
  done: { symbol: '✔', status: '完成' },
  partial: { symbol: '!', status: '部分完成' },
  failed: { symbol: '✕', status: '失败' },
  skipped: { symbol: '○', status: '已跳过' },
  cancelled: { symbol: '○', status: '已停止' },
};

const GROUPS: Readonly<Record<Kind, string>> = {
  claude: '基础配置',
  settings: '基础配置',
  plugin: 'Plugins',
  skill: 'Skills',
  officecli: '附加工具',
  ccline: '附加工具',
  data: '清理数据',
};

/** 按终端菜单的类别顺序返回新数组，不修改输入 */
export function contentOrder(items: readonly Item[]) {
  const order: Kind[] = ['claude', 'settings', 'plugin', 'skill', 'officecli', 'ccline', 'data'];
  return [...items].sort((left, right) => order.indexOf(left.kind) - order.indexOf(right.kind));
}

/** 生成包含名称与简短状态的菜单行 */
export function contentRow(item: Item): MenuRow {
  return { label: contentName(item), detail: shortStatus(item), group: GROUPS[item.kind] };
}

/** 按当前值和本次草稿显示独立设置入口，不读取或写入配置 */
export function settingsRow(item: Item, editor: SettingsEditor, fields?: Readonly<Record<string, string>>): MenuRow {
  const values = { ...item.values, ...fields };
  if (editor === 'connection')
    return {
      label: '模型配置',
      group: GROUPS.settings,
      detail: item.problem
        ? reason(item.problem)
        : effectiveConnection(values, item.facts) === 'api'
          ? '第三方 API'
          : '官方登录',
    };
  const choices = editor === 'language' ? SETTINGS_LANGUAGES : SETTINGS_STYLES;
  const value = values[editor] ?? DEFAULT_PREFERENCES[editor];
  return {
    label: editor === 'language' ? '默认语言' : '输出风格',
    group: GROUPS.settings,
    detail: item.problem
      ? reason(item.problem)
      : (choices.find(choice => choice.value === value)?.label ?? safeText(value)),
  };
}

/**
 * 汇总检查条目和检查问题的显示文本
 *
 * @param details - 为 true 时附带事实诊断代码；输入详情必须已脱敏
 */
export function describeInspection(view: Inspection, details = false) {
  const lines: string[] = [];
  const groups = new Map<string, Item[]>();
  for (const item of contentOrder(view.items)) {
    if (
      !details &&
      item.id.startsWith('skill-set:') &&
      !item.problem &&
      item.facts.some(fact => fact.code === 'skill-members-present')
    )
      continue;
    if (!details && item.launcherFor && view.items.some(parent => parent.id === item.launcherFor)) continue;
    const group = GROUPS[item.kind];
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  for (const [group, items] of groups) {
    lines.push((lines.length ? '\n' : '') + '── ' + group);
    const nameWidth = Math.max(...items.map(item => stringWidth(contentName(item))));
    const commonPath =
      !details && items.every(item => item.kind === 'plugin' && item.location === items[0]?.location)
        ? items[0]?.location
        : undefined;
    if (commonPath) lines.push('  路径：' + safeText(commonPath));
    for (const item of items) lines.push(describeItem(item, nameWidth, details, commonPath));
  }
  if (!view.items.length) lines.push('未发现可展示的项目');
  if (view.problems.length)
    lines.push('\n── 检查未完成', ...view.problems.map(change => describeChange(change, details)));
  return lines.join('\n');
}

/** 优先采用表单中的显式连接模式，否则从已有配置事实推断初始选项 */
export function effectiveConnection(values: Readonly<Record<string, string>>, facts: readonly Change[]) {
  return values.mode === 'api' || (values.mode !== 'official' && facts.some(fact => fact.code === 'api-configured'))
    ? 'api'
    : 'official';
}

/** 生成当前准备对象的进度文案 */
export function describePreparation(event: PreparationProgress) {
  return '准备：' + contentName(event);
}

/** 按产品类别展示计划，详细模式展开执行步骤 */
export function describePlan(plan: Plan, details = false) {
  const counts = new Map<string, number>();
  for (const item of plan.items) {
    const action = item.problem ? '不可执行' : planVerb(item);
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  const lines = [
    '共 ' + plan.items.length + ' 项' + [...counts].map(([label, count]) => ` · ${label} ${count}`).join(''),
  ];
  const groups = new Map<string, PlanItem[]>();
  for (const item of plan.items) {
    const kind = item.id.split(':')[0];
    const group =
      kind === 'skill-set' ? GROUPS.skill : (Object.entries(GROUPS).find(([key]) => key === kind)?.[1] ?? '其他');
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  const actionWidth = Math.max(0, ...plan.items.map(item => stringWidth(planVerb(item))));
  const nameWidth = Math.max(0, ...plan.items.map(item => stringWidth(contentName(item))));
  for (const [group, items] of groups) {
    lines.push('', '── ' + group);
    const settingsPaths = new Set<string>();
    const dataPaths = new Set<string>();
    for (const item of items) {
      const action = planVerb(item);
      const name = contentName(item).replaceAll('\n', ' ');
      const version =
        item.id === 'claude'
          ? item.changes.find(change => ['program-install', 'program-update'].includes(change.code))?.detail
          : undefined;
      const suffix = item.problem
        ? '无法执行：' + reason(item.problem)
        : version && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)
          ? version
          : '';
      lines.push(
        '  ' +
          action +
          ' '.repeat(actionWidth - stringWidth(action) + 2) +
          name +
          (suffix ? ' '.repeat(nameWidth - stringWidth(name) + 2) + suffix : ''),
      );
      if (details) {
        if (item.problem) lines.push('    ' + describeChange({ code: item.problem }, true).replaceAll('\n', '\n    '));
        else
          for (const change of item.changes)
            lines.push('    ' + describeChange(change, true).replaceAll('\n', '\n    '));
      } else if (!item.problem) {
        for (const change of item.changes) {
          if (change.code === 'settings-edit' && change.detail) settingsPaths.add(change.detail);
          if (change.code === 'skills-refresh') lines.push('    清理此来源的旧技能并重新安装');
          if (change.code === 'login-browser') lines.push('    打开浏览器完成登录');
          if (change.code === 'data-delete') lines.push('    ' + describeChange(change));
          if (change.code === 'data-links-kept') lines.push('    ' + describeChange(change));
          if (change.code === 'data-root' && change.detail) dataPaths.add(change.detail);
        }
      }
    }
    if (!details) {
      for (const directory of dataPaths) lines.push('  清理目录：' + safeText(directory));
      if (items.some(item => item.changes.some(change => change.code === 'data-permanent')))
        lines.push('  永久删除所选数据，保留程序、配置与凭据');
      for (const file of settingsPaths) lines.push('  配置文件：' + safeText(file));
      if (items.some(item => !item.problem && item.changes.some(change => change.code === 'new-session-required')))
        lines.push('  新会话或重新加载后生效');
      if (
        items.some(item => item.action === 'uninstall' && item.changes.some(change => change.code === 'keep-user-data'))
      )
        lines.push('  保留会话记录和个人文件');
    }
  }
  if (plan.problem) lines.push('', describeChange({ code: plan.problem }, details));
  return lines.join('\n');
}

/**
 * 将计划、进度事件和最终结果转换为执行视图
 *
 * @param task - 整批失败时的任务名称，省略时显示通用失败文案
 * @param details - 显示原因码，不改变执行状态
 * @returns 仅更新内存的视图生成器，保留计划中的条目标题
 */
export function createRunPresentation(
  plan: { readonly items: readonly PlanItem[] },
  task?: Request['task'],
  details = false,
) {
  const execution = new Map<string, ExecutionItem>(
    plan.items.map(item => [
      item.id,
      { id: item.id, title: item.title, action: item.action, state: 'waiting', effects: [] },
    ]),
  );
  const items = () => [...execution.values()];
  const recordResult = (result: RunResult) => {
    for (const item of result.items) {
      const previous = execution.get(item.id);
      execution.set(item.id, {
        ...previous,
        ...item,
        title: previous?.title ?? item.title,
      });
    }
  };
  return {
    /** 记录已知条目的事件并返回当前视图；省略事件只读取视图 */
    progress(event?: Progress): RunView {
      if (event) {
        const previous = execution.get(event.id);
        if (previous) {
          execution.set(
            event.id,
            event.kind === 'finished' || event.kind === 'checked'
              ? { ...previous, ...event.result, title: previous.title }
              : event.kind === 'started'
                ? { ...previous, state: 'running' }
                : { ...previous, effects: [...previous.effects, event.effect] },
          );
        }
      }
      return progressView(items(), details);
    },
    /** 合入最终条目结果并返回结果视图 */
    result(result: RunResult): RunView {
      recordResult(result);
      return resultView(result, items(), details, task);
    },
  };
}

/** 将执行视图转换为标题、汇总和状态行组成的多行文本 */
export function describeRun(view: RunView) {
  return [view.title, view.summary, ...view.rows.map(statusLine)].filter(Boolean).join('\n');
}

/** 生成启动失败文案，details 决定是否附带诊断码 */
export function startupFailure(code: string, details: boolean) {
  return 'CCW 启动失败：' + describeChange({ code }, details);
}

function describeItem(item: Item, nameWidth: number, details: boolean, commonPath?: string) {
  const facts = item.facts;
  const values = item.values ?? {};
  const information: [string, string][] = [];
  if (item.kind === 'ccline')
    information.push(['状态栏', facts.some(fact => fact.code === 'connected') ? '已配置' : '未配置']);
  if (item.kind === 'settings' && !item.problem) {
    for (const { key, label } of MODEL_FIELDS) if (values[key]) information.push([label, values[key]]);
    if (values.language) information.push(['默认语言', values.language]);
    if (values.outputStyle) information.push(['输出风格', values.outputStyle]);
  }
  if (item.location && item.location !== commonPath) information.push(['路径', item.location]);
  const labelWidth = Math.max(0, ...information.map(([label]) => stringWidth(label)));
  const name = contentName(item);
  return [
    name +
      ' '.repeat(nameWidth - stringWidth(name)) +
      '：' +
      (item.problem ? describeChange({ code: item.problem }, details) : shortStatus(item)),
    ...information.map(
      ([label, value]) => '  ' + label + ' '.repeat(labelWidth - stringWidth(label)) + '：' + safeText(value),
    ),
    ...(details ? facts.map(change => '  ' + describeChange(change, true).replaceAll('\n', '\n  ')) : []),
  ].join('\n');
}

function shortStatus(item: Item) {
  if (item.problem) return reason(item.problem);
  if (item.launcherFor) return 'npm 启动脚本';
  const has = (code: string) => item.facts.some(fact => fact.code === code);
  if (item.kind === 'data') return item.facts.find(fact => fact.code === 'data-size')?.detail ?? '暂无数据';
  if (has('program-missing')) return '程序入口缺失';
  if (item.kind === 'settings') return has('api-configured') ? '第三方 API' : '官方连接';
  if (item.kind === 'plugin')
    return has('plugin-installed') ? (has('declared-disabled') ? '已停用' : '已安装') : '未安装';
  const version = item.kind === 'claude' ? item.facts.find(fact => fact.code === 'program-version')?.detail : undefined;
  if (has('entry-exists') || has('program-exists'))
    return '已安装' + (version ? ' ' + version : '') + (has('external-program-preserved') ? ' · 仅查看' : '');
  return has('skill-members-present') ? '已安装' : '未安装';
}

function progressView(items: readonly ExecutionItem[], details: boolean): RunView {
  return {
    title: '执行进度',
    summary: executionSummary(items),
    rows: executionRows(items, details),
  };
}

function resultView(
  result: RunResult,
  items: readonly ExecutionItem[],
  details: boolean,
  task?: Request['task'],
): RunView {
  return {
    title: '运行结果 · ' + (result.state === 'failed' ? failureLabel(task) : INDICATORS[result.state].status),
    summary: executionSummary(items),
    rows: executionRows(items, details),
  };
}

function executionSummary(items: readonly ExecutionItem[]) {
  const states = items.map(item => item.state);
  const count = (state: RunState) => states.filter(value => value === state).length;
  const processed = states.length - count('waiting') - count('running');
  return `处理 ${processed}/${items.length} · 完成 ${count('done')} · 失败 ${count('failed') + count('partial')} · 跳过 ${count('skipped')}${count('cancelled') ? ` · 已停止 ${count('cancelled')}` : ''}`;
}

function executionRows(items: readonly ExecutionItem[], details: boolean): RunRow[] {
  const titleWidth = Math.max(0, ...items.map(item => stringWidth(contentName(item))));
  return items.map(item => {
    const state = item.state;
    const indicator = INDICATORS[state];
    const problem = ['failed', 'partial', 'skipped'].includes(state)
      ? ([...item.effects].reverse().find(effect => effect.state === 'failed') ??
        item.effects.find(effect => effect.state === 'skipped'))
      : undefined;
    const status = state === 'failed' ? failureLabel(item.action) : indicator.status;
    const notice = item.effects.find(
      effect => effect.state === 'kept' && effect.code === 'source-metadata-unavailable',
    );
    return {
      title: contentName(item),
      titleWidth,
      ...indicator,
      status: problem ? `${status}：${describeChange({ code: problem.code }, details)}` : status,
      ...(notice ? { notice: describeChange({ code: notice.code }, details) } : {}),
    };
  });
}

/** 交互执行视图与纯文本输出共用的状态行格式 */
export const statusLine = (row: RunRow) =>
  `${row.symbol} ${safeText(row.title).replaceAll('\n', ' ')}${' '.repeat(Math.max(0, (row.titleWidth ?? stringWidth(row.title)) - stringWidth(row.title)) + 2)}${row.status.replaceAll('\n', '\n  ')}` +
  (row.notice ? '\n  提示：' + row.notice.replaceAll('\n', '\n  ') : '');

/**
 * 拼接变更说明与可选详情
 *
 * @param change - 详情必须已适合公开显示，不得携带凭据
 * @param details - 为 true 时附带原因码；非法原因码使用通用失败码
 */
export function describeChange(change: Change, details = false) {
  const code = /^[a-zA-Z][a-zA-Z0-9-]{0,79}$/.test(change.code) ? change.code : 'operation-failed';
  const text = reason(code) + (change.detail ? '：' + safeText(change.detail) : '');
  return text + (details ? '\n代码：' + code : '');
}

/** 清理条目标题中的显示控制字符 */
function contentName(item: { readonly title: string }) {
  return safeText(item.title);
}

/** 返回计划动作的中文名称 */
function planVerb(item: { readonly action: Action }) {
  return ACTION_NAMES[item.action];
}

function failureLabel(action?: Action) {
  return action ? ACTION_NAMES[action] + '失败' : '操作失败';
}

/** 将原因码映射为中文说明，未知码返回统一兜底文案 */
export function reason(code: string): string {
  return (Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : undefined) ?? '原因未知';
}

/**
 * 移除换行以外的 ASCII 控制字符
 *
 * @remarks 仅清理显示控制字符，不承担凭据脱敏
 */
export function safeText(text: string) {
  return Array.from(text)
    .filter(
      character =>
        character === '\n' ||
        (character.charCodeAt(0) >= FIRST_PRINTABLE_ASCII_CODE && character.charCodeAt(0) !== ASCII_DELETE_CODE),
    )
    .join('');
}
