import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly failed: boolean;
  readonly reason?: 'npm-not-found';
}
interface FileEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'link';
  readonly sizeBytes: bigint;
}
interface ProcessEntry {
  readonly name: string;
  readonly command: string;
}
export interface TreeFile {
  readonly path: string;
  readonly data: Uint8Array;
}
export interface CommandOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly isInteractive?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
type ReadOptions = Pick<CommandOptions, 'timeoutMs' | 'signal'>;
export interface Machine {
  npmIdentity(): Promise<{ readonly entry: string; readonly binary: string; readonly stamp: string }>;
  userPathContains(directory: string): Promise<boolean>;
  read(file: string): Promise<string | null>;
  fingerprint(file: string, signal?: AbortSignal): Promise<string | null>;
  initialize(file: string, text: string): Promise<boolean>;
  editJson(file: string, edit: (value: Record<string, unknown>) => void): Promise<void>;
  remove(file: string, expected: string): Promise<void>;
  /** 使用本实例固定的 npm；入口被替换时抛出 npm-changed，须重启后重新准备 */
  npm(args: readonly string[], options?: ReadOptions): Promise<CommandResult>;
  entries(directory: string): Promise<readonly FileEntry[]>;
  treeStamp(file: string, signal?: AbortSignal): Promise<string | null>;
  removeTree(file: string, expected: string, preserveAt?: string): Promise<void>;
  removeEmptyDirectory(directory: string): Promise<boolean>;
  replaceTree(
    directory: string,
    files: readonly TreeFile[],
    expected: string | null,
    preserveAt?: string,
  ): Promise<void>;
  execute(executable: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
  locate(command: string): Promise<readonly string[]>;
  realpath(file: string): Promise<string | null>;
  fetchText(url: string, options?: ReadOptions): Promise<string>;
  fetchBytes(url: string, options?: ReadOptions): Promise<Uint8Array>;
  replaceFile(file: string, data: Uint8Array, expected: string | null, shouldMarkExecutable?: boolean): Promise<void>;
  ensureUserPath(directory: string): Promise<void>;
  source(
    repository: string,
    revision: string,
    subdirectory: string,
    options?: ReadOptions,
  ): Promise<readonly TreeFile[]>;
  /** 枚举进程为纯观测，不携带产品判定；命令行不可读时 command 为空串；枚举失败返回 null */
  processes(signal?: AbortSignal): Promise<readonly ProcessEntry[] | null>;
}

/** 观察与来源暂存能力；不含任何受管目标写入方法。命令仍需经过可信查询门。 */
export type ReadMachine = Pick<
  Machine,
  | 'npmIdentity'
  | 'userPathContains'
  | 'read'
  | 'fingerprint'
  | 'npm'
  | 'entries'
  | 'treeStamp'
  | 'execute'
  | 'locate'
  | 'realpath'
  | 'fetchText'
  | 'fetchBytes'
  | 'source'
  | 'processes'
>;

/** 限制读阶段命令与远端读取的毫秒时限；read-machine 的检查预算与各域短探测同源取值 */
export const READ_COMMAND_TIMEOUT_MS = 5_000;
export const GIT_COMMAND_TIMEOUT_MS = 15_000;
export const FETCH_TEXT_TIMEOUT_MS = 30_000;
export const FETCH_BYTES_TIMEOUT_MS = 120_000;
export const SOURCE_TIMEOUT_MS = 120_000;

/** git 提交号形状：40 位十六进制小写 */
export const isGitRevision = (value: string): boolean => /^[a-f0-9]{40}$/.test(value);

/** 限制整读内容的内存占用 */
const FILE_LIMIT_BYTES = 2 * 1024 * 1024;
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const TEXT_LIMIT_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_LIMIT_BYTES = 256 * 1024 * 1024;
const SOURCE_LIMIT_BYTES = 256 * 1024 * 1024;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorCode(error: unknown): string {
  if (isObject(error) && typeof error.code === 'string') return error.code;
  if (error instanceof Error && /^[a-z][a-z-]+$/.test(error.message)) return error.message;
  return 'operation-failed';
}

export function succeeded(result: CommandResult) {
  return !(result.failed || result.code !== 0);
}

interface RemoteRead {
  readonly signal: AbortSignal;
  readonly check: () => void;
}

/** 统一远端读取的总期限、取消与迟到结果 */
async function remoteRead<T>(
  options: ReadOptions,
  timeoutMs: number,
  read: (reading: RemoteRead) => Promise<T>,
): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort();
  }, options.timeoutMs ?? timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  const check = () => {
    if (options.signal?.aborted) throw new Error('cancelled');
    if (timeout.signal.aborted) throw new Error('source-timeout');
  };
  try {
    check();
    const result = await read({ signal, check });
    check();
    return result;
  } catch (error) {
    check();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function download(
  url: string,
  maximumBytes: number,
  reading: RemoteRead,
  needsBody = false,
): Promise<Uint8Array> {
  if (new URL(url).protocol !== 'https:') throw new Error('invalid-source-url');
  reading.check();
  const response = await fetch(url, { signal: reading.signal });
  try {
    reading.check();
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  const problem =
    new URL(response.url || url).protocol !== 'https:'
      ? 'invalid-source-url'
      : !response.ok || (needsBody && !response.body)
        ? 'source-unavailable'
        : Number(response.headers.get('content-length')) > maximumBytes
          ? 'source-too-large'
          : undefined;
  if (problem) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(problem);
  }
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  if (response.body)
    for await (const chunk of response.body) {
      reading.check();
      sizeBytes += chunk.byteLength;
      if (sizeBytes > maximumBytes) throw new Error('source-too-large');
      chunks.push(chunk);
    }
  reading.check();
  return Buffer.concat(chunks, sizeBytes);
}

/** 计算 replaceTree 写入后的目录摘要 */
export function treeFilesStamp(files: readonly TreeFile[]) {
  type Node = Map<string, Node | Uint8Array>;
  const root: Node = new Map();
  for (const file of files) {
    if (!file.path || file.path.includes('\\') || path.isAbsolute(file.path)) throw new Error('invalid-source-path');
    const parts = file.path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part === '.git' || part.includes('\0')))
      throw new Error('invalid-source-path');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const existing = node.get(part);
      if (existing instanceof Uint8Array) throw new Error('invalid-source-path');
      if (existing === undefined) {
        const child: Node = new Map();
        node.set(part, child);
        node = child;
      } else node = existing;
    }
    const name = parts.at(-1);
    if (name === undefined || node.has(name)) throw new Error('invalid-source-path');
    node.set(name, file.data);
  }
  const stamp = (node: Node): string => {
    const hash = createHash('sha256');
    for (const [name, value] of [...node.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      const child = value instanceof Uint8Array ? createHash('sha256').update(value).digest('hex') : stamp(value);
      hash.update(`${name}\0${child}\0`);
    }
    return hash.digest('hex');
  };
  return stamp(root);
}

async function fileStat(file: string) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not-regular-file');
    return stat;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

async function read(file: string): Promise<string | null> {
  const stat = await fileStat(file);
  if (stat === null) return null;
  if (stat.size > FILE_LIMIT_BYTES) throw new Error('file-too-large');
  return fs.readFile(file, 'utf8');
}

async function fingerprint(file: string, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  const stat = await fileStat(file);
  if (stat === null) return null;
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash, { signal });
  return hash.digest('hex');
}

async function prepareParent(file: string) {
  // 拒绝通过已有链接目录写到其他根；不追随链接部署或删除资产
  let directory = path.dirname(file);
  while (directory !== path.dirname(directory)) {
    try {
      if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('linked-parent');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    directory = path.dirname(directory);
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
}

async function editJson(file: string, edit: (value: Record<string, unknown>) => void) {
  await prepareParent(file);
  const lockPath = `${file}.ccw-lock`;
  const lock = await fs.open(lockPath, 'wx', 0o600);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const before = await read(file);
    const value: unknown = before === null ? {} : JSON.parse(before);
    if (!isObject(value)) throw new Error('invalid-settings');
    edit(value);
    const stat = await fileStat(file);
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: stat?.mode ?? 0o600 });
    if ((await read(file)) !== before) throw new Error('settings-changed');
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
    await lock.close();
    await fs.unlink(lockPath);
  }
}

function normalizeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return { ...environment };
  const normalized: NodeJS.ProcessEnv = {};
  // 与 Node 的重复键优先级一致；调用选项在归一后覆盖已有环境
  for (const key of Object.keys(environment).sort()) {
    const name = key.toUpperCase();
    if (!Object.hasOwn(normalized, name)) normalized[name] = environment[key];
  }
  return normalized;
}

async function npmPath(environment: NodeJS.ProcessEnv) {
  const candidates = [
    environment[process.platform === 'win32' ? 'NPM_EXECPATH' : 'npm_execpath'],
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  ];
  for (const directory of (environment.PATH ?? '').split(path.delimiter)) {
    candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'));
    if (process.platform !== 'win32') {
      try {
        candidates.push(await fs.realpath(path.join(directory, 'npm')));
      } catch {
        // 不可解析的 PATH 位置跳过，继续收集
      }
    }
  }
  for (const candidate of candidates) {
    if (candidate?.endsWith('npm-cli.js') && (await fileStat(candidate)) !== null) return candidate;
  }
  throw new Error('npm-not-found');
}

/** 执行结构化命令，不经过 shell；输出有上限，超时不报告成功 */
async function run(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  options: CommandOptions = {},
): Promise<CommandResult> {
  if (options.signal?.aborted) return { code: null, stdout: '', failed: true };
  if (process.platform === 'win32') {
    if (path.extname(executable).toLowerCase() === '.ps1' || executable === 'scoop') {
      const candidates =
        executable === 'scoop'
          ? (environment.PATH ?? '')
              .split(path.delimiter)
              .filter(Boolean)
              .map(directory => path.join(directory, 'scoop.ps1'))
          : [executable];
      for (const candidate of candidates)
        if ((await fileStat(candidate)) !== null)
          return run(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', candidate, ...args],
            environment,
            cwd,
            options,
          );
    }
  }
  return new Promise(resolve => {
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      windowsHide: true,
      detached: process.platform !== 'win32' && !options.isInteractive,
      stdio: options.isInteractive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let sizeBytes = 0;
    let hasFailed = false;
    let isStopping = false;
    const decoder = new StringDecoder('utf8');
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      hasFailed = true;
      if (isStopping || child.pid === undefined) return;
      isStopping = true;
      // Git 的 HTTP helper 继承输出管道；只杀父进程无法结束等待
      if (process.platform === 'win32') {
        const killer = spawn(
          path.join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32/taskkill.exe'),
          ['/PID', `${child.pid}`, '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        );
        killer.once('error', () => {
          child.kill();
        });
        killer.once('close', code => {
          if (code !== 0) child.kill();
        });
      } else if (!options.isInteractive) {
        const pid = child.pid;
        try {
          process.kill(-pid, 'SIGTERM');
          forceStop = setTimeout(() => {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          }, 250);
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        // 交互命令共享终端进程组，只终止所选子进程
        child.kill();
        forceStop = setTimeout(() => {
          child.kill('SIGKILL');
        }, 250);
      }
    };
    const timer = setTimeout(stop, options.timeoutMs ?? (options.isInteractive ? 900_000 : 300_000));
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    child.stdout?.on('data', (chunk: Buffer) => {
      sizeBytes += chunk.length;
      if (sizeBytes > OUTPUT_LIMIT_BYTES) stop();
      else stdout += decoder.write(chunk);
    });
    child.stderr?.on('data', () => {
      /* 不向结果或日志暴露外部配置及凭据 */
    });
    child.once('error', () => {
      hasFailed = true;
    });
    child.once('close', code => {
      if (sizeBytes <= OUTPUT_LIMIT_BYTES) stdout += decoder.end();
      clearTimeout(timer);
      clearTimeout(forceStop);
      options.signal?.removeEventListener('abort', stop);
      resolve({ code, stdout, failed: hasFailed });
    });
  });
}

async function entries(directory: string): Promise<readonly FileEntry[]> {
  try {
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('linked-parent');
    return await Promise.all(
      (await fs.readdir(directory)).sort().map(async name => {
        const stat = await fs.lstat(path.join(directory, name), { bigint: true });
        if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) throw new Error('special-file');
        return {
          name,
          kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'file',
          sizeBytes: stat.size,
        };
      }),
    );
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

async function treeStamp(file: string, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  try {
    const stat = await fs.lstat(file);
    const hash = createHash('sha256');
    if (stat.isSymbolicLink()) return hash.update(`link:${await fs.readlink(file)}`).digest('hex');
    if (stat.isFile()) return fingerprint(file, signal);
    if (!stat.isDirectory()) throw new Error('special-file');
    for (const entry of await entries(file))
      hash.update(`${entry.name}\0${await treeStamp(path.join(file, entry.name), signal)}\0`);
    return hash.digest('hex');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

async function removeTree(file: string, expected: string, preserveAt?: string) {
  if (path.resolve(file) === path.parse(path.resolve(file)).root) throw new Error('invalid-target');
  await prepareParent(file);
  if ((await treeStamp(file)) !== expected) throw new Error('target-changed');
  if (preserveAt !== undefined) {
    await prepareParent(preserveAt);
    if ((await treeStamp(preserveAt)) !== null) throw new Error('backup-exists');
    await fs.rename(file, preserveAt);
  } else if ((await fs.lstat(file)).isSymbolicLink()) await fs.unlink(file);
  else await fs.rm(file, { recursive: true });
  if ((await treeStamp(file)) !== null) throw new Error('target-remains');
}

function relativeFile(root: string, relative: string) {
  const result = path.resolve(root, relative);
  if (
    !result.startsWith(`${path.resolve(root)}${path.sep}`) ||
    relative.includes('\\') ||
    relative.split('/').some(part => part === '.' || part === '..' || part === '.git') ||
    path.isAbsolute(relative)
  )
    throw new Error('invalid-source-path');
  return result;
}

/** POSIX 还需提交目录项；Windows 不支持用普通目录句柄执行 fsync。 */
async function syncParentDirectory(file: string) {
  if (os.type() === 'Windows_NT') return;
  const directory = await fs.open(path.dirname(file), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function replaceFile(file: string, data: Uint8Array, expected: string | null, shouldMarkExecutable = false) {
  await prepareParent(file);
  const stat = await fileStat(file);
  if ((await fingerprint(file)) !== expected) throw new Error('target-changed');
  const staged = `${file}.${randomUUID()}.tmp`;
  try {
    const output = await fs.open(staged, 'wx', shouldMarkExecutable ? 0o755 : (stat?.mode ?? 0o600));
    try {
      await output.writeFile(data);
      await output.sync();
    } finally {
      await output.close();
    }
    if ((await fingerprint(file)) !== expected) throw new Error('target-changed');
    await fs.rename(staged, file);
    await syncParentDirectory(file);
    if ((await fingerprint(file)) !== createHash('sha256').update(data).digest('hex'))
      throw new Error('target-changed');
  } finally {
    await fs.rm(staged, { force: true });
  }
}

function userPathProfile(environment: NodeJS.ProcessEnv, directory: string) {
  if (
    !path.isAbsolute(directory) ||
    path.parse(directory).root === path.resolve(directory) ||
    /[\r\n\0]/.test(directory)
  )
    throw new Error('invalid-target');
  const home =
    process.platform === 'win32'
      ? (environment.USERPROFILE ?? environment.HOME)
      : (environment.HOME ?? environment.USERPROFILE);
  if (!home || !path.isAbsolute(home)) throw new Error('user-home-unconfirmed');
  const shell = path.basename(environment.SHELL ?? '');
  const shellRoot =
    shell === 'zsh'
      ? (environment.ZDOTDIR ?? home)
      : shell === 'fish'
        ? environment.XDG_CONFIG_HOME || path.join(home, '.config')
        : home;
  if (!path.isAbsolute(shellRoot)) throw new Error('user-home-unconfirmed');
  const profile = path.join(
    shellRoot,
    shell === 'fish' ? 'fish/config.fish' : shell === 'zsh' ? '.zshrc' : shell === 'bash' ? '.bashrc' : '.profile',
  );
  const quoted = "'" + directory.replaceAll("'", "'\\''") + "'";
  const line = shell === 'fish' ? 'fish_add_path -- ' + quoted : 'export PATH=' + quoted + ':"$PATH"';
  return { profile, line };
}

export function createMachine(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  handoff?: (work: () => Promise<CommandResult>) => Promise<CommandResult>,
): Machine {
  environment = normalizeEnvironment(environment);
  const inheritedPath = environment.PATH ?? '';
  let npmTool: Promise<{ entry: string; binary: string; stamp: string }> | undefined;
  const resolveNpm = () => {
    npmTool ??= (async () => {
      const entry = path.resolve(await npmPath(environment));
      const binary = await fs.realpath(entry);
      const stamp = await fingerprint(binary);
      if (stamp === null) throw new Error('npm-not-found');
      return { entry, binary, stamp };
    })().catch(error => {
      npmTool = undefined;
      throw error;
    });
    return npmTool;
  };
  return {
    read,
    fingerprint,
    editJson,
    entries,
    treeStamp,
    removeTree,
    replaceFile,
    async removeEmptyDirectory(directory) {
      if (path.resolve(directory) === path.parse(path.resolve(directory)).root) throw new Error('invalid-target');
      try {
        const stat = await fs.lstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('cleanup-type-changed');
        await prepareParent(directory);
        await fs.rmdir(directory);
        return true;
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return true;
        if (errorCode(error) === 'ENOTEMPTY' || errorCode(error) === 'EEXIST') return false;
        throw error;
      }
    },
    async realpath(file) {
      try {
        return await fs.realpath(file);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      }
    },
    async locate(command) {
      if (!/^[\w.-]+$/.test(command)) throw new Error('invalid-command');
      const found: string[] = [];
      for (const directory of (environment.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        for (const extension of process.platform === 'win32' ? ['.exe', '.cmd', '.ps1', ''] : ['']) {
          const file = path.resolve(directory, `${command}${extension}`);
          try {
            if ((await fs.stat(file)).isFile() && !found.includes(file)) found.push(file);
          } catch (error) {
            if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error;
          }
        }
      }
      return found;
    },
    execute(executable, args, options = {}) {
      const work = () =>
        run(
          executable,
          args,
          { ...environment, ...normalizeEnvironment(options.env ?? {}) },
          options.cwd ?? cwd,
          options,
        );
      return options.isInteractive && handoff ? handoff(work) : work();
    },
    async processes(signal) {
      const options = { timeoutMs: READ_COMMAND_TIMEOUT_MS, ...(signal ? { signal } : {}) };
      const result =
        process.platform === 'win32'
          ? await this.execute(
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object Name,CommandLine) | ConvertTo-Json -Compress",
              ],
              options,
            )
          : await this.execute('ps', ['-A', '-o', 'comm=', '-o', 'args='], options);
      if (!succeeded(result)) return null;
      if (process.platform !== 'win32')
        return result.stdout.split('\n').flatMap(line => {
          const match = /^(\S+)\s+(.*)$/.exec(line.trim());
          return match === null ? [] : [{ name: match[1] ?? '', command: match[2] ?? '' }];
        });
      try {
        const value: unknown = result.stdout.trim() ? JSON.parse(result.stdout) : [];
        const list: unknown[] = Array.isArray(value) ? value : [value];
        const found: ProcessEntry[] = [];
        for (const entry of list) {
          if (!isObject(entry) || typeof entry.Name !== 'string') return null;
          // 命令行不可读（如提权进程）按空串保留条目：名称可判定的进程不得因命令行缺失而漏报
          found.push({ name: entry.Name, command: typeof entry.CommandLine === 'string' ? entry.CommandLine : '' });
        }
        return found;
      } catch {
        return null;
      }
    },
    async fetchText(url, options = {}) {
      return remoteRead(options, FETCH_TEXT_TIMEOUT_MS, async reading =>
        new TextDecoder().decode(await download(url, TEXT_LIMIT_BYTES, reading)),
      );
    },
    async fetchBytes(url, options = {}) {
      return remoteRead(options, FETCH_BYTES_TIMEOUT_MS, reading => download(url, DOWNLOAD_LIMIT_BYTES, reading, true));
    },
    async userPathContains(directory) {
      if (
        !path.isAbsolute(directory) ||
        path.parse(directory).root === path.resolve(directory) ||
        /[\r\n\0]/.test(directory)
      )
        throw new Error('invalid-target');
      const same = (value: string) =>
        process.platform === 'win32'
          ? path.resolve(value).toLowerCase() === path.resolve(directory).toLowerCase()
          : value === directory;
      if (inheritedPath.split(path.delimiter).filter(Boolean).some(same)) return true;
      const target = userPathProfile(environment, directory);
      if (process.platform !== 'win32')
        return (await read(target.profile))?.split(/\r?\n/).includes(target.line) ?? false;
      const script =
        "$ErrorActionPreference='Stop'; $entry=$env:CCW_PATH_ENTRY; $parts=@(([Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')) -split ';' | Where-Object { $_ }); if ($parts | Where-Object { $_.TrimEnd('\\') -ieq $entry.TrimEnd('\\') }) { 'true' } else { 'false' }";
      const result = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { ...environment, CCW_PATH_ENTRY: directory },
        cwd,
        { timeoutMs: READ_COMMAND_TIMEOUT_MS },
      );
      if (!succeeded(result) || !['true', 'false'].includes(result.stdout.trim()))
        throw new Error('user-path-unconfirmed');
      return result.stdout.trim() === 'true';
    },
    async ensureUserPath(directory) {
      if (
        !path.isAbsolute(directory) ||
        path.parse(directory).root === path.resolve(directory) ||
        /[\r\n\0]/.test(directory)
      )
        throw new Error('invalid-target');
      const separator = path.delimiter;
      const current = environment.PATH ?? '';
      const same = (value: string) =>
        process.platform === 'win32'
          ? path.resolve(value).toLowerCase() === path.resolve(directory).toLowerCase()
          : value === directory;
      if (current.split(separator).filter(Boolean).some(same)) return;
      const home =
        process.platform === 'win32'
          ? (environment.USERPROFILE ?? environment.HOME)
          : (environment.HOME ?? environment.USERPROFILE);
      if (!home || !path.isAbsolute(home)) throw new Error('user-home-unconfirmed');
      if (process.platform === 'win32') {
        const script =
          "$ErrorActionPreference='Stop'; $entry=$env:CCW_PATH_ENTRY; $current=[Environment]::GetEnvironmentVariable('Path','User'); $parts=@($current -split ';' | Where-Object { $_ }); if (-not ($parts | Where-Object { $_.TrimEnd('\\') -ieq $entry.TrimEnd('\\') })) { [Environment]::SetEnvironmentVariable('Path', (($parts + $entry) -join ';'), 'User') }";
        const result = await run(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { ...environment, CCW_PATH_ENTRY: directory },
          cwd,
        );
        if (!succeeded(result)) throw new Error('user-path-save-failed');
      } else {
        const { profile, line } = userPathProfile(environment, directory);
        const before = await read(profile);
        if (!before?.split(/\r?\n/).includes(line)) {
          const expected = before === null ? null : createHash('sha256').update(before).digest('hex');
          await replaceFile(
            profile,
            Buffer.from(`${before ?? ''}${before?.endsWith('\n') || !before ? '' : '\n'}${line}\n`),
            expected,
          );
        }
      }
      const updated = `${directory}${current ? separator + current : ''}`;
      environment.PATH = updated;
    },
    async replaceTree(directory, files, expected, preserveAt) {
      await prepareParent(directory);
      const staged = `${directory}.${randomUUID()}.tmp`;
      await fs.mkdir(staged, { mode: 0o700 });
      try {
        for (const file of files) {
          const target = relativeFile(staged, file.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, file.data, { flag: 'wx', mode: 0o600 });
        }
        if ((await treeStamp(directory)) !== expected) throw new Error('target-changed');
        if (expected !== null) await removeTree(directory, expected, preserveAt);
        await fs.rename(staged, directory);
      } finally {
        await fs.rm(staged, { recursive: true, force: true });
      }
    },
    async source(repository, revision, subdirectory, options = {}) {
      return remoteRead(options, SOURCE_TIMEOUT_MS, async reading => {
        if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(repository) || !isGitRevision(revision))
          throw new Error('invalid-source');
        const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ccw-source-'));
        const git = async (args: readonly string[]) => {
          reading.check();
          const result = await this.execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
            env: { GIT_TERMINAL_PROMPT: '0' },
            cwd: temporary,
            signal: reading.signal,
            timeoutMs: options.timeoutMs ?? SOURCE_TIMEOUT_MS,
          });
          reading.check();
          if (!succeeded(result)) throw new Error('source-unavailable');
          return result.stdout;
        };
        try {
          const root = subdirectory === '.' ? temporary : relativeFile(temporary, subdirectory);
          await git(['init', '--quiet']);
          if (subdirectory !== '.') await git(['sparse-checkout', 'set', '--cone', subdirectory]);
          await git([
            '-c',
            'protocol.version=2',
            'fetch',
            '--quiet',
            '--filter=blob:none',
            '--depth=1',
            repository,
            revision,
          ]);
          await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
          const files: TreeFile[] = [];
          let sizeBytes = 0;
          const collect = async (directory: string): Promise<void> => {
            reading.check();
            for (const entry of await entries(directory)) {
              reading.check();
              if (directory === temporary && entry.name === '.git') continue;
              const file = path.join(directory, entry.name);
              if (entry.kind === 'link') throw new Error('source-link-unsupported');
              if (entry.kind === 'directory') await collect(file);
              else {
                sizeBytes += Number(entry.sizeBytes);
                if (sizeBytes > SOURCE_LIMIT_BYTES) throw new Error('source-too-large');
                files.push({
                  path: path.relative(root, file).split(path.sep).join('/'),
                  data: await fs.readFile(file, { signal: reading.signal }),
                });
              }
            }
          };
          await collect(root);
          if (files.length === 0) throw new Error('source-empty');
          return files;
        } finally {
          await fs.rm(temporary, { recursive: true, force: true });
        }
      });
    },
    async initialize(file, text) {
      await prepareParent(file);
      try {
        await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 });
        return true;
      } catch (error) {
        if (errorCode(error) === 'EEXIST') {
          await fileStat(file);
          return false;
        }
        throw error;
      }
    },
    async remove(file, expected) {
      await prepareParent(file);
      const current = await fingerprint(file);
      if (current === null) return;
      if (current !== expected) throw new Error('binary-changed');
      await fs.unlink(file);
      await syncParentDirectory(file);
    },
    async npmIdentity() {
      const tool = await resolveNpm();
      if ((await fs.realpath(tool.entry)) !== tool.binary || (await fingerprint(tool.binary)) !== tool.stamp)
        throw new Error('npm-changed');
      return { ...tool };
    },
    async npm(args, options) {
      try {
        const tool = await resolveNpm();
        if (
          (await fs.realpath(tool.entry)) !== tool.binary ||
          (await fingerprint(tool.binary, options?.signal)) !== tool.stamp
        )
          throw new Error('npm-changed');
        return await run(process.execPath, [tool.binary, ...args], environment, cwd, options);
      } catch (error) {
        if (errorCode(error) === 'npm-changed') throw error;
        return {
          code: null,
          stdout: '',
          failed: true,
          ...(errorCode(error) === 'npm-not-found' ? { reason: 'npm-not-found' as const } : {}),
        };
      }
    },
  };
}
