import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';

/** 子进程退出状态与捕获的标准输出；非零退出码也可能对应 failed 为 false */
export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly failed: boolean;
  readonly reason?: 'npm-not-found';
}
/** 目录直属条目的类型与字节大小 */
interface FileEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'link';
  readonly sizeBytes: bigint;
}
/** 进程名称与可读取的命令行；命令行不可读时为空串 */
interface ProcessEntry {
  readonly name: string;
  readonly command: string;
}
/** 待部署文件的斜杠分隔相对路径与原始字节 */
export interface TreeFile {
  readonly path: string;
  readonly data: Uint8Array;
}
/** 子进程选项；省略环境或工作目录时沿用实例配置 */
export interface CommandOptions {
  /** 按键覆盖实例环境；undefined 值不传入子进程 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly isInteractive?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
/** 读取操作可选的毫秒时限与取消信号 */
type ReadOptions = Pick<CommandOptions, 'timeoutMs' | 'signal'>;

interface RemoteRead {
  readonly signal: AbortSignal;
  readonly check: () => void;
}
/**
 * 提供本机文件、进程与远端来源访问
 *
 * @remarks 写入授权与只读命令限制由能力包装层施加；这些方法本身不提供统一取消门禁
 * 写入失败可能已产生目录、文件或进程效果，不自动回滚，调用者须独立核验
 */
export interface Machine {
  /**
   * 获取并复核本实例固定的 npm 入口、真实路径与内容摘要
   *
   * @returns 首次成功解析后固定的 npm 身份
   * @throws Error - 无法找到 npm、入口或内容已改变以及文件读取失败时 Promise 拒绝
   */
  npmIdentity(): Promise<{ readonly entry: string; readonly binary: string; readonly stamp: string }>;
  /**
   * 检查继承的 PATH 或持久配置是否包含目录
   *
   * @param directory - 不含换行或空字符的非根绝对目录
   * @param options - Windows 查询命令的可选毫秒时限与取消信号
   * @returns 已确认包含时为 true；Windows 查询用户与系统 PATH，POSIX 配置仅识别本工具生成的完整行
   * @throws Error - 目录无效、用户配置位置不明、读取失败或 Windows 查询无法确认时 Promise 拒绝
   */
  userPathContains(directory: string, options?: ReadOptions): Promise<boolean>;
  /**
   * 检查普通文件大小不超过 2 MiB 后读取 UTF-8 文本
   *
   * @returns 文件内容；路径不存在时为 null
   * @throws Error - 文件为链接、不是普通文件、超过大小限制或读取失败时 Promise 拒绝
   */
  read(file: string): Promise<string | null>;
  /**
   * 流式计算普通文件的 SHA-256 摘要
   *
   * @param file - 待读取的普通文件路径
   * @param signal - 可选取消信号；已取消时抛出其 reason，流式读取时也会响应取消
   * @returns 十六进制摘要；路径不存在时为 null
   * @throws 文件类型不符、读取失败或信号取消时 Promise 拒绝
   */
  fingerprint(file: string, signal?: AbortSignal): Promise<string | null>;
  /**
   * 创建父目录后，以排他创建方式写入 UTF-8 文件
   *
   * @returns 新建成功时为 true；已有普通文件未被覆盖时为 false
   * @throws Error - 父目录含链接、已有目标类型不符或文件操作失败时 Promise 拒绝
   */
  initialize(file: string, text: string): Promise<boolean>;
  /**
   * 修改 JSON 对象，并在原文本未变化时以暂存文件替换目标
   *
   * @param file - 待编辑的 JSON 文件路径
   * @param edit - 同步修改对象的回调；目标缺失时接收空对象
   * @throws JSON 解析、对象校验、序列化、原文复核或文件操作失败时 Promise 拒绝；回调抛出的值原样传播
   * @remarks 会创建父目录；写回使用两空格缩进并添加末尾换行
   */
  editJson(file: string, edit: (value: Record<string, unknown>) => void): Promise<void>;
  /**
   * 使用本实例固定的 npm 执行参数数组
   *
   * @param args - 传给 npm 的参数，不经过 shell 展开
   * @param options - 环境、工作目录、默认 5 分钟时限与取消信号
   * @returns 退出码与标准输出；解析失败、进程失败、超时或取消通过失败结果返回
   * @throws Error - 固定入口或内容变化时以 npm-changed 拒绝 Promise；本实例不会改用新的 npm 身份
   */
  npm(args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
  /**
   * 按名称排序列出目录直属条目
   *
   * @returns 条目列表；路径不存在时为空数组
   * @throws Error - 目录本身为链接、存在特殊文件或读取失败时 Promise 拒绝
   */
  entries(directory: string): Promise<readonly FileEntry[]>;
  /**
   * 计算文件、目录树或链接目标文本的 SHA-256 摘要，不跟随链接
   *
   * @param file - 待核验的文件、目录或链接路径
   * @param signal - 可选取消信号；已取消时抛出其 reason，遍历及文件读取期间也会检查
   * @returns 十六进制摘要；路径不存在时为 null
   * @throws 遇到特殊文件、读取失败或信号取消时 Promise 拒绝
   */
  treeStamp(file: string, signal?: AbortSignal): Promise<string | null>;
  /**
   * 核对摘要后删除目标，或将目标移到保留位置
   *
   * @param file - 待移除的非根路径
   * @param expected - 操作前要求匹配的 treeStamp 摘要
   * @param preserveAt - 可选保留位置，必须尚不存在
   * @throws Error - 目标为文件系统根、摘要变化、保留位置已存在、目标仍残留或文件操作失败时 Promise 拒绝
   * @remarks 会检查并创建父目录；删除链接仅移除链接本身
   */
  removeTree(file: string, expected: string, preserveAt?: string): Promise<void>;
  /**
   * 暂存文件集合，核对目标摘要后替换整个目录
   *
   * @param directory - 待替换的目标目录路径
   * @param files - 目标树内的相对路径文件集合，不得含反斜杠或 .、..、.git 路径段
   * @param expected - 要求匹配的 treeStamp 摘要；null 表示目标应不存在
   * @param preserveAt - expected 非 null 时已有目标的可选保留位置，必须尚不存在
   * @throws Error - 路径无效、摘要变化、保留失败或文件操作失败时 Promise 拒绝
   * @remarks 不保留空目录或原文件权限；先移除或保留已有目标，再移入暂存目录，失败时不恢复原目标
   */
  replaceTree(
    directory: string,
    files: readonly TreeFile[],
    expected: string | null,
    preserveAt?: string,
  ): Promise<void>;
  /**
   * 按参数数组启动命令，交互执行时可通过终端交接回调运行
   *
   * @param executable - 可执行文件名或路径；Windows 的 .ps1 文件与 scoop 可通过 PowerShell 执行
   * @param args - 传给进程的参数，不经过 shell 展开
   * @param options - 环境覆盖、工作目录、交互模式、时限与取消信号
   * @returns 退出码与捕获的标准输出；进程错误、超时、取消或输出超限通常以 failed 返回
   * @throws 启动准备或终端交接失败时可同步抛出或拒绝 Promise
   * @remarks 非交互标准输出上限为 1 MiB，标准错误不进入结果；交互执行继承终端流
   * 默认时限为非交互 5 分钟、交互 15 分钟；非零退出码须结合 succeeded 判断
   */
  execute(executable: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
  /**
   * 在实例当前 PATH 中查找同名普通文件
   *
   * @param command - 仅含字母、数字、下划线、点或连字符的命令名
   * @returns 去重的绝对路径；Windows 同时检查 exe、cmd、ps1 和无扩展名文件
   * @throws Error - 命令名无效或文件检查失败时 Promise 拒绝
   */
  locate(command: string): Promise<readonly string[]>;
  /**
   * 解析路径及其中的符号链接
   *
   * @returns 真实路径；路径不存在时为 null
   * @throws Error - 除路径缺失外的解析失败使 Promise 拒绝
   */
  realpath(file: string): Promise<string | null>;
  /**
   * 下载不超过 8 MiB 的 HTTPS 响应并解码为 UTF-8 文本
   *
   * @param url - HTTPS 请求地址；最终响应地址也须为 HTTPS
   * @param options - 可覆盖默认 30 秒时限并提供取消信号
   * @returns 解码后的响应正文；没有响应体时为空串
   * @throws Error - URL 或最终响应协议无效、请求失败、超限、超时或取消时 Promise 拒绝
   */
  fetchText(url: string, options?: ReadOptions): Promise<string>;
  /**
   * 下载不超过 256 MiB 且带响应体的 HTTPS 响应
   *
   * @param url - HTTPS 请求地址；最终响应地址也须为 HTTPS
   * @param options - 可覆盖默认 120 秒时限并提供取消信号
   * @returns 原始响应字节
   * @throws Error - URL 或最终响应协议无效、请求失败、超限、超时或取消时 Promise 拒绝
   */
  fetchBytes(url: string, options?: ReadOptions): Promise<Uint8Array>;
  /**
   * 两次核对原文件摘要后，以已同步的暂存文件替换目标并复核新摘要
   *
   * @param file - 待替换的普通文件路径
   * @param data - 新文件的原始字节
   * @param expected - 要求匹配的文件摘要；null 表示目标应不存在
   * @param shouldMarkExecutable - 为 true 时以 0755 创建暂存文件，否则以已有权限或 0600 创建；受 umask 约束
   * @throws Error - 父目录含链接、目标类型不符、摘要变化或文件操作失败时 Promise 拒绝
   * @remarks 会创建父目录；替换后的同步或摘要核验也可能失败，此时目标已发生变化
   */
  replaceFile(file: string, data: Uint8Array, expected: string | null, shouldMarkExecutable?: boolean): Promise<void>;
  /**
   * 当前 PATH 缺少目录时，将其写入用户持久配置并更新本实例环境
   *
   * @param directory - 不含换行或空字符的非根绝对目录
   * @throws Error - 目录无效、用户配置位置不明、配置变化或保存失败时 Promise 拒绝
   * @remarks Windows 写入用户 PATH，POSIX 更新所选 shell 配置文件；不修改父进程环境
   */
  ensureUserPath(directory: string): Promise<void>;
  /**
   * 在临时目录检出 GitHub 提交并读取指定子树，结束时清理临时目录
   *
   * @param repository - HTTPS GitHub 仓库地址
   * @param revision - 40 位小写十六进制提交号
   * @param subdirectory - 仓库相对目录，禁用反斜杠及 .、..、.git 路径段；单独 . 表示仓库根
   * @param options - 可覆盖默认 120 秒总时限并提供取消信号
   * @returns 总计不超过 256 MiB 的非空普通文件集合
   * @throws Error - 来源无效、命令失败、含链接、为空、超限、超时、取消或文件操作失败时 Promise 拒绝
   * @remarks 不写入受管目标，但会创建临时目录并执行 git
   */
  source(
    repository: string,
    revision: string,
    subdirectory: string,
    options?: ReadOptions,
  ): Promise<readonly TreeFile[]>;
  /**
   * 枚举进程名称与可读取的命令行，不作产品归属判定
   *
   * @param options - 枚举命令的可选毫秒时限与取消信号
   * @returns 进程列表；命令或解析失败时为 null，命令行不可读时保留名称并使用空串
   * @throws 底层命令调用本身拒绝时 Promise 拒绝；取消通常通过失败结果返回 null
   */
  processes(options?: ReadOptions): Promise<readonly ProcessEntry[] | null>;
}

/** 可产生受管目标或进程效果的能力集合；需通过执行资格包装后交给工具域 */
export type EffectMachine = Pick<
  Machine,
  'initialize' | 'editJson' | 'npm' | 'removeTree' | 'replaceTree' | 'execute' | 'replaceFile' | 'ensureUserPath'
>;

/** 观察与来源暂存能力；不含受管目标写入方法，命令仍需经过可信查询门 */
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

/** 只读短命令的默认毫秒时限 */
export const READ_COMMAND_TIMEOUT_MS = 5_000;
/** Git 元数据查询的默认毫秒时限 */
export const GIT_COMMAND_TIMEOUT_MS = 15_000;
/** 远端文本下载的默认毫秒时限 */
export const FETCH_TEXT_TIMEOUT_MS = 30_000;
/** 远端字节下载的默认毫秒时限 */
export const FETCH_BYTES_TIMEOUT_MS = 120_000;
/** Git 来源检出的默认总毫秒时限 */
export const SOURCE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 300_000;
const INTERACTIVE_COMMAND_TIMEOUT_MS = 900_000;
const FORCE_STOP_DELAY_MS = 250;

/** 检查是否为 40 位小写十六进制提交号，不验证提交是否存在 */
export const isGitRevision = (value: string): boolean => /^[a-f0-9]{40}$/.test(value);

/** 限制整读内容的内存占用 */
const FILE_LIMIT_BYTES = 2 * 1024 * 1024;
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const TEXT_LIMIT_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_LIMIT_BYTES = 256 * 1024 * 1024;
const SOURCE_LIMIT_BYTES = 256 * 1024 * 1024;

/**
 * 创建隔离的环境副本，封装本机访问并在首次成功解析时固定 npm 身份
 *
 * @param environment - 命令环境初值，后续用户 PATH 更新只修改实例内副本
 * @param cwd - 未单独指定工作目录时使用的目录
 * @param handoff - 交互命令可选的终端交接回调，由回调负责执行传入工作
 * @returns 具有直接系统访问能力的 Machine，调用方仍需施加读写权限包装
 */
export function createMachine(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  handoff?: (work: () => Promise<CommandResult>) => Promise<CommandResult>,
): Machine {
  environment = normalizeEnvironment(environment);
  const inheritedPath = environment.PATH ?? '';
  let npmTool: Promise<{ entry: string; binary: string; stamp: string }> | undefined;
  const resolveNpm = async (signal?: AbortSignal) => {
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
    const tool = await npmTool;
    if ((await fs.realpath(tool.entry)) !== tool.binary || (await fingerprint(tool.binary, signal)) !== tool.stamp)
      throw new Error('npm-changed');
    return { ...tool };
  };
  return {
    read,
    fingerprint,
    editJson,
    entries,
    treeStamp,
    removeTree,
    replaceFile,
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
    async processes(options = {}) {
      const commandOptions = { ...options, timeoutMs: options.timeoutMs ?? READ_COMMAND_TIMEOUT_MS };
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
              commandOptions,
            )
          : await this.execute('ps', ['-A', '-o', 'comm=', '-o', 'args='], commandOptions);
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
    async userPathContains(directory, options = {}) {
      if (pathIncludes(inheritedPath, directory)) return true;
      const target = userPathProfile(environment, directory);
      if (process.platform !== 'win32')
        return (await read(target.profile))?.split(/\r?\n/).includes(target.line) ?? false;
      const script =
        "$ErrorActionPreference='Stop'; $entry=$env:CCW_PATH_ENTRY; $parts=@(([Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')) -split ';' | Where-Object { $_ }); if ($parts | Where-Object { $_.TrimEnd('\\') -ieq $entry.TrimEnd('\\') }) { 'true' } else { 'false' }";
      const result = await this.execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        ...options,
        timeoutMs: options.timeoutMs ?? READ_COMMAND_TIMEOUT_MS,
        env: { CCW_PATH_ENTRY: directory },
      });
      if (!succeeded(result) || !['true', 'false'].includes(result.stdout.trim()))
        throw new Error('user-path-unconfirmed');
      return result.stdout.trim() === 'true';
    },
    async ensureUserPath(directory) {
      const separator = path.delimiter;
      const current = environment.PATH ?? '';
      if (pathIncludes(current, directory)) return;
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
    npmIdentity: resolveNpm,
    async npm(args, options) {
      try {
        const tool = await resolveNpm(options?.signal);
        return await run(
          process.execPath,
          [tool.binary, ...args],
          { ...environment, ...normalizeEnvironment(options?.env ?? {}) },
          options?.cwd ?? cwd,
          options,
        );
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

/**
 * 按 treeStamp 的目录规则计算文件集合摘要
 *
 * @param files - 使用斜杠分隔的相对路径，不得重复或形成文件与目录冲突
 * @returns 部署这些文件后可用于核验的 SHA-256 目录摘要
 * @throws Error - 路径为空、越界、含禁用片段、重复或冲突时抛出 invalid-source-path
 */
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

/** 仅在未标记失败且退出码为零时确认命令成功 */
export function succeeded(result: CommandResult) {
  return !(result.failed || result.code !== 0);
}

/** 提取字符串 code 或符合错误码形状的 Error.message，否则返回 operation-failed */
export function errorCode(error: unknown): string {
  if (isObject(error) && typeof error.code === 'string') return error.code;
  if (error instanceof Error && /^[a-z][a-z-]+$/.test(error.message)) return error.message;
  return 'operation-failed';
}

/** 判断值是否为非 null、非数组对象，不验证原型或属性内容 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

async function editJson(file: string, edit: (value: Record<string, unknown>) => void) {
  await prepareParent(file);
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
  }
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
    return await read({ signal, check });
  } finally {
    clearTimeout(timer);
    check();
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
          }, FORCE_STOP_DELAY_MS);
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        // 交互命令共享终端进程组，只终止所选子进程
        child.kill();
        forceStop = setTimeout(() => {
          child.kill('SIGKILL');
        }, FORCE_STOP_DELAY_MS);
      }
    };
    const timer = setTimeout(
      stop,
      options.timeoutMs ?? (options.isInteractive ? INTERACTIVE_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS),
    );
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

/** 为已校验的目录生成用户 PATH 配置位置与写入行 */
function userPathProfile(environment: NodeJS.ProcessEnv, directory: string) {
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

/** 校验目标目录，并按平台规则检查 PATH 是否包含它 */
function pathIncludes(value: string, directory: string) {
  if (
    !path.isAbsolute(directory) ||
    path.parse(directory).root === path.resolve(directory) ||
    /[\r\n\0]/.test(directory)
  )
    throw new Error('invalid-target');
  return value
    .split(path.delimiter)
    .filter(Boolean)
    .some(entry =>
      process.platform === 'win32'
        ? path.resolve(entry).toLowerCase() === path.resolve(directory).toLowerCase()
        : entry === directory,
    );
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

/** POSIX 还需提交目录项；Windows 不支持用普通目录句柄执行 fsync */
async function syncParentDirectory(file: string) {
  if (os.type() === 'Windows_NT') return;
  const directory = await fs.open(path.dirname(file), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
