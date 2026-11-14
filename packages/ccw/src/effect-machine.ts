import { AsyncLocalStorage } from 'node:async_hooks';
import type { EffectMachine } from './machine.js';

/**
 * 隔离异步调用链的写入资格
 *
 * @returns 受保护的写入能力，以及授予当前调用链资格的 run 方法
 * @remarks 每次派发检查资格和取消，不中断或撤销已派发操作
 */
export function createEffectScope(machine: EffectMachine) {
  const execution = new AsyncLocalStorage<{ readonly signal?: AbortSignal }>();
  let active: ReturnType<typeof execution.getStore>;
  return {
    machine: createEffectMachine(machine, () => {
      if (active === undefined || execution.getStore() !== active) return false;
      if (active.signal?.aborted) throw new Error('cancelled');
      return true;
    }),
    /**
     * 授予 work 调用链写入资格，结束后撤销
     *
     * @param work - Promise 须覆盖全部写入
     * @param cancellation - 已取消时，后续能力派发同步抛出 cancelled
     * @throws 已有调用运行时拒绝为 operation-in-progress；work 异常原样传播
     * @remarks 取消只阻止后续派发，不跳过 work 或强制其失败
     */
    run<T>(work: () => Promise<T>, cancellation?: AbortSignal): Promise<T> {
      if (active !== undefined) return Promise.reject(new Error('operation-in-progress'));
      active = cancellation ? { signal: cancellation } : {};
      return execution.run(active, async () => {
        try {
          return await work();
        } finally {
          active = undefined;
        }
      });
    },
  };
}

/**
 * 每次调用写入能力前检查资格
 *
 * @param allowed - 同步资格检查，可抛出取消等错误，结果不缓存
 * @throws 无资格时同步抛出 effect-not-authorized；检查异常原样传播
 * @remarks 不复核完成时的资格，也不中断已派发操作
 */
export function createEffectMachine(machine: EffectMachine, allowed: () => boolean): EffectMachine {
  const guarded =
    <A extends unknown[], R>(work: (...args: A) => R) =>
    (...args: A): R => {
      if (!allowed()) throw new Error('effect-not-authorized');
      return work(...args);
    };
  return {
    initialize: guarded((file, text) => machine.initialize(file, text)),
    editJson: guarded((file, edit) => machine.editJson(file, edit)),
    npm: guarded((args, options) => machine.npm(args, options)),
    removeTree: guarded((file, expected, preserveAt) => machine.removeTree(file, expected, preserveAt)),
    replaceTree: guarded((directory, files, expected, preserveAt) =>
      machine.replaceTree(directory, files, expected, preserveAt),
    ),
    execute: guarded((file, args, options) => machine.execute(file, args, options)),
    replaceFile: guarded((file, data, expected, executable) => machine.replaceFile(file, data, expected, executable)),
    ensureUserPath: guarded(directory => machine.ensureUserPath(directory)),
  };
}
