import { createRequire } from 'node:module';

import { dataSizeDetailOf } from './cleanup.js';
import { knownTitle, programCopySuffix } from './titles.js';
import { ERROR_MESSAGES } from './errors.js';
import type { MessageText } from './errors.js';
import { WARNING_MESSAGES } from './warnings.js';
import { isObject } from './machine.js';
import { CLAUDE_DATA_ID, kindOf } from './model.js';
import type { Action, Change, Inspection, Item, Kind, Pick, PreparationProgress } from './model.js';

/** 版本唯一真值是 package.json；运行时读取，避免发布元数据与自报版本漂移 */
const manifest: unknown = createRequire(import.meta.url)('../package.json');
const packageVersion = isObject(manifest) && typeof manifest.version === 'string' ? manifest.version : '';
export const BRAND = {
  title: 'Claude Code Workpack',
  versionNumber: packageVersion,
  version: `V${packageVersion}`,
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
export const HELP_TEXT = `CCW ${BRAND.versionNumber}\n无参数：打开菜单\n--inspect：检查环境（默认摘要，--inspect --details 输出完整明细）\n--collect-logs：收集诊断日志到本地文件\n--version：查看版本\n--help：查看帮助\n--details：显示启动异常与检查完整明细\n安装：勾选后执行\n卸载、清理：预览后确认\n`;
/** 标题范围后缀与未确认状态词：首页/检查标题、终端通知与诊断收集共用 */
export const USER_SCOPE_SUFFIX = ' · 当前用户';
export const UNCONFIRMED = '待确认';
export const HOME_TITLE = `CCW ${BRAND.versionNumber}${USER_SCOPE_SUFFIX}`;
/** 问题行与分组标题的固定记号：渲染、终端视图与诊断收集共用 */
export const PROBLEM_MARK = '! ';
export const GROUP_MARK = '── ';
/** 横幅与边框的固定宽度：视图层五处引用 */
export const BANNER_WIDTH = 62;
/** 选择页与结果菜单的返回行标签 */
export const BACK_TO_HOME = '返回主菜单';
/** 平台与架构的摘要片段格式：诊断收集与界面页脚共用 */
export const platformSummary = (platform: string, arch: string) => `${platform} (${arch})`;
const CONTENT_ORDER: Readonly<Record<Kind, number>> = {
  claude: 0,
  settings: 1,
  plugin: 2,
  mcp: 3,
  skill: 4,
  command: 5,
  ccline: 6,
  officecli: 7,
  data: 8,
};
export const GROUPS: Readonly<Record<Kind, string>> = {
  claude: '基础配置',
  settings: '基础配置',
  plugin: 'Plugins',
  mcp: 'MCPs',
  skill: 'Skills',
  command: 'Skills',
  ccline: '附加工具',
  officecli: '附加工具',
  data: '运行数据',
};
export const ACTION_NAMES: Readonly<Record<Action, string>> = {
  install: '安装',
  connect: '安装',
  update: '更新',
  reinstall: '重装',
  configure: '编辑',
  login: '登录',
  detach: '解除接入',
  uninstall: '卸载程序',
  clean: '清理',
};

export function planVerb(item: { readonly id: string; readonly action: Action }): string {
  if (item.id === CLAUDE_DATA_ID) return '删除';
  return item.action === 'uninstall' ? '卸载' : ACTION_NAMES[item.action];
}

/** 任务动词词干：准备与检查标题共用，动词只写一次 */
type PreparationTask = 'install' | 'uninstall' | 'clean';
const TASK_VERBS: Readonly<Record<PreparationTask, string>> = {
  install: '安装',
  uninstall: '卸载',
  clean: '清理',
};

export function preparationTitle(task: PreparationTask) {
  return `准备${TASK_VERBS[task]}`;
}

export const MODEL_FIELDS = [
  { key: 'model', label: 'Default Model' },
  { key: 'fable', label: 'Fable' },
  { key: 'opus', label: 'Opus' },
  { key: 'sonnet', label: 'Sonnet' },
  { key: 'haiku', label: 'Haiku' },
] as const;
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
export const SETTINGS_FIELDS = {
  connection: ['mode', 'auth', 'baseUrl', 'secret', 'login', ...MODEL_FIELDS.map(field => field.key)],
  language: ['language'],
  outputStyle: ['outputStyle'],
} as const;
export type SettingsEditor = keyof typeof SETTINGS_FIELDS;
/** 偏好默认值：表单初值与行摘要共用；与选项表首项无关，是刻意的默认选择 */
export const DEFAULT_PREFERENCES = { language: 'Simplified Chinese', outputStyle: 'Explanatory' } as const;
interface ContentEntry {
  readonly item: Item;
  readonly editor?: SettingsEditor;
}
export interface MenuRow {
  readonly label: string;
  readonly detail?: string;
  readonly group?: string;
}

export function contentEntries(items: readonly Item[], shouldExpandEditors: boolean): ContentEntry[] {
  return items.flatMap(item =>
    item.kind === 'settings' && shouldExpandEditors
      ? [
          { item, editor: 'connection' },
          { item, editor: 'language' },
          { item, editor: 'outputStyle' },
        ]
      : [{ item }],
  );
}
export function entrySelected(entry: ContentEntry, drafts: ReadonlyMap<string, Pick>) {
  const selection = drafts.get(entry.item.id);
  return (
    selection !== undefined &&
    (entry.editor === undefined ||
      SETTINGS_FIELDS[entry.editor].some(field => Object.hasOwn(selection.fields ?? {}, field)))
  );
}
export function entryRows(entries: readonly ContentEntry[], drafts: ReadonlyMap<string, Pick>) {
  const rows = contentRows(entries.map(entry => entry.item));
  return entries.map((entry, index) => {
    const editor = entry.editor;
    if (editor === undefined) return rows[index] ?? { label: '' };
    const fields = { ...entry.item.values, ...drafts.get(entry.item.id)?.fields };
    if (editor === 'connection')
      return {
        ...rows[index],
        label: contentName(entry.item),
        detail: effectiveConnection(fields, entry.item.facts) === 'api' ? '第三方 API' : '官方登录',
      };
    const choices = editor === 'language' ? SETTINGS_LANGUAGES : SETTINGS_STYLES;
    const value = fields[editor] ?? DEFAULT_PREFERENCES[editor];
    return {
      ...rows[index],
      label: editor === 'language' ? '默认输出语言' : '输出风格',
      detail: choices.find(choice => choice.value === value)?.label ?? value,
    };
  });
}

export function effectiveConnection(
  values: Readonly<Record<string, string>>,
  facts: readonly { readonly code: string }[],
): 'api' | 'official' {
  return values.mode === 'api' || (values.mode !== 'official' && facts.some(fact => fact.code === 'api-configured'))
    ? 'api'
    : 'official';
}

export function contentOrder(items: readonly Item[]) {
  return [...items].sort((a, b) => CONTENT_ORDER[a.kind] - CONTENT_ORDER[b.kind]);
}
/** 技能安装目录不是观测结果；检查只展示实际发现的成员和读取问题 */
export function inspectedItems(items: readonly Item[]) {
  return items.filter(
    item =>
      kindOf(item.id) !== 'skill-set' &&
      !(item.kind === 'skill' && !item.problem && item.facts.some(fact => fact.code === 'not-installed')),
  );
}
export function contentName(item: { readonly title: string }): string {
  return safeText(item.title);
}
/** 附加工具两类 kind；shortStatus 的残留配置与待接入分支共用 */
const TOOL_KINDS: readonly Kind[] = ['ccline', 'officecli'];
/** 摘要状态词：凡与事实码目录 brief 相同的一律经 reason() 取词，词表只活在目录里 */
function shortStatus(item: Item) {
  const has = (code: string) => item.facts.some(fact => fact.code === code);
  if (
    ['invalid-appearance', 'appearance-migration-required', 'skill-entry-invalid', 'invalid-mcp-registration'].includes(
      item.problem ?? '',
    )
  )
    return '配置异常';
  if (item.problem || has('inspection-incomplete')) return UNCONFIRMED;
  if (has('program-missing')) return reason('program-missing');
  if (kindOf(item.id) === 'skill-set') {
    const members = item.facts.find(fact => fact.code === 'skill-members-present')?.detail;
    return has('not-installed') ? reason('not-installed') : members ? `已装 ${members} 项` : UNCONFIRMED;
  }
  if (item.kind === 'settings') return has('api-configured') ? reason('api-configured') : reason('official-connection');
  if (item.kind === 'plugin')
    return has('plugin-files-missing')
      ? reason('plugin-files-missing')
      : has('plugin-installed')
        ? has('declared-disabled')
          ? reason('declared-disabled')
          : '已安装'
        : has('declared-enabled')
          ? '残留声明'
          : reason('not-installed');
  if (item.kind === 'mcp')
    return has('registration-exists')
      ? '已注册'
      : has('amirc-permissions-present')
        ? '残留许可'
        : reason('not-installed');
  if (item.kind === 'data') return dataSizeDetailOf(item) ?? '无数据';
  if (has('shared-link') || has('entry-exists')) return '已安装';
  if (has('program-identity-unchecked')) return UNCONFIRMED;
  if (TOOL_KINDS.includes(item.kind) && !has('program-exists') && has('connected')) return '残留配置';
  if (has('program-exists')) {
    const version = item.facts.find(fact => fact.code === 'program-version')?.detail;
    const status =
      TOOL_KINDS.includes(item.kind) && !has('connected')
        ? '待接入'
        : item.kind === 'ccline' && has('appearance-missing')
          ? '待配置'
          : '已安装';
    return `${status}${version ? ` ${version}` : ''}`;
  }
  return reason('not-installed');
}
export function contentRows(items: readonly Item[]): MenuRow[] {
  return items.map(item => ({
    label: `${contentName(item)}${programCopySuffix(
      item.id,
      items.map(other => other.id),
    )}`,
    detail: shortStatus(item),
    group: GROUPS[item.kind],
  }));
}

export const TEXT: Readonly<Record<string, MessageText>> = {
  'skill-confirm': { brief: '确认技能', detail: '确认技能文件' },
  'claude-data-remove': { brief: '删除用户数据', detail: '删除 Claude 配置和数据' },
  'claude-state-remove': { brief: '删除用户状态', detail: '删除 Claude 用户状态' },
  'claude-data-impact': {
    brief: '删除范围',
    detail: '删除目录内全部配置、登录状态、会话、Skills 和附加工具文件；其他 Claude 副本同步失去这些数据',
  },
  'claude-data-removed': { brief: '用户数据已删', detail: '删除 Claude 数据' },
  'claude-data-cleared': { brief: '用户数据已清', detail: '清除 Claude 用户数据' },
  'program-uninstall': { brief: '卸载程序', detail: '卸载程序' },
  'program-removed': { brief: '程序已卸载', detail: '卸载程序' },
  'program-copy-remove': { brief: '删除程序文件', detail: '删除程序文件' },
  'program-copy-removed': { brief: '程序文件已删', detail: '删除程序文件' },
  'program-user-path': { brief: '设置命令路径', detail: '配置用户命令路径' },
  'program-file-ready': { brief: '程序文件已写', detail: '写入程序文件' },
  'program-other-copies-kept': { brief: '其他副本保留', detail: '保留其他程序副本' },
  'package-removed': { brief: '程序包已卸载', detail: '卸载程序包' },
  'program-not-installed': { brief: '程序未安装', detail: '程序未安装' },
  'program-removal-confirm': { brief: '确认程序卸载', detail: '确认程序卸载' },
  'program-installation-confirm': { brief: '确认程序安装', detail: '确认程序安装' },
  'program-uninstall-command-completed': { brief: '卸载命令完成', detail: '执行卸载命令；确认程序状态' },
  'unrecognized-program-kept': { brief: '程序已保留', detail: '保留身份未知的程序文件' },
  'office-skill-connected': { brief: '技能已接入', detail: 'OfficeCLI Skill 已添加' },
  'office-mcp-connected': { brief: '服务已注册', detail: 'OfficeCLI MCP 已注册' },
  'registration-kept': { brief: '注册已保留', detail: '保留 MCP 注册' },
  'program-missing': { brief: '程序入口缺失', detail: '程序入口缺失；安装记录存在' },
  'program-kept': { brief: '程序已保留', detail: '保留程序' },
  'amirc-permissions-present': { brief: '工具许可存在', detail: 'AMIRC 工具许可存在' },
  'skill-existing-kept': { brief: '技能已保留', detail: '保留技能' },
  'program-exists': { brief: '程序存在', detail: '程序存在' },
  'program-version': { brief: '程序版本', detail: '程序版本' },
  'not-installed': { brief: '未安装', detail: '未安装' },
  'skill-members-present': { brief: '已装成员', detail: '套件在本机已发现的成员数量' },
  'not-connected': { brief: '未接入', detail: '未接入' },
  'appearance-missing': { brief: '外观待配置', detail: '外观未配置' },
  'program-install': { brief: '安装程序', detail: '安装程序' },
  'program-install-cmd': { brief: '安装程序', detail: '经 CMD 备用安装程序' },
  'program-update': { brief: '更新程序', detail: '更新程序' },
  'program-reinstall': { brief: '重装程序', detail: '重装程序' },
  'keep-user-data': { brief: '保留用户数据', detail: '保留用户数据' },
  'program-ready': { brief: '程序已就绪', detail: '程序就绪' },
  'package-command-completed': { brief: '管理命令完成', detail: '执行包管理命令' },
  'plugin-installed': { brief: '插件已安装', detail: '插件已安装' },
  'plugin-not-installed': { brief: '插件未安装', detail: '插件未安装' },
  'declared-enabled': { brief: '已启用', detail: '已启用' },
  'declared-disabled': { brief: '已停用', detail: '已停用' },
  'not-declared': { brief: '未启用', detail: '未启用' },
  'plugin-disable': { brief: '停用插件', detail: '停用用户插件' },
  'keep-plugin-files': { brief: '保留插件文件', detail: '保留插件文件和市场' },
  'plugin-disabled': { brief: '插件已停用', detail: '停用用户插件' },
  'plugin-install': { brief: '安装插件', detail: '安装插件' },
  'plugin-connect': { brief: '启用插件', detail: '启用用户插件' },
  'plugin-keep-data': { brief: '保留插件数据', detail: '保留插件数据' },
  'plugin-delete-own-data': { brief: '可能删除数据', detail: '官方卸载可能删除插件数据' },
  'plugin-credentials-removed': { brief: '可能清除认证', detail: '官方卸载可能清除插件设置和认证' },
  'plugin-command-completed': { brief: '插件命令完成', detail: '执行插件命令' },
  'plugin-ready': { brief: '插件已就绪', detail: '安装插件' },
  'plugin-removed': { brief: '插件已卸载', detail: '卸载用户插件' },
  'api-configured': {
    brief: '已有连接字段',
    detail: '当前用户文件存在所检查的 API 地址或凭据字段；尚未确认有效认证和连接',
  },
  'official-connection': {
    brief: '默认连接',
    detail: '当前用户文件未见所检查的 API 地址或凭据字段；尚未确认会话连接和登录状态',
  },
  'settings-edit': { brief: '修改设置', detail: '修改设置' },
  'settings-disconnect': { brief: '解除模型连接', detail: '解除模型连接' },
  'settings-saved': { brief: '配置已保存', detail: '保存设置' },
  'login-browser': { brief: '打开官方登录', detail: '打开官方登录' },
  'logged-in': { brief: '登录已确认', detail: '确认登录' },
  'shared-link': { brief: '共享链接', detail: '共享内容链接' },
  'entry-exists': { brief: '入口存在', detail: '读取入口存在' },
  'entry-disable': { brief: '解除读取接入', detail: '移出 Claude 读取位置' },
  'preserved-at': { brief: '原内容已保留', detail: '保留原内容' },
  'no-recovery': { brief: '永久删除', detail: '永久删除；CCW 不提供恢复' },
  'keep-link-target': { brief: '保留共享目标', detail: '保留链接目标和共享源' },
  'entry-disabled': { brief: '读取接入已解', detail: '解除读取接入；保留原内容' },
  'skill-install': { brief: '复制技能资源', detail: '复制技能和资源' },
  'skill-installed': { brief: '技能资源已写', detail: '写入技能资源' },
  'skill-source-repair': { brief: '补记技能来源', detail: '补记技能来源' },
  'skill-source-recorded': { brief: '来源已记录', detail: '补记技能来源' },
  'registration-exists': { brief: '注册存在', detail: '注册存在' },
  'not-registered': { brief: '未注册', detail: '未注册' },
  'mcp-remove-registration': { brief: '删除用户注册', detail: '删除匹配的用户注册' },
  'mcp-keep-runtime': { brief: '保留服务程序', detail: '保留服务程序、共享运行时和远端服务' },
  'mcp-auth-unchanged': { brief: '保留远端认证', detail: '保留远端认证' },
  'registration-removed': { brief: '注册已删除', detail: '删除注册' },
  'mcp-registration-confirm': { brief: '确认服务注册', detail: '确认已写入的 MCP 注册' },
  'plugin-confirm': { brief: '确认插件变更', detail: '确认已执行的插件变更' },
  'mcp-register': { brief: '写入服务注册', detail: '写入 MCP 注册' },
  'mcp-program-update': { brief: '更新服务程序', detail: '更新 MCP 程序' },
  'uv-python-dependency': { brief: '准备共享依赖', detail: '按需安装 uv 和 Python 3.13；保留供其他工具使用' },
  'disconnect-before-reinstall': { brief: '先解除再重装', detail: '先解除接入，再重装并接入' },
  'uv-installed': { brief: '依赖已安装', detail: '安装 uv' },
  'serena-installed': { brief: '服务程序就绪', detail: '安装 Serena' },
  'registration-saved': { brief: '接入已保存', detail: '保存接入' },
  'data-size': { brief: '数据大小', detail: '文件数 · 逻辑大小' },
  'data-delete': { brief: '删除数据', detail: '删除数据' },
  'keep-settings-credentials': { brief: '保留配置凭据', detail: '保留设置、认证、扩展和未选数据' },
  'data-file-removed': { brief: '文件已删除', detail: '删除文件' },
  'data-remains-or-regenerated': { brief: '仍有保留项', detail: '保留未选、新增或再生文件' },
  'no-data': { brief: '无选中数据', detail: '无选中数据' },
  disconnected: { brief: '状态栏已解除', detail: '解除 Claude 状态栏接入' },
  'no-connection': { brief: '无可解除接入', detail: '无可移除的 Claude 入口或声明' },
  connected: { brief: '状态栏已接入', detail: 'Claude 状态栏已接入' },
  'appearance-copied': { brief: '外观已复制', detail: '复制 CCW 外观配置' },
  'appearance-kept': { brief: '外观已保留', detail: '保留外观配置' },
  'ccline-disconnect-before-uninstall': { brief: '先解除状态栏', detail: '解除 CCometixLine 主状态栏与子状态栏' },
  'ccline-companion-kept': { brief: '保留配套插件', detail: '保留配套插件与市场' },
  'ccline-companion-present': { brief: '配套插件已装', detail: 'CCometixLine 配套插件在场' },
  'ccline-companion-missing': { brief: '配套插件未装', detail: 'CCometixLine 配套插件不在场；需要时可重装程序补齐' },
  'ccline-detach': { brief: '解除状态栏', detail: '解除 CCometixLine 接入；保留程序与外观' },
  'ccline-program-kept': { brief: '程序已保留', detail: '保留 CCometixLine 程序' },
  'ccline-program-update': { brief: '更新程序', detail: '更新 npm 程序' },
  'ccline-program-prepare': { brief: '准备程序', detail: '准备 CCometixLine 程序（可复用同版本）' },
  'ccline-reinstall-connection': { brief: '重装后恢复接入', detail: '解除旧接入；重装后恢复' },
  'ccline-subagent-restore': { brief: '恢复子状态栏', detail: '恢复子代理状态栏及设置' },
  'appearance-copy': { brief: '复制外观配置', detail: '复制 CCW 外观配置' },
  'ccline-connect': { brief: '接入状态栏', detail: '接入 Claude 状态栏' },
  'ccline-statusline-replace': { brief: '替换现有状态栏', detail: '替换现有 Claude 状态栏' },
  'ccline-root-configure': { brief: '设置配置目录', detail: '设置 CCometixLine 配置目录' },
  'ccline-settings-kept': { brief: '保留外观设置', detail: '保留外观与 Claude 设置' },
  cancelled: { brief: '已停止', detail: '停止后续操作' },
  'dependency-not-ready': { brief: '已跳过', detail: '跳过操作：前置操作未完成' },
  'removal-confirm': { brief: '确认入口删除', detail: '确认入口删除' },
  'cleanup-link-kept': { brief: '共享目标保留', detail: '保留共享链接和目标' },
  'data-clean-root': { brief: '清理位置', detail: '清理数据位置' },
  'data-runtime-impact': { brief: '运行数据影响', detail: '删除后台任务、会话标记和运行状态；需退出 Claude' },
  'data-empty-directories': { brief: '清理空子目录', detail: '删除空子目录；保留数据根' },
  'data-file-absent': { brief: '文件已不存在', detail: '跳过删除：文件不存在' },
  'data-selected-cleared': { brief: '选中数据已清', detail: '清理数据' },
  'npm-install-started': { brief: '开始安装', detail: '开始 npm 安装' },
  'cmd-install-started': { brief: '开始备用安装', detail: '开始 CMD 备用安装' },
  'failed-install-cleaned': { brief: '安装残留已清', detail: '清理 npm 安装残留' },
  'unmatched-integration-kept': { brief: '同名入口保留', detail: '保留同名入口：与程序关系未知' },
  'replace-existing-registration': { brief: '替换注册设置', detail: '替换注册设置' },
  'serena-initialize': { brief: '初始化服务', detail: '初始化 Serena 配置和语言服务' },
  'serena-initialized': { brief: '服务已初始化', detail: '初始化 Serena' },
  'github-credential-configure': { brief: '配置访问凭据', detail: '配置 GitHub 凭据；预览隐藏内容' },
  'github-credential-saved': { brief: '访问凭据已存', detail: '保存 GitHub 凭据' },
  'skill-current': {
    brief: '技能已保留',
    detail: '保留已有的有效技能内容，并复核准备时摘要；未确认与上游最新版是否一致',
  },
  'amirc-permissions-remove': { brief: '删除工具许可', detail: '删除文献工具专用许可' },
  'amirc-permissions-removed': { brief: '工具许可已删', detail: '删除文献工具许可' },
  'plugin-files-present': { brief: '插件文件存在', detail: '插件目录存在' },
  'plugin-files-missing': { brief: '插件文件缺失', detail: '插件目录缺失；安装记录存在' },
  'office-connection-kept': { brief: '接入已保留', detail: '保留 OfficeCLI 接入；不添加 Skill' },
  'office-local-skill-kept': { brief: '本地技能保留', detail: '保留 OfficeCLI Skill：来源未知或内容已修改' },
  'plugin-reuse': { brief: '复用启用插件', detail: '复用并启用插件' },
};
export function safeText(text: string) {
  return Array.from(text)
    .filter(character => character === '\n' || (character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127))
    .join('');
}
export function reason(code: string) {
  return message(code)?.brief ?? '操作失败';
}
function message(code: string) {
  return ERROR_MESSAGES[code] ?? WARNING_MESSAGES[code] ?? TEXT[code];
}
const FAILURE_LABELS: Readonly<Record<Action, string>> = {
  install: '安装失败',
  connect: '安装失败',
  update: '更新失败',
  reinstall: '重装失败',
  configure: '配置失败',
  login: '登录失败',
  detach: '解除失败',
  uninstall: '卸载失败',
  clean: '清理失败',
};

export function failureLabel(action?: Action) {
  if (action === undefined) return '操作失败';
  return FAILURE_LABELS[action];
}
export function startupFailure(code: string, shouldShowDetails: boolean) {
  const brief = ['unknown-argument', 'interactive-terminal-required', 'unsupported-platform'].includes(code)
    ? reason(code)
    : '启动失败';
  return shouldShowDetails ? `${brief}\n${describeDiagnostic({ code })}` : brief;
}
export function describePreparation(event: PreparationProgress, task: PreparationTask = 'install') {
  const actions = {
    inspect: `检查${TASK_VERBS[task]}`,
    metadata: '查询来源',
    download: '下载程序',
    source: '获取技能',
  };
  return `${actions[event.stage]}：${contentName(event)}`;
}
/** detail 一律原文：注册键、配置键、成员名与路径不在此改名 */
export function describeChange(change: Change) {
  return `${message(change.code)?.detail ?? '操作失败：原因未知'}${change.detail ? `：${safeText(change.detail)}` : ''}`;
}
export function describeDiagnostic(change: Change) {
  const code = /^[a-zA-Z][a-zA-Z0-9-]{0,79}$/.test(change.code) ? change.code : 'operation-failed';
  return `${describeChange({ ...change, code })}\n代码：${code}`;
}
export function describeItem(item: Item, shouldShowDetails = false) {
  const body = shouldShowDetails
    ? [
        `标识：${safeText(item.id)}`,
        ...item.facts.map(describeDiagnostic),
        ...(item.problem ? [`${PROBLEM_MARK}${describeDiagnostic({ code: item.problem })}`] : []),
      ]
    : [shortStatus(item)];
  return `${contentName(item)}\n${body.filter(Boolean).join('\n')}${item.location ? `\n位置：${safeText(item.location)}` : ''}`;
}
/** 检查输出默认摘要（每项一行，与界面列表同形）；--details 才展开完整明细 */
export function describeInspection(view: Inspection, shouldShowDetails = false) {
  if (shouldShowDetails)
    return [
      ...inspectedItems(view.items).map(item => describeItem(item, true)),
      ...view.problems.map(problem => `${PROBLEM_MARK}${describeInspectionProblem(problem)}`),
    ].join('\n');
  const lines: string[] = [];
  let previous: string | undefined;
  for (const row of contentRows(inspectedItems(contentOrder(view.items)))) {
    if (row.group && row.group !== previous) lines.push(`${GROUP_MARK}${row.group}`);
    previous = row.group;
    lines.push(row.detail ? `${row.label}：${row.detail}` : row.label);
  }
  return [...lines, ...view.problems.map(problem => `${PROBLEM_MARK}${describeInspectionProblem(problem)}`)].join('\n');
}

/** 检查问题按读取来源归组：集合名映射到列表分组，其余来源用已知标题表 */
const PROBLEM_KINDS: Readonly<Record<string, Kind>> = {
  plugins: 'plugin',
  mcp: 'mcp',
  skills: 'skill',
  data: 'data',
};
export function describeInspectionProblem(problem: Change) {
  const kind = PROBLEM_KINDS[problem.detail ?? ''];
  return describeDiagnostic({
    ...problem,
    ...(problem.detail ? { detail: kind !== undefined ? GROUPS[kind] : knownTitle(problem.detail) } : {}),
  });
}
