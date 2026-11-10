import {
  FETCH_BYTES_TIMEOUT_MS,
  FETCH_TEXT_TIMEOUT_MS,
  GIT_COMMAND_TIMEOUT_MS,
  READ_COMMAND_TIMEOUT_MS,
  SOURCE_TIMEOUT_MS,
} from './machine.js';
import type { CommandOptions, ReadMachine } from './machine.js';
import { cancelled } from './model.js';
import type { PreparationStage } from './model.js';

interface ReadScope {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly report?: (stage: PreparationStage) => void;
}

/** 观察命令的有限集合。任意外部命令只能通过执行能力派发。 */
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
  const knownProgram = nodeEntry || ['claude', 'officecli', 'ccline', 'uv', 'git'].some(program => program === name);
  if (knownProgram && actual.length === 1 && (actual[0] === '--version' || actual[0] === '--help')) return true;
  if (
    (name === 'claude' || nodeEntry) &&
    actual.length === 3 &&
    actual[0] === 'plugin' &&
    actual[1] === 'uninstall' &&
    actual[2] === '--help'
  )
    return true;
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
  if (name === 'scoop')
    return args.length === 2 && (args[0] === 'prefix' || args[0] === 'list') && args[1] === 'officecli';
  if (name === 'brew')
    return (
      (args.length === 1 && (args[0] === '--cellar' || args[0] === '--caskroom')) ||
      (args[0] === 'list' &&
        (args[1] === '--cask' || args[1] === '--formula') &&
        args[2] === '--versions' &&
        args.length <= 4)
    );
  if (name === 'winget')
    return (
      args[0] === 'list' &&
      args.slice(1).every(arg => ['--id', 'Anthropic.ClaudeCode', '--exact', '--disable-interactivity'].includes(arg))
    );
  if (name === 'dpkg-query')
    return (
      (args[0] === '-S' && args.length === 2) ||
      (args.length === 2 && args[0] === '-W' && args[1] === '-f=${Package} ${db:Status-Status}\n')
    );
  if (name === 'rpm')
    return (
      (args[0] === '-qf' && args[1] === '--qf' && args[2] === '%{NAME}\n' && args.length === 4) ||
      (args.length === 3 && args[0] === '-qa' && args[1] === '--qf' && args[2] === '%{NAME}\n')
    );
  if (name === 'apk')
    return args[0] === 'info' && (args.length === 1 || (args.length === 3 && args[1] === '--who-owns'));
  if (name === 'uv' && actual.length === 3 && actual[0] === 'tool' && actual[1] === 'dir' && actual[2] === '--bin')
    return true;
  return name === 'uv' && actual.length === 2 && actual[0] === 'tool' && actual[1] === 'list';
}

function isNpmObservation(args: readonly string[]): boolean {
  return (
    (args[0] === 'view' || args[0] === 'ls' || args[0] === 'root') &&
    !args.some(arg => arg === '--' || /^--(?:globalconfig|userconfig|script-shell|cache|logfile)(?:=|$)/.test(arg))
  );
}

/** 统一只读阶段的能力、时限、取消和进度；共享读取仅限单次检查。 */
export function createReadMachine(
  machine: ReadMachine,
  current: () => ReadScope | undefined,
  options: { shouldShareReads?: boolean } = {},
): ReadMachine {
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
      return await work(scope?.signal);
    } finally {
      cancelled(scope?.signal);
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
      if (scope.deadlineMs !== undefined && performance.now() >= scope.deadlineMs)
        throw new Error('inspection-timeout');
      return result;
    } finally {
      cancelled(signal);
    }
  };
  return {
    read: shared(file => read(() => machine.read(file))),
    entries: shared(directory => read(() => machine.entries(directory))),
    realpath: shared(file => read(() => machine.realpath(file))),
    locate: shared(name => read(() => machine.locate(name))),
    fingerprint: (file, signal) => read(active => machine.fingerprint(file, active ?? signal)),
    treeStamp: (file, signal) => read(active => machine.treeStamp(file, active ?? signal)),
    processes: signal => read(active => machine.processes(active ?? signal)),
    npm: async (args, options) => {
      if (!isNpmObservation(args)) throw new Error('read-command-not-allowed');
      return command(args[0] === 'view' ? 'metadata' : 'inspect', READ_COMMAND_TIMEOUT_MS, options, bounded =>
        machine.npm(args, bounded),
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
