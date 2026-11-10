import { createHash } from 'node:crypto';
import { knownTitle } from './titles.js';
import { isObject } from './machine.js';
import { apiConfigurationProblem, commandReceipt, json, object, success } from './model.js';
import type {
  Context,
  Domain,
  Item,
  Prepared,
  Selection,
  Json,
  OperationDefinition,
  OperationHandler,
} from './model.js';
import { claudeCommand } from './programs.js';

export function createSettingsDomain(ctx: Context): Domain {
  return {
    async inspect() {
      return { items: [await inspectSettings(ctx)], problems: [] };
    },
    prepare(selection) {
      if (selection.id !== 'settings') throw new Error('unknown-selection');
      return prepareSettings(ctx, selection);
    },
    handlers: settingsHandlers(ctx),
  };
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

export async function prepareSettings(ctx: Context, selection: Selection): Promise<Prepared> {
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
  if (selection.action === 'login')
    return {
      changes: [{ code: 'login-browser' }],
      operations: [loginDefinition(selection.id, [])],
    };
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
      else if (!Object.hasOwn(preferences, key)) add([key], settings[key], value, false, true);
  }
  const id = selection.id + '/settings';
  const requiresSecret = fields.mode === 'api' && Boolean(fields.secret?.trim());
  const definition: OperationDefinition = {
    id,
    itemId: selection.id,
    handler: 'settings.write',
    dependsOn: [],
    writes: [ctx.settingsFile],
    changes: [
      { code: selection.action === 'detach' ? 'settings-disconnect' : 'settings-edit', detail: ctx.settingsFile },
    ],
    payload: { file: ctx.settingsFile, patches },
    ...(requiresSecret ? { requiresInput: ['secret'] } : {}),
  };
  return {
    writes: definition.writes,
    changes: [...definition.changes, ...(shouldLogin ? [{ code: 'login-browser' }] : [])],
    operations: [definition, ...(shouldLogin ? [loginDefinition(selection.id, [id])] : [])],
    ...(requiresSecret ? { inputs: { [id]: { secret: fields.secret!.trim() } } } : {}),
  };
}

type SettingsPatch = {
  readonly path: readonly string[];
  readonly before: string;
  readonly after: string;
  readonly mode: 'absent' | 'credential' | 'value' | 'default';
  readonly value: Json;
};
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
function patchesOf(definition: OperationDefinition): readonly SettingsPatch[] {
  const patches = definition.payload.patches;
  const isPatch = (value: unknown): value is SettingsPatch =>
    isObject(value) &&
    Array.isArray(value.path) &&
    value.path.length > 0 &&
    value.path.every(part => typeof part === 'string') &&
    typeof value.before === 'string' &&
    typeof value.after === 'string' &&
    ['absent', 'credential', 'value', 'default'].includes(String(value.mode)) &&
    Object.hasOwn(value, 'value');
  if (!Array.isArray(patches) || !patches.every(isPatch)) throw new Error('operation-record-invalid');
  return patches;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify({ value })).digest('hex');
function valueAt(document: Record<string, unknown>, parts: readonly string[]): unknown {
  let current: unknown = document;
  for (const part of parts) current = object(current)[part];
  return current;
}
function loginDefinition(itemId: string, dependsOn: readonly string[]): OperationDefinition {
  return {
    id: itemId + '/login',
    itemId,
    handler: 'settings.login',
    payload: {},
    dependsOn,
    writes: [],
    changes: [{ code: 'login-browser' }],
  };
}
function settingsHandlers(ctx: Context): Readonly<Record<string, OperationHandler>> {
  return {
    'settings.write': {
      async assess(definition, fact) {
        if (definition.payload.file !== ctx.settingsFile) return { state: 'blocked', problem: 'target-changed' };
        const patches = patchesOf(definition);
        const current = await json(ctx.machine, ctx.settingsFile);
        const defaults = Object.fromEntries(
          patches
            .filter(patch => patch.mode === 'default')
            .map(patch => {
              const value = valueAt(current, patch.path);
              return [
                patch.path.join('/'),
                value === undefined && !(patch.path[0] === 'attribution' && current.includeCoAuthoredBy === true)
                  ? patch.after
                  : digest(value),
              ];
            }),
        );
        const expectedDefaults = object(fact.dispatch?.defaults ?? defaults);
        if (
          patches.every(
            patch =>
              digest(valueAt(current, patch.path)) ===
              (patch.mode === 'default' ? expectedDefaults[patch.path.join('/')] : patch.after),
          )
        )
          return {
            state: 'complete',
            evidence: { matched: true },
            effects: [{ state: 'done', code: 'settings-saved' }],
          };
        if (fact.confirmed || (fact.receipt?.kind === 'returned' && fact.receipt.failure === null))
          return { state: 'unknown', problem: 'target-changed' };
        if (patches.every(patch => patch.mode === 'default' || digest(valueAt(current, patch.path)) === patch.before))
          return { state: 'ready', dispatch: { defaults } };
        return { state: 'unknown', problem: 'target-changed' };
      },
      async execute(definition, fact, inputs) {
        const patches = patchesOf(definition);
        await ctx.effects.editJson(ctx.settingsFile, current => {
          for (const patch of patches) {
            if (patch.mode === 'default') {
              const value = valueAt(current, patch.path);
              const expected = object(fact.dispatch?.defaults)[patch.path.join('/')];
              if (value !== undefined || (patch.path[0] === 'attribution' && current.includeCoAuthoredBy === true)) {
                if (digest(value) !== expected) throw new Error('target-changed');
                continue;
              }
              if (expected !== patch.after) throw new Error('target-changed');
            } else if (digest(valueAt(current, patch.path)) !== patch.before) throw new Error('target-changed');
            let parent = current;
            for (const part of patch.path.slice(0, -1)) {
              const child = object(parent[part]);
              parent[part] = child;
              parent = child;
            }
            const key = patch.path.at(-1)!;
            if (patch.mode === 'absent') delete parent[key];
            else if (patch.mode === 'credential') {
              const credential = inputs.secret ?? parent[key];
              if (digest(credential) !== patch.after) throw new Error('credential-required');
              parent[key] = credential;
            } else parent[key] = patch.value;
          }
          if (current.env !== undefined) orderFields(object(current.env), envFields);
          orderFields(current, rootFields);
        });
        return { receipt: { kind: 'returned', failure: null }, effects: [{ state: 'done', code: 'settings-saved' }] };
      },
    },
    'settings.login': {
      async assess(_definition, fact) {
        if (fact.status === 'pending' || (fact.receipt?.kind === 'returned' && fact.receipt.failure))
          return { state: 'ready' };
        const status: unknown = JSON.parse(success(await claudeCommand(ctx, ['auth', 'status', '--json'])));
        return isObject(status) && status.loggedIn === true
          ? { state: 'complete', evidence: { loggedIn: true }, effects: [{ state: 'done', code: 'logged-in' }] }
          : { state: 'unknown', problem: 'login-unconfirmed' };
      },
      async execute() {
        const result = await claudeCommand(ctx, ['auth', 'login'], true);
        return { receipt: commandReceipt(result, 'login-failed') };
      },
    },
  };
}
