import path from 'node:path';
import { knownTitle } from './management-catalog.js';
import { errorCode, isObject } from './machine.js';
import { json, userBinary } from './model.js';
import type { Context, Item, ClaudeCommand } from './model.js';
import { npmGlobalRoot, npmVersion, samePath } from './program-channels.js';
import type { ReadMachine } from './machine.js';
import { NPM_ENABLE_SCRIPTS } from './npm-registry.js';

/** CCW 管理的 Claude npm 包身份 */
export const CLAUDE_PACKAGE = '@anthropic-ai/claude-code';
/** Claude 安装所需的生命周期脚本许可和可选依赖参数 */
export const CLAUDE_NPM_ARGS = [...NPM_ENABLE_SCRIPTS, '--allow-scripts=' + CLAUDE_PACKAGE, '--include=optional'];

/** npm 候选含版本和包目录；外部候选不确认版本，isMissing 表示 npm 入口缺失 */
export type ClaudeProgram = { readonly binary: string; readonly isMissing?: boolean } & (
  | { readonly channel: 'npm'; readonly version: string; readonly npmRoot: string }
  | { readonly channel: 'manual'; readonly version: null }
);

/**
 * 发现 Claude 的 npm 安装、固定用户目录和 PATH 入口
 *
 * @returns 候选映射、展示项目及 npm 检查问题
 * @throws Error - 固定路径或 PATH 文件检查失败时拒绝
 * @remarks npm 检查失败记入 problems，继续发现其他候选；外部入口只展示
 * 发现仅确认记录及路径，不证明外部程序的身份或版本
 */
export async function claudePrograms(
  ctx: Context,
): Promise<{ items: Item[]; values: Map<string, ClaudeProgram>; problems: string[] }> {
  const kind = 'claude';
  const values = new Map<string, ClaudeProgram>();
  const problems: string[] = [];
  try {
    const version = await npmVersion(ctx, CLAUDE_PACKAGE);
    if (version !== null) {
      const npmRoot = await npmGlobalRoot(ctx);
      const binary = await claudeNpmBinary(ctx, npmRoot);
      values.set(kind, {
        channel: 'npm',
        binary,
        version,
        npmRoot,
        isMissing: (await ctx.machine.treeStamp(binary)) === null,
      });
    }
  } catch (error) {
    problems.push(errorCode(error));
  }
  const native = userBinary(ctx, 'claude');
  if ((await ctx.machine.treeStamp(native)) !== null)
    values.set(kind + ':external:' + native, { channel: 'manual', binary: native, version: null });
  for (const binary of await ctx.machine.locate(kind)) {
    const canonical = await ctx.machine.realpath(binary);
    if (!canonical) continue;
    if (
      [...values.values()].some(
        program =>
          samePath(ctx, program.binary, binary) ||
          samePath(ctx, program.binary, canonical) ||
          (program.channel === 'npm' && containsPath(ctx, path.join(program.npmRoot, CLAUDE_PACKAGE), canonical)),
      )
    )
      continue;
    values.set(kind + ':external:' + binary, {
      channel: 'manual',
      binary,
      version: null,
    });
  }
  return {
    values,
    problems,
    items: await Promise.all(
      [...values.entries()].map(async ([id, program]) => ({
        id,
        title: knownTitle(kind),
        kind,
        location: program.binary,
        ...((await npmLauncher(ctx, program, values.get(kind))) ? { launcherFor: kind } : {}),
        canInstall: program.channel !== 'manual',
        facts: [
          { code: program.isMissing ? 'program-missing' : 'program-exists', detail: program.channel },
          ...(program.version ? [{ code: 'program-version', detail: program.version }] : []),
          ...(program.channel === 'manual' ? [{ code: 'external-program-preserved' }] : []),
        ],
        canUninstall: program.channel !== 'manual',
      })),
    ),
  };
}

/**
 * 选择 Claude 入口并冻结路径及指纹
 *
 * @returns 每次调用前复核指纹的命令句柄，不安装程序
 * @throws Error - 发现不完整、缺少非 cmd 入口或无法取得指纹时拒绝
 */
export async function freezeClaudeCommand(ctx: Context): Promise<ClaudeCommand> {
  const found = await claudePrograms(ctx);
  if (found.problems.length) throw new Error('installation-state-unconfirmed');
  const program = [...found.values.values()].find(program => !program.isMissing && !program.binary.endsWith('.cmd'));
  if (!program) throw new Error('claude-not-installed');
  const binary = program.binary;
  const stamp = await ctx.machine.fingerprint(binary);
  if (stamp === null) throw new Error('program-not-ready');
  return bindClaudeCommand(
    ctx,
    () => binary,
    async () => {
      if ((await ctx.machine.fingerprint(binary)) !== stamp) throw new Error('program-changed');
    },
  );
}
/**
 * 将 Claude 命令绑定到可核验的入口
 *
 * @param binary - 核验后读取入口，可随安装结果更新
 * @param verify - 每次执行前的身份或依赖检查，拒绝时停止执行
 * @returns 保留原始命令结果的句柄，不据此确认操作成功
 * @remarks --help 和 auth status 使用只读能力，其余使用写能力；JS 入口由当前 Node 执行
 */
export function bindClaudeCommand(ctx: Context, binary: () => string, verify: () => Promise<void>): ClaudeCommand {
  return {
    verify,
    async execute(args, isInteractive = false) {
      await verify();
      const target = binary();
      const observe = args.includes('--help') || (args[0] === 'auth' && args[1] === 'status');
      return (observe ? ctx.machine : ctx.effects).execute(
        target.endsWith('.js') ? process.execPath : target,
        target.endsWith('.js') ? [target, ...args] : args,
        { env: claudeEnvironment(ctx), cwd: ctx.home, isInteractive },
      );
    },
  };
}
/**
 * 从 npm 清单解析 Claude 包内的命令入口
 *
 * @param root - 已选定的 npm 全局包目录
 * @returns 绝对入口路径，不保证文件存在
 * @throws Error - 清单不可读、未声明命令或入口越出包目录时拒绝
 */
export async function claudeNpmBinary(ctx: Context, root: string) {
  const directory = path.join(root, CLAUDE_PACKAGE);
  const manifest = await json(ctx.machine, path.join(directory, 'package.json'));
  const relative =
    typeof manifest.bin === 'string' ? manifest.bin : isObject(manifest.bin) ? manifest.bin.claude : undefined;
  if (typeof relative !== 'string') throw new Error('program-not-ready');
  const binary = path.resolve(directory, relative);
  if (!binary.startsWith(`${directory}${path.sep}`)) throw new Error('invalid-program-entry');
  return binary;
}
function containsPath(ctx: Context, directory: string, file: string) {
  const root = path.resolve(directory);
  const target = path.resolve(file);
  return ctx.platform === 'win32'
    ? target.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)
    : target.startsWith(`${root}${path.sep}`);
}

async function npmLauncher(ctx: Context, candidate: ClaudeProgram, installed: ClaudeProgram | undefined) {
  if (ctx.platform !== 'win32' || candidate.channel !== 'manual' || installed?.channel !== 'npm') return false;
  if (!samePath(ctx, path.dirname(candidate.binary), path.dirname(installed.npmRoot))) return false;
  if (!['claude', 'claude.cmd', 'claude.ps1'].includes(path.basename(candidate.binary).toLowerCase())) return false;
  // 只关联相同 npm 前缀内明确调用已知入口的脚本；此关联不参与执行资格判断
  try {
    const source = (await ctx.machine.read(candidate.binary))?.replaceAll('\\', '/');
    const target = path.relative(path.dirname(candidate.binary), installed.binary).replaceAll('\\', '/');
    return (
      source
        ?.split(/\r?\n/)
        .some(line =>
          [`"%dp0%/${target}"`, `& "$basedir/${target}"`, `exec "$basedir/${target}"`].some(call =>
            line.trim().startsWith(call),
          ),
        ) ?? false
    );
  } catch (error) {
    if (errorCode(error) === 'cancelled') throw error;
    return false;
  }
}

/**
 * 生成指向本次配置根的 Claude 环境覆盖
 *
 * @param ctx - 含用户目录与状态文件路径的上下文
 * @returns 默认状态文件位置下取消 CLAUDE_CONFIG_DIR 覆盖，否则使用当前配置根
 */
function claudeEnvironment(ctx: Context) {
  return { CLAUDE_CONFIG_DIR: ctx.stateFile === path.join(ctx.home, '.claude.json') ? undefined : ctx.claudeRoot };
}

/**
 * 检查当前是否存在可识别的 Claude 进程
 *
 * @param machine - 提供进程枚举的读取能力
 * @param signal - 传给枚举过程的取消信号
 * @returns 存在为 true，不存在为 false，枚举未确认时为 null
 * @throws Error - 底层读取拒绝时原样传播
 */
export async function claudeRunning(
  machine: { readonly processes: ReadMachine['processes'] },
  signal?: AbortSignal,
): Promise<boolean | null> {
  const found = await machine.processes(signal ? { signal } : undefined);
  if (found === null) return null;
  return found.some(entry => claudeProcessActive(entry.name, entry.command));
}

/** 根据进程名称或 Node 命令行识别 Claude，不读取进程状态 */
function claudeProcessActive(name: string, command: string): boolean {
  return (
    /(?:^|[\\/])(?:claude|Claude Code)(?:\.exe)?$/i.test(name) ||
    (/(?:^|[\\/])node(?:js)?(?:\.exe)?$/i.test(name) &&
      /(?:^|[\\/\s"'])@anthropic-ai[\\/]claude-code(?:[\\/]|$)/i.test(command))
  );
}
