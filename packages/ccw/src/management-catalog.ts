export const marketplaceSources = {
  official: {
    market: 'claude-plugins-official',
    repository: 'anthropics/claude-plugins-official',
    acceptedRepositories: ['anthropics/claude-plugins-official', 'anthropics/claude-plugins-public'],
  },
  ccline: {
    market: 'ccline',
    repository: 'Haleclipse/CCometixLine',
    acceptedRepositories: ['Haleclipse/CCometixLine'],
  },
} as const;

export const pluginSpecs = {
  'code-simplifier@claude-plugins-official': {
    title: 'Code Simplifier',
    source: 'official',
    exposure: 'offer',
  },
  'frontend-design@claude-plugins-official': {
    title: 'Frontend Design',
    source: 'official',
    exposure: 'offer',
  },
  'github@claude-plugins-official': {
    title: 'GitHub',
    source: 'official',
    exposure: 'offer',
  },
  'mcp-server-dev@claude-plugins-official': {
    title: 'MCP Server Dev',
    source: 'official',
    exposure: 'offer',
  },
  'skill-creator@claude-plugins-official': {
    title: 'Skill Creator',
    source: 'official',
    exposure: 'offer',
  },
  'cometix@ccline': {
    title: 'CCometixLine 配套插件',
    source: 'ccline',
    exposure: 'discovered',
  },
} as const satisfies Readonly<
  Record<string, { title: string; source: keyof typeof marketplaceSources; exposure: 'offer' | 'discovered' }>
>;

export const skillSuites = {
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

export const skillMembers = {
  'ssre2-design': { title: 'ssre2-design', suite: 'ssre2' },
  'ssre2-review': { title: 'ssre2-review', suite: 'ssre2' },
} as const satisfies Readonly<Record<string, { title: string; suite: keyof typeof skillSuites }>>;

export const bundledSkills = {
  'amirc-research': {
    title: 'AMIRC Research Skill',
    asset: 'skills/amirc-research/SKILL.md',
    repository: 'ccw:amirc-research',
    revision: 'bundled',
  },
} as const;

export const mcpSpecs = {
  context7: {
    title: 'Context7',
    registration: { type: 'http', url: 'https://mcp.context7.com/mcp' },
  },
  serena: {
    title: 'Serena',
    release: {
      package: 'serena-agent',
      metadataUrl: 'https://pypi.org/pypi/serena-agent/json',
      python: '3.13',
    },
    registration: {
      args: ['start-mcp-server', '--context', 'claude-code', '--project-from-cwd', '--enable-web-dashboard', 'false'],
    },
  },
} as const;

/** 抑制 OfficeCLI 自更新/自动安装的固定旗标：MCP 注册模板与版本探测共用同一份事实 */
const officeSuppressSelfUpdate = { OFFICECLI_NO_AUTO_INSTALL: '1', OFFICECLI_SKIP_UPDATE: '1' } as const;

export const officeIntegration = {
  suppressSelfUpdate: officeSuppressSelfUpdate,
  skill: { repository: 'https://github.com/iOfficeAI/OfficeCLI', folder: 'skills/officecli' },
  mcp: {
    args: ['mcp'],
    env: officeSuppressSelfUpdate,
  },
} as const;
