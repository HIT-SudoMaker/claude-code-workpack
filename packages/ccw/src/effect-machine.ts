import { AsyncLocalStorage } from 'node:async_hooks';
import type { EffectMachine } from './machine.js';

/**
 * 创建写入作用域
 *
 * @returns 受保护的写入能力和授予当前异步调用链资格的 run 方法
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
     * 授予当前调用链写入资格
     *
     * @param work - 返回的 Promise 须覆盖全部写入，结算时撤销资格
     * @param cancellation - 取消后调用写入能力时同步抛出 cancelled
     * @throws 已有作用域运行时以 operation-in-progress 拒绝 Promise，work 异常原样传播
     * @remarks 取消阻止后续派发，已派发的操作和 work 自身继续结算
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
 * 包装受资格检查的写入能力
 *
 * @param allowed - 每次派发前执行的同步资格检查
 * @returns 写入方法在无资格时同步抛出 effect-not-authorized，检查异常原样传播
 * @remarks 已派发的操作继续执行，完成时不重新检查资格
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
    removeFile: guarded((file, expectedFingerprint) => machine.removeFile(file, expectedFingerprint)),
    removeEmptyDirectory: guarded(directory => machine.removeEmptyDirectory(directory)),
    removeTree: guarded((file, expected, preserveAt) => machine.removeTree(file, expected, preserveAt)),
    replaceTree: guarded((directory, files, expected, preserveAt) =>
      machine.replaceTree(directory, files, expected, preserveAt),
    ),
    execute: guarded((file, args, options) => machine.execute(file, args, options)),
    replaceFile: guarded((file, data, expected, executable) => machine.replaceFile(file, data, expected, executable)),
    ensureUserPath: guarded(directory => machine.ensureUserPath(directory)),
  };
}
