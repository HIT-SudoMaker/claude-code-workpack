import {
  FETCH_BYTES_TIMEOUT_MS,
  FETCH_TEXT_TIMEOUT_MS,
  GIT_COMMAND_TIMEOUT_MS,
  READ_COMMAND_TIMEOUT_MS,
  SOURCE_TIMEOUT_MS,
} from './machine.js';
import type { CommandOptions, ReadMachine } from './machine.js';
import { cancelled } from './model.js';
import { SKILLS_CLI } from './management-catalog.js';
import type { PreparationStage } from './model.js';

/** 约束当前读取的取消、单调时钟绝对期限与可选准备进度 */
export interface ReadScope {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly commandTimeoutMs?: number;
  readonly timeoutCode?: 'verification-timeout';
  readonly report?: (stage: PreparationStage) => void;
}

/**
 * 限定观察命令，管理读取预算、取消和准备进度
 *
 * @param current - 当前作用域，deadlineMs 以 performance.now() 为基准
 * @param options - shouldShareReads 按原始参数缓存 read、entries、realpath、locate 的 Promise
 * @returns 读取包装；缓存值克隆返回，失败也缓存，每次检查须新建实例
 * @throws 取消为 cancelled，非观察命令为 read-command-not-allowed；底层及进度异常原样传播
 * @remarks 作用域预算仅限制命令和远端读取；耗尽使用 timeoutCode，默认 inspection-timeout
 * 所有读取前后均检查取消，缓存命中也不例外
 */
export function createReadMachine(
  machine: ReadMachine,
  current: () => ReadScope | undefined,
  options: { readonly shouldShareReads?: boolean } = {},
): ReadMachine {
  const read = async <T>(work: (signal?: AbortSignal) => Promise<T>, cancellation?: AbortSignal) => {
    const scope = current();
    const signal =
      cancellation && scope?.signal ? AbortSignal.any([cancellation, scope.signal]) : (cancellation ?? scope?.signal);
    cancelled(signal);
    try {
      return await work(signal);
    } finally {
      cancelled(signal);
    }
  };
  const shared = <T>(load: (key: string) => Promise<T>) => {
    const values = new Map<string, Promise<T>>();
    return (key: string): Promise<T> =>
      read(async () => {
        if (!options.shouldShareReads) return load(key);
        let value = values.get(key);
        if (!value) {
          value = load(key);
          values.set(key, value);
        }
        return structuredClone(await value);
      });
  };
  const command = async <T>(
    stage: PreparationStage,
    timeoutMs: number,
    options: CommandOptions | undefined,
    work: (options: CommandOptions) => Promise<T>,
  ) => {
    const scope = current();
    if (!scope) return work(options ?? {});
    if (stage === 'inspect') timeoutMs = scope.commandTimeoutMs ?? timeoutMs;
    return read(async signal => {
      scope.report?.(stage);
      const remainingMs = scope.deadlineMs === undefined ? Infinity : scope.deadlineMs - performance.now();
      if (remainingMs <= 0) throw new Error(scope.timeoutCode ?? 'inspection-timeout');
      const result = await work({
        ...options,
        timeoutMs: Math.max(1, Math.ceil(Math.min(options?.timeoutMs ?? timeoutMs, timeoutMs, remainingMs))),
        ...(signal ? { signal } : {}),
      });
      if (scope.deadlineMs !== undefined && performance.now() >= scope.deadlineMs)
        throw new Error(scope.timeoutCode ?? 'inspection-timeout');
      return result;
    }, options?.signal);
  };
  return {
    npmIdentity: () => read(() => machine.npmIdentity()),
    userPathContains: (directory, options) =>
      command('inspect', READ_COMMAND_TIMEOUT_MS, options, bounded => machine.userPathContains(directory, bounded)),
    read: shared(file => machine.read(file)),
    entries: shared(directory => machine.entries(directory)),
    realpath: shared(file => machine.realpath(file)),
    locate: shared(name => machine.locate(name)),
    fingerprint: (file, signal) => read(active => machine.fingerprint(file, active), signal),
    treeStamp: (file, signal) => read(active => machine.treeStamp(file, active), signal),
    processes: options => command('inspect', READ_COMMAND_TIMEOUT_MS, options, bounded => machine.processes(bounded)),
    npm: async (args, options) => {
      if (!isNpmObservation(args)) throw new Error('read-command-not-allowed');
      return command(
        args[0] === 'exec' ? 'source' : args[0] === 'view' ? 'metadata' : 'inspect',
        args[0] === 'exec' ? SOURCE_TIMEOUT_MS : READ_COMMAND_TIMEOUT_MS,
        options,
        bounded => machine.npm(args, bounded),
      );
    },
    execute: async (file, args, options) => {
      if (!isObservationCommand(file, args)) throw new Error('read-command-not-allowed');
      return command(
        file === 'git' ? 'metadata' : 'inspect',
        file === 'git' ? GIT_COMMAND_TIMEOUT_MS : READ_COMMAND_TIMEOUT_MS,
        options,
        bounded => machine.execute(file, args, bounded),
      );
    },
    fetchText: (url, options) =>
      command('metadata', FETCH_TEXT_TIMEOUT_MS, options, bounded => machine.fetchText(url, bounded)),
    fetchBytes: (url, options) =>
      command('download', FETCH_BYTES_TIMEOUT_MS, options, bounded => machine.fetchBytes(url, bounded)),
    source: (repository, revision, folder, options) =>
      command('source', SOURCE_TIMEOUT_MS, options, bounded => machine.source(repository, revision, folder, bounded)),
  };
}

/** 只允许固定观察命令；其他外部命令须通过执行能力派发 */
function isObservationCommand(file: string, args: readonly string[]): boolean {
  const name = file
    .split(/[\\/]/)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.exe$/, '');
  const nodeEntry =
    name === 'node' &&
    args[0]?.endsWith('.js') &&
    args[0].replaceAll('\\', '/').toLowerCase().includes('/@anthropic-ai/claude-code/');
  const actual = nodeEntry ? args.slice(1) : args;
  const knownProgram = nodeEntry || ['claude', 'officecli', 'ccline', 'git'].some(program => program === name);
  if (knownProgram && actual.length === 1 && (actual[0] === '--version' || actual[0] === '--help')) return true;
  if (
    (name === 'claude' || nodeEntry) &&
    actual.length === 3 &&
    actual[0] === 'auth' &&
    actual[1] === 'status' &&
    actual[2] === '--json'
  )
    return true;
  if (name === 'git')
    return (
      args.length === 3 && args[0] === 'ls-remote' && /^https:\/\/[^\s]+$/.test(args[1] ?? '') && args[2] === 'HEAD'
    );
  return false;
}

function isNpmObservation(args: readonly string[]): boolean {
  if (args[0] === 'exec') {
    const [action, source, option, ...extra] = args.slice(SKILLS_CLI.length);
    return (
      SKILLS_CLI.every((part, index) => args[index] === part) &&
      action === 'a' &&
      source !== undefined &&
      source !== '' &&
      !source.startsWith('-') &&
      option === '--list' &&
      extra.length === 0
    );
  }
  if (args[0] === 'config')
    return (
      args.length === 3 &&
      args[1] === 'get' &&
      (args[2] === 'registry' || /^@[a-z0-9._-]+:registry$/i.test(args[2] ?? ''))
    );
  return (
    (args[0] === 'view' || args[0] === 'ls' || args[0] === 'root') &&
    !args.some(arg => arg === '--' || /^--(?:globalconfig|userconfig|script-shell|cache|logfile)(?:=|$)/.test(arg))
  );
}
