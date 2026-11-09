import { bundledSkills, mcpSpecs, pluginSpecs, skillMembers, skillSuites } from './management-catalog.js';
import { CLAUDE_DATA_ID } from './model.js';

/** 定义清理类别的键序与标题 */
const DATA_CATEGORY_TABLE = [
  ['cache', '缓存与诊断日志'],
  ['history', '会话与历史'],
  ['memory', '自动记忆'],
  ['backups', '恢复备份'],
  ['runtime', '后台任务与运行状态'],
] as const;
export type DataCategory = (typeof DATA_CATEGORY_TABLE)[number][0];
export const DATA_CATEGORY_KEYS: readonly DataCategory[] = DATA_CATEGORY_TABLE.map(([key]) => key);

/** 目录表标题扁平为 <prefix>:<name> 键的标题表 */
const prefixedTitles = (
  prefix: string,
  specs: Readonly<Record<string, { readonly title: string }>>,
): Record<string, string> =>
  Object.fromEntries(Object.entries(specs).map(([name, spec]): [string, string] => [`${prefix}:${name}`, spec.title]));

/** 映射已知键到官方标题；显示标题不证明身份或授予操作资格 */
const KNOWN_TITLES: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  settings: '模型配置',
  ccline: 'CCometixLine',
  officecli: 'OfficeCLI',
  [CLAUDE_DATA_ID]: 'Claude 用户数据',
  ...Object.fromEntries(DATA_CATEGORY_TABLE.map(([key, title]) => [`data:${key}`, title])),
  plan: '操作计划',
  ...prefixedTitles('plugin', pluginSpecs),
  ...prefixedTitles('mcp', mcpSpecs),
  ...prefixedTitles('skill-set', skillSuites),
  ...prefixedTitles('skill', { ...skillMembers, ...bundledSkills }),
};

export function knownTitle(key: string, fallback = key): string {
  return KNOWN_TITLES[key] ?? fallback;
}

/** 程序副本标题后缀：批内出现同工具其他副本附渠道，渠道仍相同再附路径；
 *  展示层不得反解 id 推断渠道；检查列表与计划标题共用 */
export function programCopySuffix(id: string, batch: readonly string[]): string {
  const segments = id.split(':');
  const [kind, channel] = segments;
  if (segments.length < 3 || kind === undefined || channel === undefined) return '';
  const sameToolCopy = (other: string) => {
    const parts = other.split(':');
    return other !== id && parts[0] === kind && parts.length >= 3;
  };
  if (!batch.some(sameToolCopy)) return '';
  const hasDuplicateChannel = batch.some(other => other !== id && other.startsWith(`${kind}:${channel}:`));
  return ` (${channel}${hasDuplicateChannel ? ` · ${segments.slice(2).join(':')}` : ''})`;
}
