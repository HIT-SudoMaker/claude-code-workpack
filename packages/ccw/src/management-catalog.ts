// 目录只定义对象、来源与名称；各业务域负责安装、配置和依赖
/** Skills 官方 CLI 的固定调用前缀，安装和只读白名单共用 */
export const SKILLS_CLI = ['exec', '--yes', '--package=skills@1.8.1', '--', 'skills'] as const;

/** 受管插件市场及允许识别为同一来源的仓库 */
export const PLUGIN_MARKETPLACE = {
  market: 'claude-plugins-official',
  repository: 'anthropics/claude-plugins-official',
  acceptedRepositories: ['anthropics/claude-plugins-official', 'anthropics/claude-plugins-public'],
} as const;

/** 可管理插件的协议标识与显示标题 */
export const PLUGIN_SPECS = {
  'code-simplifier@claude-plugins-official': {
    title: 'Code Simplifier',
  },
  'frontend-design@claude-plugins-official': {
    title: 'Frontend Design',
  },
  'github@claude-plugins-official': {
    title: 'GitHub',
  },
  'context7@claude-plugins-official': {
    title: 'Context7',
  },
  'mcp-server-dev@claude-plugins-official': {
    title: 'MCP Server Dev',
  },
  'skill-creator@claude-plugins-official': {
    title: 'Skill Creator',
  },
  'serena@claude-plugins-official': {
    title: 'Serena',
  },
} as const;

/** 技能入口文件名：载荷校验、套件成员发现与随包技能读取共用 */
export const SKILL_ENTRY = 'SKILL.md';

/** 技能套件的固定仓库和源目录；仓库匹配用于分组，修改资格还须核对目录摘要 */
export const SKILL_SUITES = {
  mattpocock: {
    title: 'Matt Pocock/Skills',
    repository: 'https://github.com/mattpocock/skills',
    folder: 'skills',
  },
  ssre2: {
    title: 'HIT-SudoMaker/SSRE2',
    repository: 'https://github.com/HIT-SudoMaker/ssre2-skills',
    folder: '.agents/skills',
  },
} as const;

/** 预先登记的套件成员及其所属套件 */
export const SKILL_MEMBERS = {
  'ssre2-design': { title: 'ssre2-design', suite: 'ssre2' },
  'ssre2-review': { title: 'ssre2-review', suite: 'ssre2' },
} as const satisfies Readonly<Record<string, { title: string; suite: keyof typeof SKILL_SUITES }>>;

/** 随包技能的资源位置、来源标识和版本 */
export const BUNDLED_SKILLS = {
  'amirc-research': {
    title: 'AMIRC Research Skill',
    asset: 'skills/amirc-research/SKILL.md',
    repository: 'ccw:amirc-research',
    revision: 'bundled',
  },
} as const;

/** OfficeCLI 上游仓库标识：目录登记、发布/标签 API 与下载 URL 派生共用 */
export const OFFICECLI_REPO_SLUG = 'iOfficeAI/OfficeCLI';

/** OfficeCLI 的自动更新抑制、下载镜像和技能来源配置 */
export const OFFICE_INTEGRATION = {
  suppressSelfUpdate: { OFFICECLI_NO_AUTO_INSTALL: '1', OFFICECLI_SKIP_UPDATE: '1' },
  releaseMirror: 'https://d.officecli.ai',
  skill: { repository: `https://github.com/${OFFICECLI_REPO_SLUG}`, folder: 'skills/officecli' },
} as const;

/** 将分类目录映射为带前缀的标题索引 */
const prefixedTitles = (
  prefix: string,
  specs: Readonly<Record<string, { readonly title: string }>>,
): Record<string, string> =>
  Object.fromEntries(Object.entries(specs).map(([name, spec]): [string, string] => [`${prefix}:${name}`, spec.title]));

/** 已登记条目的显示标题表 */
const KNOWN_TITLES: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  settings: '模型配置',
  ccline: 'CCometixLine',
  officecli: 'OfficeCLI',
  plan: '操作计划',
  'data:cache': '缓存与日志',
  'data:history': '会话与历史记录',
  'data:memory': '项目记忆',
  'data:backups': '备份文件',
  'data:runtime': '运行数据',
  ...prefixedTitles('plugin', PLUGIN_SPECS),
  ...prefixedTitles('skill-set', SKILL_SUITES),
  ...prefixedTitles('skill', { ...SKILL_MEMBERS, ...BUNDLED_SKILLS }),
};

/**
 * 读取已登记条目的显示标题
 *
 * @param fallback - 未登记时返回的文案，省略时使用原始键
 * @remarks 标题匹配不证明来源身份，也不授予修改资格
 */
export function knownTitle(key: string, fallback = key): string {
  return catalogEntry(KNOWN_TITLES, key) ?? fallback;
}

/** 按自有键读取目录项，不接管原型链上的同名属性 */
export function catalogEntry<T>(catalog: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(catalog, key) ? catalog[key] : undefined;
}
