import { knownTitle } from './titles.js';
import { errorCode, isObject } from './machine.js';
import { apiConfigurationProblem, cancelled, json, object, sequence, success, unchanged } from './model.js';
import type { Context, Domain, Effect, Inspection, Item, Prepared, Selection } from './model.js';
import { claudeCommand, prepareProgram, programs } from './programs.js';

/** 程序步骤失败：保留原错误的续办语义，同时撤回本次依赖执行资格。 */
export class ClaudeProgramVerificationError extends Error {
  constructor(cause: unknown) {
    super(errorCode(cause), { cause });
  }
}

/** 程序步骤单独拥有失败标签；默认设置失败不撤回已经确认的程序资格。 */
function verifiedClaudeProgram(initial: Prepared): Prepared {
  let current = initial;
  const operation: Prepared = {
    ...(initial.writes === undefined ? {} : { writes: initial.writes }),
    get changes() {
      return current.changes;
    },
    async run(report, signal) {
      try {
        await current.run(report, signal);
      } catch (error) {
        throw new ClaudeProgramVerificationError(error);
      }
    },
    remaining() {
      const rest = current.remaining ? current.remaining() : current;
      if (rest === undefined) return undefined;
      current = rest;
      return operation;
    },
    async verify() {
      try {
        await current.verify?.();
      } catch (error) {
        throw new ClaudeProgramVerificationError(error);
      }
    },
  };
  return operation;
}

/** 创建 Claude 程序域渠道：裸 id 与 claude: 余段 id 都归本域 */
export function createClaudeDomain(ctx: Context): Domain {
  return {
    inspect: () => inspectClaudePrograms(ctx),
    prepare: selection => prepareClaudeProgram(ctx, selection),
  };
}

/** 创建设置域渠道：settings 无前缀单项入口，检查归一为聚合 */
export function createSettingsDomain(ctx: Context): Domain {
  return {
    async inspect() {
      return { items: [await inspectSettings(ctx)], problems: [] };
    },
    prepare: selection => {
      if (selection.id !== 'settings') throw new Error('unknown-selection');
      return prepareSettings(ctx, selection);
    },
  };
}

/** 检查 Claude 程序：实际副本，或无副本时的同形方案壳 */
async function inspectClaudePrograms(ctx: Context): Promise<Inspection> {
  const found = await programs(ctx, 'claude');
  return {
    items: found.items.length
      ? found.items
      : [
          {
            id: 'claude',
            title: knownTitle('claude'),
            kind: 'claude',
            canInstall: true,
            facts: [{ code: found.problems.length ? 'inspection-incomplete' : 'not-installed' }],
            actions: ['install'],
          },
        ],
    problems: found.problems.map(code => ({ code, detail: 'claude' })),
  };
}

/** 编排 Claude 程序准备：实例解析、保留分支复核与默认偏好合并 */
async function prepareClaudeProgram(ctx: Context, selection: Selection): Promise<Prepared> {
  const { id, action } = selection;
  const kind = 'claude';
  const found = await programs(ctx, kind);
  const program =
    found.values.get(id) ?? (id === kind && found.values.size === 1 ? [...found.values.values()][0] : undefined);
  if (id !== kind && program === undefined) throw new Error('program-changed');
  if (id === kind && found.values.size > 1) throw new Error('program-selection-required');
  if (found.problems.length && !(action === 'uninstall' && program && program.channel !== 'npm'))
    throw new Error('installation-state-unconfirmed');
  if (action === 'detach') throw new Error('action-unavailable');
  const programStamp = program ? await ctx.machine.treeStamp(program.binary) : null;
  // 两次读取之间二进制消失时不允许"保留程序"空转通过
  if (action === 'install' && program && !program.isMissing && programStamp === null)
    throw new Error('program-changed');
  const operation =
    action === 'install' && program && !program.isMissing
      ? {
          targetVersion: program.version,
          changes: [{ code: 'program-kept' }],
          async run(report: (effect: Effect) => void) {
            if ((await ctx.machine.treeStamp(program.binary)) !== programStamp) throw new Error('program-changed');
            report({ state: 'kept', code: 'program-kept' });
          },
          async verify() {
            if ((await ctx.machine.treeStamp(program.binary)) !== programStamp) throw new Error('program-changed');
          },
        }
      : await prepareProgram(ctx, kind, selection, program);
  if ((action !== 'install' && action !== 'reinstall') || (action === 'install' && program && !program.isMissing))
    return operation;
  const programStep = verifiedClaudeProgram(operation);
  const defaults = await prepareSettings(ctx, { id: 'settings', action: 'configure' });
  const assess = async () => {
    await programStep.verify?.();
    await defaults.verify?.();
  };
  return sequence([programStep, defaults, { changes: [], run: assess, verify: assess }]);
}

interface OrderedField {
  readonly placement: 'prefix' | 'suffix';
}

type RootField = OrderedField &
  (
    | { readonly role: 'preserve' | 'helper' | 'environment' | 'preference' }
    | {
        readonly role: 'attribution';
        readonly value: { readonly commit: string; readonly pr: string; readonly sessionUrl: boolean };
      }
  );

type EnvField = OrderedField &
  (
    | { readonly role: 'preserve' | 'base' | 'key' | 'token' }
    | { readonly role: 'model'; readonly editor: 'model' | 'fable' | 'opus' | 'sonnet' | 'haiku' }
    | {
        readonly role: 'default';
        readonly when: 'configure' | 'win32' | 'custom-base';
        readonly value: string;
      }
  );

// 保留字段只定位已有键；偏好默认值由编辑器提交，不能变成 initializer 默认值
/** settings 内用户插件启停表的键名：字段表、插件域与配套插件探测共用 */
export const ENABLED_PLUGINS_KEY = 'enabledPlugins';

const ROOT_FIELDS = {
  $schema: { placement: 'prefix', role: 'preserve' },
  defaultShell: { placement: 'prefix', role: 'preserve' },
  permissions: { placement: 'prefix', role: 'preserve' },
  includeCoAuthoredBy: { placement: 'prefix', role: 'preserve' },
  attribution: { placement: 'prefix', role: 'attribution', value: { commit: '', pr: '', sessionUrl: false } },
  language: { placement: 'prefix', role: 'preference' },
  outputStyle: { placement: 'prefix', role: 'preference' },
  statusLine: { placement: 'prefix', role: 'preserve' },
  [ENABLED_PLUGINS_KEY]: { placement: 'prefix', role: 'preserve' },
  autoCompactEnabled: { placement: 'prefix', role: 'preserve' },
  autoCompactWindow: { placement: 'prefix', role: 'preserve' },
  apiKeyHelper: { placement: 'suffix', role: 'helper' },
  env: { placement: 'suffix', role: 'environment' },
  model: { placement: 'suffix', role: 'preserve' },
} as const satisfies Readonly<Record<string, RootField>>;

const ENV_FIELDS = {
  DISABLE_TELEMETRY: { placement: 'prefix', role: 'default', when: 'configure', value: '1' },
  DISABLE_ERROR_REPORTING: { placement: 'prefix', role: 'default', when: 'configure', value: '1' },
  DISABLE_INSTALLATION_CHECKS: { placement: 'prefix', role: 'default', when: 'configure', value: '1' },
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: { placement: 'prefix', role: 'default', when: 'configure', value: '80' },
  CLAUDE_CODE_USE_POWERSHELL_TOOL: { placement: 'prefix', role: 'default', when: 'win32', value: '1' },
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: { placement: 'prefix', role: 'default', when: 'configure', value: '1' },
  CLAUDE_CODE_ATTRIBUTION_HEADER: { placement: 'prefix', role: 'default', when: 'custom-base', value: '0' },
  MCP_TIMEOUT: { placement: 'prefix', role: 'preserve' },
  ANTHROPIC_BASE_URL: { placement: 'suffix', role: 'base' },
  ANTHROPIC_CUSTOM_HEADERS: { placement: 'suffix', role: 'preserve' },
  ANTHROPIC_API_KEY: { placement: 'suffix', role: 'key' },
  ANTHROPIC_AUTH_TOKEN: { placement: 'suffix', role: 'token' },
  ANTHROPIC_MODEL: { placement: 'suffix', role: 'model', editor: 'model' },
  ANTHROPIC_DEFAULT_MODEL: { placement: 'suffix', role: 'preserve' },
  ANTHROPIC_DEFAULT_FABLE_MODEL: { placement: 'suffix', role: 'model', editor: 'fable' },
  ANTHROPIC_DEFAULT_OPUS_MODEL: { placement: 'suffix', role: 'model', editor: 'opus' },
  ANTHROPIC_DEFAULT_SONNET_MODEL: { placement: 'suffix', role: 'model', editor: 'sonnet' },
  ANTHROPIC_DEFAULT_HAIKU_MODEL: { placement: 'suffix', role: 'model', editor: 'haiku' },
} as const satisfies Readonly<Record<string, EnvField>>;

const rootFields = Object.entries(ROOT_FIELDS);
const envFields = Object.entries(ENV_FIELDS);
const connectionKeys = envFields
  .filter(([, field]) => ['base', 'key', 'token', 'model'].includes(field.role))
  .map(([key]) => key);
const helperKeys = rootFields.filter(([, field]) => field.role === 'helper').map(([key]) => key);

/** 只重排 root/env 自身属性；未知键保持相对顺序，嵌套值保持原样 */
function orderFields(value: Record<string, unknown>, fields: readonly (readonly [string, OrderedField])[]) {
  const known = new Set(fields.map(([key]) => key));
  const ordered = Object.fromEntries(
    [
      ...fields.filter(([key, field]) => field.placement === 'prefix' && Object.hasOwn(value, key)),
      ...Object.entries(value).filter(([key]) => !known.has(key)),
      ...fields.filter(([key, field]) => field.placement === 'suffix' && Object.hasOwn(value, key)),
    ].map(([key]) => [key, value[key]]),
  );
  for (const key of Object.keys(value)) delete value[key];
  // JSON 可包含 __proto__；以自身属性重建，不触发原型 setter
  Object.defineProperties(value, Object.getOwnPropertyDescriptors(ordered));
}

/** 补齐安装默认值；保留显式值和继承变量声明 */
function initializeDefaults(settings: Record<string, unknown>, ctx: Context) {
  const env = object(settings.env);
  const hasCustomBase = envFields.some(([key, field]) => {
    const base = env[key];
    return (
      field.role === 'base' &&
      typeof base === 'string' &&
      apiConfigurationProblem(base, true) === null &&
      new URL(base).hostname !== 'api.anthropic.com'
    );
  });
  const added: Record<string, unknown> = {};
  for (const [key, field] of envFields)
    if (
      field.role === 'default' &&
      env[key] === undefined &&
      !ctx.inheritedKeys?.includes(key) &&
      (field.when !== 'win32' || ctx.platform === 'win32') &&
      (field.when !== 'custom-base' || hasCustomBase)
    ) {
      env[key] = field.value;
      added[key] = field.value;
    }
  settings.env = env;
  const root: Record<string, unknown> = {};
  for (const [key, field] of rootFields)
    if (field.role === 'attribution' && settings[key] === undefined && settings.includeCoAuthoredBy !== true) {
      settings[key] = { ...field.value };
      root[key] = settings[key];
    }
  // 权限默认模式只在缺失时补齐；已有选择（含更保守模式）不覆盖，allow/ask/deny 原样保留
  const permissions = object(settings.permissions);
  if (permissions.defaultMode === undefined) {
    permissions.defaultMode = 'bypassPermissions';
    settings.permissions = permissions;
    root.permissions = permissions;
  }
  return { env: added, root };
}

async function inspectSettings(ctx: Context): Promise<Item> {
  const settings = await json(ctx.machine, ctx.settingsFile);
  const env = object(settings.env);
  const hasApiConfiguration = envFields.some(
    ([key, field]) => ['base', 'key', 'token'].includes(field.role) && typeof env[key] === 'string',
  );
  const values: Record<string, string> = {};
  // 仅提示本文件的编辑选择，不代表已解析当前会话的认证来源
  values.auth = envFields.some(
    ([key, field]) => field.role === 'token' && typeof env[key] === 'string' && env[key] !== '',
  )
    ? 'token'
    : 'key';
  for (const [key, field] of envFields) {
    const value = env[key];
    if (typeof value === 'string') {
      if (field.role === 'base') values.baseUrl = value;
      if (field.role === 'model') values[field.editor] = value;
    }
  }
  for (const [key, field] of rootFields)
    if (field.role === 'preference' && typeof settings[key] === 'string') values[key] = settings[key];
  if (values.baseUrl !== undefined) {
    try {
      const url = new URL(values.baseUrl);
      if (url.username || url.password || url.search || url.hash) delete values.baseUrl;
    } catch {
      delete values.baseUrl;
    }
  }
  return {
    id: 'settings',
    title: knownTitle('settings'),
    kind: 'settings',
    canInstall: true,
    location: ctx.settingsFile,
    values,
    facts: [{ code: hasApiConfiguration ? 'api-configured' : 'official-connection' }],
    actions: [
      'configure',
      'login',
      ...(connectionKeys.some(key => env[key] !== undefined) || helperKeys.some(key => settings[key] !== undefined)
        ? (['detach'] as const)
        : []),
    ],
  };
}

async function prepareSettings(ctx: Context, selection: Selection): Promise<Prepared> {
  if (!['configure', 'login', 'detach'].includes(selection.action)) throw new Error('action-unavailable');
  const settings = await json(ctx.machine, ctx.settingsFile);
  const env = object(settings.env);
  if (
    selection.action === 'detach' &&
    !connectionKeys.some(key => env[key] !== undefined) &&
    !helperKeys.some(key => settings[key] !== undefined)
  )
    throw new Error('no-connection');
  const fields = selection.action === 'detach' ? {} : (selection.fields ?? {});
  const changes: Record<string, unknown> = {};
  const preferences: Record<string, unknown> = {};
  const login: Prepared['run'] = async report => {
    success(await claudeCommand(ctx, ['auth', 'login'], true), 'login-failed');
    const status: unknown = JSON.parse(success(await claudeCommand(ctx, ['auth', 'status', '--json'])));
    if (!isObject(status) || status.loggedIn !== true) throw new Error('login-unconfirmed');
    report({ state: 'done', code: 'logged-in' });
  };
  if (selection.action === 'login') return { changes: [{ code: 'login-browser' }], run: login };
  const shouldLogin = fields.mode === 'official' && fields.login === 'yes';
  const shouldControlHelper = selection.action === 'detach' || fields.mode === 'official' || fields.mode === 'api';
  if (selection.action === 'detach' || fields.mode === 'official') {
    for (const key of connectionKeys) changes[key] = undefined;
  }
  if (fields.mode === 'api') {
    const selectedCredential = fields.auth === 'token' ? 'token' : 'key';
    let base = fields.baseUrl?.trim();
    let credential = fields.secret?.trim();
    for (const [key, field] of envFields) {
      const value = env[key];
      if (typeof value !== 'string') continue;
      if (field.role === 'base') base ??= value.trim();
      if (field.role === selectedCredential) credential ||= value;
    }
    const problem = apiConfigurationProblem(base, Boolean(credential?.trim()));
    if (problem) throw new Error(problem);
    for (const [key, field] of envFields) {
      if (field.role === 'base') changes[key] = base;
      if (field.role === 'key' || field.role === 'token')
        changes[key] = field.role === selectedCredential ? credential : undefined;
    }
  }
  if (shouldControlHelper) for (const key of helperKeys) if (settings[key] !== undefined) preferences[key] = undefined;
  for (const [key, field] of envFields)
    if (field.role === 'model' && fields[field.editor] !== undefined)
      changes[key] = fields[field.editor]?.trim() || undefined;
  for (const [key, field] of rootFields)
    if (field.role === 'preference' && fields[key] !== undefined) preferences[key] = fields[key] || undefined;
  if ((ctx.inheritedKeys ?? []).some(key => Object.hasOwn(changes, key)))
    throw new Error('inherited-configuration-conflict');
  let isSaved = false;
  let isComplete = false;
  let defaults: ReturnType<typeof initializeDefaults> | undefined;
  const verify = async () => {
    const after = await json(ctx.machine, ctx.settingsFile);
    for (const [key, value] of Object.entries(changes)) unchanged(object(after.env)[key], value);
    for (const [key, value] of Object.entries(preferences)) unchanged(after[key], value);
    for (const [key, value] of Object.entries(defaults?.env ?? {})) unchanged(object(after.env)[key], value);
    for (const [key, value] of Object.entries(defaults?.root ?? {})) unchanged(after[key], value);
  };
  const operation: Prepared = {
    writes: [ctx.settingsFile],
    changes: [
      { code: selection.action === 'detach' ? 'settings-disconnect' : 'settings-edit', detail: ctx.settingsFile },
      ...(shouldLogin ? [{ code: 'login-browser' }] : []),
    ],
    async run(report, signal) {
      if (isSaved) await verify();
      else {
        await ctx.effects.editJson(ctx.settingsFile, current => {
          const currentEnv = object(current.env);
          if (shouldControlHelper) for (const key of helperKeys) unchanged(current[key], settings[key]);
          for (const [key, value] of Object.entries(changes)) {
            unchanged(currentEnv[key], env[key]);
            if (value === undefined) delete currentEnv[key];
            else currentEnv[key] = value;
          }
          for (const [key, value] of Object.entries(preferences)) {
            unchanged(current[key], settings[key]);
            if (value === undefined) delete current[key];
            else current[key] = value;
          }
          current.env = currentEnv;
          if (selection.action === 'configure') defaults = initializeDefaults(current, ctx);
          orderFields(currentEnv, envFields);
          orderFields(current, rootFields);
        });
        isSaved = true;
        report({ state: 'done', code: 'settings-saved' });
        await verify();
      }
      if (shouldLogin) {
        cancelled(signal);
        await login(report, signal);
      }
      isComplete = true;
    },
    remaining: () => (isComplete ? undefined : operation),
    verify,
  };
  return operation;
}
