import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { isObject, succeeded } from './machine.js';
import type { CommandResult, Machine, ReadMachine } from './machine.js';

export type Action =
  'install' | 'connect' | 'update' | 'reinstall' | 'configure' | 'login' | 'detach' | 'uninstall' | 'clean';
export type Kind = 'claude' | 'settings' | 'plugin' | 'mcp' | 'skill' | 'command' | 'officecli' | 'ccline' | 'data';
export interface Item {
  /** 稳定定位标识（kind 前缀 + 实际键/路径） */
  readonly id: string;
  /** 显示标题：已确认身份取已知标题表官方名，未知保留原始名 */
  readonly title: string;
  readonly kind: Kind;
  readonly facts: readonly Change[];
  readonly actions: readonly Action[];
  /** 可进入普通安装流程：安装缺失程序，或复用已有程序并补齐接入/配置；不表示从未安装 */
  readonly canInstall?: boolean;
  readonly location?: string;
  readonly problem?: string;
  readonly skillSet?: string;
  readonly values?: Readonly<Record<string, string>>;
}
export interface Change {
  readonly code: string;
  readonly detail?: string;
}
export interface Selection {
  readonly id: string;
  readonly action: Action;
  readonly fields?: Readonly<Record<string, string>>;
  readonly removeData?: boolean;
}
export interface Pick {
  readonly id: string;
  readonly fields?: Readonly<Record<string, string>>;
  readonly maintenance?: 'update' | 'reinstall' | 'login';
  readonly removal?: 'detach';
}
export type Request =
  | { readonly task: 'install' | 'detach' | 'clean'; readonly selected: readonly Pick[] }
  | { readonly task: 'uninstall'; readonly selected: readonly Pick[]; readonly removeData?: boolean }
  | { readonly resume: string; readonly inputs?: Readonly<Record<string, Readonly<Record<string, string>>>> };
export interface Effect extends Change {
  readonly state: 'done' | 'kept' | 'failed' | 'skipped';
}
export interface ItemResult {
  readonly id: string;
  /** 冻结自计划条目的显示标题 */
  readonly title: string;
  readonly state: 'done' | 'partial' | 'failed' | 'cancelled';
  readonly effects: readonly Effect[];
  readonly isPending?: boolean;
}
export interface Inspection {
  readonly items: readonly Item[];
  readonly problems: readonly Change[];
  /** 同族项已并入程序条目：这些 id 的连接条目不再单列，检查合并时剔除 */
  readonly grouped?: readonly string[];
}
export interface PlanItem {
  readonly id: string;
  /** 核心生成并冻结的显示标题；调用方不提供 */
  readonly title: string;
  readonly action: Action;
  readonly changes: readonly Change[];
  readonly problem: string | null;
}
export interface Plan {
  readonly id: string;
  readonly items: readonly PlanItem[];
  readonly problem: string | null;
}
export interface RunResult {
  readonly state: 'done' | 'partial' | 'failed' | 'cancelled';
  readonly items: readonly ItemResult[];
  readonly remaining?: string;
}
export type Progress =
  | { readonly kind: 'started'; readonly id: string }
  | { readonly kind: 'effect'; readonly id: string; readonly effect: Effect }
  | { readonly kind: 'finished'; readonly id: string; readonly result: ItemResult };
export type PreparationStage = 'inspect' | 'metadata' | 'download' | 'source';
export interface PreparationProgress {
  readonly id: string;
  /** 对象尚未解析时的实际标识；解析后计划条目携带核心确认的标题 */
  readonly title: string;
  readonly stage: PreparationStage;
}
export interface CcwOptions {
  readonly machine: Machine;
  readonly home: string;
  readonly claudeRoot: string;
  readonly cclineRoot: string;
  readonly platform: 'win32' | 'darwin' | 'linux';
  readonly claudeState?: string;
  readonly inheritedKeys?: readonly string[];
  readonly localAppData?: string;
  readonly arch?: string;
  readonly libc?: 'glibc' | 'musl';
  readonly scoopRoot?: string;
}
export interface Context extends Omit<CcwOptions, 'machine'> {
  readonly machine: ReadMachine;
  readonly effects: Machine;
  readonly settingsFile: string;
  readonly stateFile: string;
  readonly storage: string;
}
export interface Prepared {
  readonly changes: readonly Change[];
  readonly operations: readonly OperationDefinition[];
  /** 仅在当前进程保留的输入；绝不写入任务记录。 */
  readonly inputs?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };
export interface OperationDefinition {
  readonly id: string;
  readonly itemId: string;
  readonly handler: string;
  readonly payload: JsonObject;
  readonly dependsOn: readonly string[];
  readonly changes: readonly Change[];
  readonly requiresInput?: readonly string[];
}
export type OperationPhase = 'preparing' | 'awaiting-confirmation' | 'executing' | 'paused' | 'completed';
export type OperationStatus = 'pending' | 'issued' | 'confirmed' | 'failed' | 'checking' | 'unneeded';
export interface OperationFact {
  readonly status: OperationStatus;
  /** 首次确认是历史事实；后续目标漂移不能将其重新变成可派发。 */
  readonly confirmed?: true;
  readonly attemptId?: string;
  readonly dispatch?: JsonObject;
  readonly receipt?:
    | { readonly kind: 'returned'; readonly failure: string | null }
    | { readonly kind: 'unknown'; readonly failure: string };
  readonly evidence?: JsonObject;
  readonly problem?: string;
  readonly effects: readonly Effect[];
}
export type Assessment =
  | { readonly state: 'complete'; readonly evidence: JsonObject; readonly effects?: readonly Effect[] }
  | { readonly state: 'ready'; readonly dispatch?: JsonObject }
  | { readonly state: 'unknown' | 'blocked'; readonly problem: string }
  | { readonly state: 'unneeded'; readonly reason: string };
export interface OperationOutcome {
  readonly receipt: NonNullable<OperationFact['receipt']>;
  readonly evidence?: JsonObject;
  readonly effects?: readonly Effect[];
}
/** A missing exit status never proves that an external command returned. */
export function commandReceipt(result: CommandResult, failure: string): OperationOutcome['receipt'] {
  return result.failed || result.code === null
    ? { kind: 'unknown', failure }
    : { kind: 'returned', failure: succeeded(result) ? null : failure };
}
export interface OperationHandler {
  assess(
    definition: OperationDefinition,
    fact: OperationFact,
    facts: Readonly<Record<string, OperationFact>>,
  ): Promise<Assessment>;
  execute(
    definition: OperationDefinition,
    fact: OperationFact,
    inputs: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<OperationOutcome>;
}
export interface OperationRecord {
  readonly schema: 1;
  readonly id: string;
  readonly phase: OperationPhase;
  readonly planId: string;
  readonly intent: JsonObject;
  readonly items: readonly PlanItem[];
  readonly operations: readonly OperationDefinition[];
  readonly facts: Readonly<Record<string, OperationFact>>;
}
export interface Recovery {
  readonly id: string;
  readonly phase: OperationPhase;
  readonly intent: JsonObject;
  readonly items: readonly {
    readonly id: string;
    readonly title: string;
    readonly state: 'done' | 'pending' | 'unknown' | 'failed';
    readonly problem?: string;
  }[];
  readonly inputs: readonly { readonly operationId: string; readonly itemId: string; readonly field: string }[];
}
/** 补全计划显示标题；核心据此更新冻结标题并重启进度 */
export type Describe = (title: string) => void;

/** 约束域入口：检查统一交付聚合形状，数组/单项来源在域内归一 */
export interface Domain {
  inspect(): Promise<Inspection>;
  prepare(selection: Selection, describe?: Describe): Promise<Prepared>;
  readonly handlers?: Readonly<Record<string, OperationHandler>>;
}

export function context(options: CcwOptions): Context {
  for (const directory of [options.home, options.claudeRoot, options.cclineRoot])
    if (!path.isAbsolute(directory) || path.resolve(directory) === path.parse(path.resolve(directory)).root)
      throw new Error('invalid-config-root');
  return {
    ...options,
    effects: options.machine,
    settingsFile: path.join(options.claudeRoot, 'settings.json'),
    stateFile:
      options.claudeState ??
      path.join(
        options.claudeRoot === path.join(options.home, '.claude') ? options.home : options.claudeRoot,
        '.claude.json',
      ),
    storage: path.join(options.home, '.ccw'),
  };
}

export function claudeEnvironment(ctx: Context) {
  return { CLAUDE_CONFIG_DIR: ctx.stateFile === path.join(ctx.home, '.claude.json') ? undefined : ctx.claudeRoot };
}

/** POSIX 用户级可执行目录：Claude 原生安装、uv 与非 Windows OfficeCLI 的共同落点 */
export const userBinDirectory = (ctx: Context) => path.join(ctx.home, '.local/bin');
/** 用户级可执行目录内的平台二进制名（win32 补 .exe 后缀） */
export const userBinary = (ctx: Context, name: string) =>
  path.join(userBinDirectory(ctx), ctx.platform === 'win32' ? `${name}.exe` : name);

/** 状态文件内 MCP 注册表的键名与读取面：mcp、officecli 与退役迁移共用 */
export const MCP_SERVERS_KEY = 'mcpServers';
export const readMcpServers = async (ctx: Context): Promise<Record<string, unknown>> =>
  object((await json(ctx.machine, ctx.stateFile))[MCP_SERVERS_KEY]);

export function claudeProcessActive(name: string, command: string): boolean {
  return (
    /(?:^|[\\/])(?:claude|Claude Code)(?:\.exe)?$/i.test(name) ||
    (/(?:^|[\\/])node(?:js)?(?:\.exe)?$/i.test(name) &&
      /(?:^|[\\/\s"'])@anthropic-ai[\\/]claude-code(?:[\\/]|$)/i.test(command))
  );
}

/** Claude 运行判定：枚举失败保持未知（null），不臆断未运行 */
export async function claudeRunning(
  machine: { processes: ReadMachine['processes'] },
  signal?: AbortSignal,
): Promise<boolean | null> {
  const found = await machine.processes(signal);
  if (found === null) return null;
  return found.some(entry => claudeProcessActive(entry.name, entry.command));
}

/** 取 id 的 kind 段；"裸 id 或 kind: 前缀"的判定一律经此，不散写 startsWith */
export function kindOf(id: string): string {
  return id.split(':')[0] ?? id;
}

/** 取 kind 段后的余段：data: 的类别、mcp:/skill:/plugin: 的名字；裸 id 返回 undefined */
export function restOf(id: string): string | undefined {
  const index = id.indexOf(':');
  return index === -1 ? undefined : id.slice(index + 1);
}

/** Claude 用户数据清理项的固定 id：编排、路由、渲染与标题表共用 */
export const CLAUDE_DATA_ID = 'data:claude';
/** 「备份并替换」表单同意值：终端产生，技能与 OfficeCLI 域消费 */
export const REPLACE_CONSENT = 'yes';
/** 普通安装任务的默认动作：settings 项进入配置而非重装 */
export const defaultInstallAction = (id: string): Action => (id === 'settings' ? 'configure' : 'install');

/** 归一路径用于等价比较：win32 大小写不敏感 */
export function normalizePath(platform: Context['platform'], file: string) {
  return platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
}

/** 读取 JSON 对象；文件缺失回退空对象，解析失败或非对象抛 invalid-settings */
export async function json(machine: { read: ReadMachine['read'] }, file: string): Promise<Record<string, unknown>> {
  const text = await machine.read(file);
  let value: unknown;
  try {
    value = text === null ? {} : JSON.parse(text);
  } catch (error) {
    throw new Error('invalid-settings', { cause: error });
  }
  if (!isObject(value)) throw new Error('invalid-settings');
  return value;
}

/** 归一未定义为空对象；其余非对象抛 invalid-settings */
export function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isObject(value)) throw new Error('invalid-settings');
  return value;
}

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

/** 命令成功返回 stdout，失败抛给定码 */
export function success(result: CommandResult, code = 'command-failed') {
  if (!succeeded(result)) throw new Error(code);
  return result.stdout;
}

export function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('cancelled');
}
/** 断言值未变化；差异抛 target-changed */
export function unchanged(value: unknown, expected: unknown) {
  if (!isDeepStrictEqual(value, expected)) throw new Error('target-changed');
}

/** 合并冻结字段；提交后通知，再回读确认 */
export async function editFields(
  ctx: Context,
  file: string,
  before: Record<string, unknown>,
  changes: Record<string, unknown>,
  parent?: string,
  onWritten?: () => void,
) {
  await ctx.effects.editJson(file, document => {
    const target = parent === undefined ? document : object(document[parent]);
    for (const [key, value] of Object.entries(changes)) {
      unchanged(target[key], before[key]);
      if (value === undefined) delete target[key];
      else target[key] = value;
    }
    if (parent !== undefined) document[parent] = target;
  });
  onWritten?.();
  const after = await json(ctx.machine, file);
  const values = parent === undefined ? after : object(after[parent]);
  for (const [key, value] of Object.entries(changes)) unchanged(values[key], value);
}
