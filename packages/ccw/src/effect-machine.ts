import { AsyncLocalStorage } from 'node:async_hooks';
import type { Machine } from './machine.js';

/** 一次 apply 的异步执行资格；旧调用链不能借用后续 apply 的资格。 */
export function createEffectScope(machine: Machine, allowed: () => boolean) {
  const execution = new AsyncLocalStorage<symbol>();
  let active: symbol | undefined;
  return {
    machine: createEffectMachine(machine, () => allowed() && active !== undefined && execution.getStore() === active),
    run<T>(work: () => Promise<T>): Promise<T> {
      if (active !== undefined) return Promise.reject(new Error('operation-in-progress'));
      const token = Symbol('apply');
      active = token;
      return execution.run(token, async () => {
        try {
          return await work();
        } finally {
          active = undefined;
        }
      });
    },
  };
}

/** 每次派发检查执行资格；预先捕获方法不能带走之后的写入许可。 */
export function createEffectMachine(machine: Machine, allowed: () => boolean): Machine {
  const guarded =
    <A extends unknown[], R>(work: (...args: A) => R) =>
    (...args: A): R => {
      if (!allowed()) throw new Error('effect-not-authorized');
      return work(...args);
    };
  return {
    read: guarded(file => machine.read(file)),
    fingerprint: guarded((file, signal) => machine.fingerprint(file, signal)),
    initialize: guarded((file, text) => machine.initialize(file, text)),
    editJson: guarded((file, edit) => machine.editJson(file, edit)),
    remove: guarded((file, expected) => machine.remove(file, expected)),
    npm: guarded((args, options) => machine.npm(args, options)),
    entries: guarded(directory => machine.entries(directory)),
    treeStamp: guarded((file, signal) => machine.treeStamp(file, signal)),
    removeTree: guarded((file, expected, preserveAt) => machine.removeTree(file, expected, preserveAt)),
    removeEmptyDirectory: guarded(directory => machine.removeEmptyDirectory(directory)),
    replaceTree: guarded((directory, files, expected, preserveAt) =>
      machine.replaceTree(directory, files, expected, preserveAt),
    ),
    execute: guarded((file, args, options) => machine.execute(file, args, options)),
    locate: guarded(command => machine.locate(command)),
    realpath: guarded(file => machine.realpath(file)),
    fetchText: guarded((url, options) => machine.fetchText(url, options)),
    fetchBytes: guarded((url, options) => machine.fetchBytes(url, options)),
    replaceFile: guarded((file, data, expected, executable) => machine.replaceFile(file, data, expected, executable)),
    ensureUserPath: guarded(directory => machine.ensureUserPath(directory)),
    source: guarded((repository, revision, subdirectory, options) =>
      machine.source(repository, revision, subdirectory, options),
    ),
    processes: guarded(signal => machine.processes(signal)),
  };
}
