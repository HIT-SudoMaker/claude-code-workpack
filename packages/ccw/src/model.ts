import type { Work, Receipt } from './work.js';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { isObject, succeeded } from './machine.js';
import type { CommandResult, Machine, ReadMachine, EffectMachine } from './machine.js';

/** 由计划确定的实际操作；用户选择安装、移除或清理任务 */
export type Action = 'install' | 'update' | 'configure' | 'detach' | 'uninstall' | 'clean';
/** 检查结果所属的工具类别，技能套件也归入 skill */
export type Kind = 'claude' | 'settings' | 'plugin' | 'skill' | 'officecli' | 'ccline' | 'data';
/** 交付可展示的检查事实与菜单资格，不携带凭据内容 */
export interface Item {
  /** 稳定定位标识（kind 前缀 + 实际键/路径） */
  readonly id: string;
  /** 显示标题不代替程序或来源身份验证 */
  readonly title: string;
  readonly kind: Kind;
  readonly facts: readonly Change[];
  /** 可进入安装配置流程，包括安装缺失程序和补齐已有程序的接入 */
  readonly canInstall?: boolean;
  readonly canUninstall?: boolean;
  readonly canClean?: boolean;
  readonly location?: string;
  /** 仅供展示归组的 npm 启动脚本关联，不授予安装或卸载能力 */
  readonly launcherFor?: string;
  readonly problem?: string;
  readonly skillSet?: string;
  readonly values?: Readonly<Record<string, string>>;
  /** 只表明本地是否存在有效凭据，供编辑器校验留空输入 */
  readonly hasCredential?: boolean;
}
/** 可展示的事实或变更说明；detail 不应包含凭据 */
export interface Change {
  readonly code: string;
  readonly detail?: string;
}
/** 用户选择的对象和本次编辑字段，可能暂存未保存凭据 */
export interface Pick {
  readonly id: string;
  readonly fields?: Readonly<Record<string, string>>;
}
/** 为用户选择补充计划确定的实际操作 */
export interface Selection extends Pick {
  readonly action: Action;
}
/** 当前计划支持的批次任务；页面布局和导航由终端独立决定 */
export interface Request {
  readonly task: 'install' | 'uninstall' | 'clean';
  readonly selected: readonly Pick[];
}
/** 执行后已知的效果及其状态，不等同于整个对象成功 */
export interface Effect extends Change {
  readonly state: 'done' | 'kept' | 'failed' | 'skipped';
}
/** 一个计划条目的最终或阶段性核验结果 */
export interface ItemResult {
  readonly id: string;
  /** 冻结自计划条目的显示标题 */
  readonly title: string;
  readonly state: 'done' | 'partial' | 'failed' | 'cancelled' | 'skipped';
  readonly effects: readonly Effect[];
}
/** 汇总检查条目和未能归入单项的读取问题 */
export interface Inspection {
  readonly items: readonly Item[];
  readonly problems: readonly Change[];
}
/** 不含秘密的单项预览；problem 非空时该项不可执行 */
export interface PlanItem {
  readonly id: string;
  /** 核心生成并冻结的显示标题；调用方不提供 */
  readonly title: string;
  readonly action: Action;
  readonly changes: readonly Change[];
  readonly problem: string | null;
}
/** 公开的内存计划预览；标识仅对创建它的 CCW 实例有效 */
export interface Plan {
  readonly id: string;
  readonly items: readonly PlanItem[];
  readonly problem: string | null;
}
/** 汇总实际执行结果，包括部分完成和取消 */
export interface RunResult {
  readonly state: 'done' | 'partial' | 'failed' | 'cancelled';
  readonly items: readonly ItemResult[];
}
/** 执行进度；checked 是单项阶段结果，finished 是整批复核后的结果 */
export type Progress =
  | { readonly kind: 'started'; readonly id: string }
  | { readonly kind: 'effect'; readonly id: string; readonly effect: Effect }
  | { readonly kind: 'checked'; readonly id: string; readonly result: ItemResult }
  | { readonly kind: 'finished'; readonly id: string; readonly result: ItemResult };
/** 标识当前资源准备步骤，不代表步骤已经完成 */
export type PreparationStage = 'inspect' | 'metadata' | 'download' | 'source';
/** 关联准备步骤与所属对象，供界面显示进度 */
export interface PreparationProgress {
  readonly id: string;
  /** 由计划路由生成的展示标题，不证明来源或程序身份 */
  readonly title: string;
  readonly stage: PreparationStage;
}
/** 装配 CCW 所需的系统适配器、配置根及平台事实 */
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
}
/** 向工具域提供配置路径以及相互分离的读写能力 */
export interface Context extends Omit<CcwOptions, 'machine'> {
  readonly machine: ReadMachine;
  readonly effects: EffectMachine;
  readonly settingsFile: string;
  readonly stateFile: string;
  readonly storage: string;
}
/** 保留执行闭包、实际动作和依赖能力，不能作为公开预览序列化 */
export interface Prepared extends Work {
  readonly action?: Action;
  readonly claude?: ClaudeCommand;
  readonly skillDirectories?: readonly string[];
}

/** 绑定已选择的 Claude 入口，每次调用前重新核验其身份 */
export interface ClaudeCommand {
  /** 核验绑定入口；依赖未就绪或文件变化时拒绝 */
  verify(): Promise<void>;
  /**
   * 通过已绑定入口执行 Claude 命令
   *
   * @param args - 传给 Claude 的命令参数
   * @param interactive - 是否向命令交接交互终端
   * @returns 原始命令结果，非零退出码不是成功证明
   * @throws Error - 入口核验、派发资格或底层执行失败时拒绝
   */
  execute(args: readonly string[], interactive?: boolean): Promise<CommandResult>;
}

/** 可表示的 JSON 值；字段删除另用 undefined 表达 */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
/**
 * 统一工具域的检查与准备入口，具体策略留在域内
 *
 * @remarks 域工厂只装配接口；调用 inspect 或 prepare 时才读取系统与来源
 * prepare 返回延迟执行的工作项，实际写入由 CCW 派发
 */
export interface Domain {
  /** 读取当前事实；不修改受管目标，读取异常可由 CCW 汇总 */
  inspect(): Promise<Inspection>;
  /**
   * 准备工具变更及其核验闭包
   *
   * @param selection - 已解析的用户选择与实际操作
   * @param claude - 按需获取本次计划绑定的 Claude 调用能力；是否需要由工具域决定
   * @returns 延迟执行的变更；允许查询和暂存来源，不写入受管目标
   * @throws Error - 选择校验可同步抛错；来源冲突、资源读取等异步失败使 Promise 拒绝
   */
  prepare(selection: Selection, claude?: () => Promise<ClaudeCommand>): Promise<Prepared>;
}

/**
 * 校验配置根并推导用户配置与 CCW 存储路径
 *
 * @param options - 用户目录、配置根、平台及注入的系统能力
 * @returns 工具域上下文，不创建目录或配置文件
 * @throws Error - home、claudeRoot 或 cclineRoot 不是绝对路径或指向文件系统根
 */
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

/** 返回用户 .local/bin 路径，不创建目录 */
export const userBinDirectory = (ctx: Context) => path.join(ctx.home, '.local/bin');
/** 拼接用户可执行文件路径，在 Windows 下补充 .exe 后缀 */
export const userBinary = (ctx: Context, name: string) =>
  path.join(userBinDirectory(ctx), ctx.platform === 'win32' ? `${name}.exe` : name);

/** 返回标识首个冒号之前的类别；不含冒号时返回原标识 */
export function kindOf(id: string): string {
  return id.split(':')[0] ?? id;
}

/** 返回首个冒号之后的名字或路径；不含冒号时返回 undefined */
export function restOf(id: string): string | undefined {
  const index = id.indexOf(':');
  return index === -1 ? undefined : id.slice(index + 1);
}

/** 解析绝对路径供比较使用；Windows 路径转为小写，不解析符号链接 */
export function normalizePath(platform: Context['platform'], file: string) {
  return platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
}

/**
 * 读取并解析 JSON 对象
 *
 * @param machine - 读取文件文本的能力，文件缺失以 null 表示
 * @param file - 目标 JSON 文件路径
 * @returns 解析后的对象；文件缺失时返回空对象
 * @throws Error - JSON 无效或不是对象时抛出 invalid-settings；读取异常原样传播
 */
export async function json(
  machine: { readonly read: ReadMachine['read'] },
  file: string,
): Promise<Record<string, unknown>> {
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

/** 将 undefined 视为空对象，其余非对象值以 invalid-settings 拒绝 */
export function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isObject(value)) throw new Error('invalid-settings');
  return value;
}

/**
 * 将命令结果转换为回执，不据此确认最终效果
 *
 * @param result - 底层适配器返回的命令结果
 * @param failure - 命令失败或未确认返回时记录的问题码
 * @returns 底层标记失败或退出码缺失时为未知回执，否则记录退出码是否为零
 */
export function commandReceipt(result: CommandResult, failure: string): Receipt {
  return result.failed || result.code === null
    ? { kind: 'unknown', failure }
    : { kind: 'returned', failure: succeeded(result) ? null : failure };
}

/** 返回成功命令的 stdout；失败时抛出指定问题码 */
export function success(result: CommandResult, code = 'command-failed') {
  if (!succeeded(result)) throw new Error(code);
  return result.stdout;
}

/** 取消信号已触发时抛出 cancelled，未提供信号时不做处理 */
export function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('cancelled');
}
/** 深度比较当前值与冻结值；不相等时抛出 target-changed */
export function unchanged(value: unknown, expected: unknown) {
  if (!isDeepStrictEqual(value, expected)) throw new Error('target-changed');
}
