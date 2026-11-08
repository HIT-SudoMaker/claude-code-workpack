import {
  FETCH_BYTES_TIMEOUT_MS,
  FETCH_TEXT_TIMEOUT_MS,
  GIT_COMMAND_TIMEOUT_MS,
  READ_COMMAND_TIMEOUT_MS,
  SOURCE_TIMEOUT_MS,
} from './machine.js';
import type { CommandOptions, Machine } from './machine.js';
import { cancelled } from './model.js';
import type { PreparationStage } from './model.js';

interface ReadScope {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly report?: (stage: PreparationStage) => void;
}

/** 统一只读阶段的时限、取消和进度；共享读取仅限单次检查，准备与执行不用缓存 */
export function createReadMachine(
  machine: Machine,
  current: () => ReadScope | undefined,
  options: { shouldShareReads?: boolean } = {},
): Machine {
  const shared = <T>(load: (key: string) => Promise<T>) => {
    const values = new Map<string, Promise<T>>();
    return async (key: string): Promise<T> => {
      if (!options.shouldShareReads) return load(key);
      let value = values.get(key);
      if (!value) {
        value = load(key);
        values.set(key, value);
      }
      return structuredClone(await value);
    };
  };
  const read = async <T>(work: (signal?: AbortSignal) => Promise<T>) => {
    const scope = current();
    cancelled(scope?.signal);
    try {
      const result = await work(scope?.signal);
      cancelled(scope?.signal);
      return result;
    } catch (error) {
      cancelled(scope?.signal);
      throw error;
    }
  };
  const command = async <T>(
    stage: PreparationStage,
    timeoutMs: number,
    options: CommandOptions | undefined,
    work: (options: CommandOptions) => Promise<T>,
  ) => {
    const scope = current();
    if (!scope) return work(options ?? {});
    cancelled(scope.signal);
    scope.report?.(stage);
    const remainingMs = scope.deadlineMs === undefined ? Infinity : scope.deadlineMs - performance.now();
    if (remainingMs <= 0) throw new Error('inspection-timeout');
    const signal =
      options?.signal && scope.signal
        ? AbortSignal.any([options.signal, scope.signal])
        : (options?.signal ?? scope.signal);
    try {
      const result = await work({
        ...options,
        timeoutMs: Math.max(1, Math.ceil(Math.min(options?.timeoutMs ?? timeoutMs, timeoutMs, remainingMs))),
        ...(signal ? { signal } : {}),
      });
      cancelled(signal);
      if (scope.deadlineMs !== undefined && performance.now() >= scope.deadlineMs)
        throw new Error('inspection-timeout');
      return result;
    } catch (error) {
      cancelled(signal);
      throw error;
    }
  };
  // 整体复用原 machine 的方法，只覆写需统一时限、取消或共享的读取面；新增 Machine 方法无需在此补转发
  return {
    ...machine,
    read: shared(file => read(() => machine.read(file))),
    entries: shared(directory => read(() => machine.entries(directory))),
    realpath: shared(file => read(() => machine.realpath(file))),
    locate: shared(name => read(() => machine.locate(name))),
    fingerprint: (file, signal) => read(active => machine.fingerprint(file, active ?? signal)),
    treeStamp: (file, signal) => read(active => machine.treeStamp(file, active ?? signal)),
    processes: signal => read(active => machine.processes(active ?? signal)),
    npm: (args, options) =>
      command(args[0] === 'view' ? 'metadata' : 'inspect', READ_COMMAND_TIMEOUT_MS, options, bounded =>
        machine.npm(args, bounded),
      ),
    execute: (file, args, options) =>
      command(
        file === 'git' ? 'metadata' : 'inspect',
        file === 'git' ? GIT_COMMAND_TIMEOUT_MS : READ_COMMAND_TIMEOUT_MS,
        options,
        bounded => machine.execute(file, args, bounded),
      ),
    fetchText: (url, options) =>
      command('metadata', FETCH_TEXT_TIMEOUT_MS, options, bounded => machine.fetchText(url, bounded)),
    fetchBytes: (url, options) =>
      command('download', FETCH_BYTES_TIMEOUT_MS, options, bounded => machine.fetchBytes(url, bounded)),
    source: (repository, revision, folder, options) =>
      command('source', SOURCE_TIMEOUT_MS, options, bounded => machine.source(repository, revision, folder, bounded)),
  };
}
