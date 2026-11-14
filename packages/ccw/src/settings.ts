import type { Change } from './model.js';
import { step, sequence } from './work.js';
import { knownTitle } from './management-catalog.js';
import { isObject } from './machine.js';
import { commandReceipt, json, object, success } from './model.js';
import type { Context, Item, Prepared, Selection, Json, ClaudeCommand } from './model.js';
import { applyFrozenJson, assessFrozenJson, jsonField, jsonFingerprint as digest } from './frozen-json.js';

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

type SettingsPatch = {
  readonly path: readonly string[];
  readonly before: string;
  readonly after: string;
  readonly mode: 'absent' | 'credential' | 'value' | 'default';
  readonly value: Json;
};

// 保留字段只定位已有键；偏好默认值由编辑器提交，不在安装初始化时补齐
const ROOT_FIELDS = {
  $schema: { placement: 'prefix', role: 'preserve' },
  defaultShell: { placement: 'prefix', role: 'preserve' },
  permissions: { placement: 'prefix', role: 'preserve' },
  includeCoAuthoredBy: { placement: 'prefix', role: 'preserve' },
  attribution: { placement: 'prefix', role: 'attribution', value: { commit: '', pr: '', sessionUrl: false } },
  language: { placement: 'prefix', role: 'preference' },
  outputStyle: { placement: 'prefix', role: 'preference' },
  statusLine: { placement: 'prefix', role: 'preserve' },
  enabledPlugins: { placement: 'prefix', role: 'preserve' },
  autoCompactEnabled: { placement: 'prefix', role: 'preserve' },
  autoCompactWindow: { placement: 'prefix', role: 'preserve' },
  autoUpdatesChannel: { placement: 'prefix', role: 'preserve' },
  skipDangerousModePermissionPrompt: { placement: 'prefix', role: 'preserve' },
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

/**
 * 准备模型连接、偏好和默认设置变更
 *
 * @param selection - configure 可留空凭据以沿用所选认证类型；detach 只移除连接字段和凭据助手
 * @param claude - 官方登录所需的绑定命令
 * @returns 预览不含凭据的延迟流程，执行时复核字段并保留无关设置
 * @throws Error - 读取、动作、连接字段、登录依赖无效，无连接可解除或继承环境变量冲突时拒绝
 * @remarks 登录失败或取消不回滚已保存设置
 */
export async function prepareSettings(ctx: Context, selection: Selection, claude?: ClaudeCommand): Promise<Prepared> {
  if (!['configure', 'detach'].includes(selection.action)) throw new Error('action-unavailable');
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
  const shouldLogin = fields.mode === 'official' && fields.login === 'yes';
  if (shouldLogin && !claude) throw new Error('claude-not-installed');
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
  if (shouldControlHelper) for (const key of helperKeys) preferences[key] = undefined;
  for (const [key, field] of envFields)
    if (field.role === 'model' && fields[field.editor] !== undefined)
      changes[key] = fields[field.editor]?.trim() || undefined;
  for (const [key, field] of rootFields)
    if (field.role === 'preference' && fields[key] !== undefined) preferences[key] = fields[key] || undefined;
  if ((ctx.inheritedKeys ?? []).some(key => Object.hasOwn(changes, key)))
    throw new Error('inherited-configuration-conflict');
  const patches: SettingsPatch[] = [];
  const add = (parts: string[], before: unknown, after: unknown, isSecret = false, isDefault = false) => {
    patches.push({
      path: parts,
      before: digest(before),
      after: digest(after),
      mode: isDefault ? 'default' : after === undefined ? 'absent' : isSecret ? 'credential' : 'value',
      value: after === undefined || isSecret ? null : jsonValue(after),
    });
  };
  for (const [key, value] of Object.entries(changes))
    add(
      ['env', key],
      env[key],
      value,
      ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].includes(key) && value !== undefined,
    );
  for (const [key, value] of Object.entries(preferences)) add([key], settings[key], value);
  if (selection.action === 'configure') {
    const draft = structuredClone(settings);
    const draftEnv = { ...env };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete draftEnv[key];
      else draftEnv[key] = value;
    }
    draft.env = draftEnv;
    const defaults = initializeDefaults(draft, ctx);
    for (const [key, value] of Object.entries(defaults.env))
      if (!Object.hasOwn(changes, key)) add(['env', key], env[key], value, false, true);
    for (const [key, value] of Object.entries(defaults.root))
      if (key === 'permissions')
        add(
          ['permissions', 'defaultMode'],
          object(settings.permissions).defaultMode,
          object(value).defaultMode,
          false,
          true,
        );
      else if (!Object.hasOwn(preferences, key)) add([key], settings[key], value, false, key !== 'autoUpdatesChannel');
  }
  const write = writeSettings(ctx, patches, fields.secret?.trim() || undefined, [
    { code: selection.action === 'detach' ? 'settings-disconnect' : 'settings-edit', detail: ctx.settingsFile },
  ]);
  return shouldLogin && claude
    ? sequence([
        step([], async () => {
          await claude.verify();
          return { state: 'complete' };
        }),
        write,
        loginWork(claude),
      ])
    : write;
}

/** 供 Claude 管理域检查模型设置；只返回公开字段和凭据存在标记 */
export async function inspectSettings(ctx: Context): Promise<Item> {
  const settings = await json(ctx.machine, ctx.settingsFile);
  const env = object(settings.env);
  const hasApiConfiguration = envFields.some(
    ([key, field]) => ['base', 'key', 'token'].includes(field.role) && typeof env[key] === 'string',
  );
  const values: Record<string, string> = {};
  if (hasApiConfiguration || Object.keys(settings).length > 0) values.mode = hasApiConfiguration ? 'api' : 'official';
  // 仅提示本文件的编辑选择，不代表已解析当前会话的认证来源
  values.auth = envFields.some(
    ([key, field]) => field.role === 'token' && typeof env[key] === 'string' && env[key].trim() !== '',
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
    hasCredential: envFields.some(
      ([key, field]) => field.role === values.auth && typeof env[key] === 'string' && env[key].trim() !== '',
    ),
    facts: [{ code: hasApiConfiguration ? 'api-configured' : 'official-connection' }],
    canUninstall:
      connectionKeys.some(key => env[key] !== undefined) || helperKeys.some(key => settings[key] !== undefined),
  };
}

function writeSettings(
  ctx: Context,
  patches: readonly SettingsPatch[],
  secret: string | undefined,
  changes: readonly Change[],
) {
  let frozenDefaults: Record<string, string> | undefined;
  return step(
    changes,
    async fact => {
      const current = await json(ctx.machine, ctx.settingsFile);
      const defaults = Object.fromEntries(
        patches
          .filter(patch => patch.mode === 'default')
          .map(patch => {
            const value = jsonField(current, patch.path);
            return [
              patch.path.join('/'),
              value === undefined && !(patch.path[0] === 'attribution' && current.includeCoAuthoredBy === true)
                ? patch.after
                : digest(value),
            ];
          }),
      );
      const expectedDefaults = frozenDefaults ?? defaults;
      const assessment = assessFrozenJson(
        current,
        patches.map(patch => ({
          path: patch.path,
          before:
            patch.mode === 'default' ||
            (patch.path[0] === 'autoUpdatesChannel' && digest(current.autoUpdatesChannel) === patch.after)
              ? digest(jsonField(current, patch.path))
              : patch.before,
          after: patch.mode === 'default' ? String(expectedDefaults[patch.path.join('/')]) : patch.after,
        })),
        fact,
      );
      if (assessment.state === 'complete')
        return {
          ...assessment,
          effects: [{ state: 'done', code: 'settings-saved' }],
        };
      if (assessment.state === 'ready') frozenDefaults = defaults;
      return assessment;
    },
    async () => {
      await ctx.effects.editJson(ctx.settingsFile, current => {
        const fields = patches.map(patch => {
          const currentValue = jsonField(current, patch.path);
          if (patch.mode === 'default') {
            const expected = frozenDefaults?.[patch.path.join('/')];
            const eligible =
              currentValue === undefined && !(patch.path[0] === 'attribution' && current.includeCoAuthoredBy === true);
            if (eligible && expected !== patch.after) throw new Error('target-changed');
            return {
              path: patch.path,
              before: eligible ? patch.before : String(expected),
              after: String(expected),
              value: eligible ? patch.value : currentValue,
            };
          }
          const value =
            patch.mode === 'absent' ? undefined : patch.mode === 'credential' ? (secret ?? currentValue) : patch.value;
          if (patch.mode === 'credential' && digest(value) !== patch.after) throw new Error('credential-required');
          return {
            path: patch.path,
            before:
              patch.path[0] === 'autoUpdatesChannel' && digest(currentValue) === patch.after
                ? patch.after
                : patch.before,
            after: patch.after,
            value,
          };
        });
        applyFrozenJson(current, fields);
        if (current.env !== undefined) orderFields(object(current.env), envFields);
        orderFields(current, rootFields);
      });
      return { receipt: { kind: 'returned', failure: null }, effects: [{ state: 'done', code: 'settings-saved' }] };
    },
  );
}

function loginWork(claude: ClaudeCommand): Prepared {
  const login = step(
    [{ code: 'login-browser' }],
    async fact => {
      await claude.verify();
      if (!fact.dispatched || (fact.receipt?.kind === 'returned' && fact.receipt.failure)) return { state: 'ready' };
      const status: unknown = JSON.parse(success(await claude.execute(['auth', 'status', '--json'])));
      return isObject(status) && status.loggedIn === true
        ? { state: 'complete', effects: [{ state: 'done', code: 'logged-in' }] }
        : { state: 'blocked', problem: 'login-unconfirmed' };
    },
    async () => {
      const result = await claude.execute(['auth', 'login'], true);
      return { receipt: commandReceipt(result, 'login-failed') };
    },
  );
  return login;
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
  // 始终使用 stable 通道；首次危险模式确认使用官方设置
  if (settings.autoUpdatesChannel !== 'stable') {
    settings.autoUpdatesChannel = 'stable';
    root.autoUpdatesChannel = 'stable';
  }
  if (settings.skipDangerousModePermissionPrompt === undefined) {
    settings.skipDangerousModePermissionPrompt = true;
    root.skipDangerousModePermissionPrompt = true;
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

function jsonValue(value: unknown): Json {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]));
  throw new Error('invalid-settings');
}

/**
 * 校验 API 地址和凭据存在性，不连接远端服务
 *
 * @param baseUrl - 可带首尾空白的 HTTP 或 HTTPS 地址
 * @param hasCredential - 调用方已确认是否存在有效凭据
 * @returns 缺少字段或地址格式的问题码；校验通过时为 null
 */
export function apiConfigurationProblem(baseUrl: string | undefined, hasCredential: boolean): string | null {
  if (!baseUrl?.trim()) return hasCredential ? 'base-url-required' : 'api-fields-required';
  try {
    const url = new URL(baseUrl.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.password || url.username || url.search || url.hash)
      return 'invalid-base-url';
  } catch {
    return 'invalid-base-url';
  }
  return hasCredential ? null : 'credential-required';
}
