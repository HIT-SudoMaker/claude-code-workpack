import path from 'node:path';
import { isObject } from './machine.js';
import { normalizePath, success } from './model.js';
import type { Context } from './model.js';
import { NPM_READ_TIMEOUT_MS } from './npm-registry.js';

/** 冻结一次 npm 操作使用的全局安装目录、显式参数与可执行身份 */
export interface FrozenNpmScope {
  /** npm 报告的全局包目录 */
  readonly npmRoot: string;
  /** 根目录的真实路径；无法取得真实路径时保留原路径 */
  readonly canonical: string;
  /** 将后续 npm 操作限定到该全局目录的参数 */
  readonly args: readonly string[];
  /** 准备时的 npm 入口、实际程序路径与内容指纹 */
  readonly identity: { readonly entry: string; readonly binary: string; readonly stamp: string };
}
/**
 * 读取并核验当前 npm 的全局安装范围
 *
 * @param ctx - 提供平台、npm 身份及路径读取能力
 * @returns 经再次核验的目录、真实路径、显式范围参数和 npm 身份快照
 * @throws Error - npm 不可用、目录无效或读取期间范围及身份变化时拒绝 Promise
 * @remarks 仅查询现状，不创建目录；后续写入前仍需调用 verifyNpmScope
 */
export async function freezeNpmScope(ctx: Context) {
  const npmRoot = await npmGlobalRoot(ctx);
  const scope: FrozenNpmScope = {
    npmRoot,
    canonical: (await ctx.machine.realpath(npmRoot)) ?? npmRoot,
    args: npmScopeArgs(ctx, npmRoot),
    identity: await ctx.machine.npmIdentity(),
  };
  await verifyNpmScope(ctx, scope);
  return scope;
}
/**
 * 重新核验冻结的 npm 身份与全局安装范围
 *
 * @param ctx - 提供 npm 查询及真实路径读取能力
 * @param scope - 准备阶段冻结的目录、参数和程序身份
 * @returns npm 身份、默认范围及显式范围均匹配时完成，不修改目标
 * @throws Error - npm 不可用、目录无效、身份或安装范围变化时拒绝 Promise
 */
export async function verifyNpmScope(ctx: Context, scope: FrozenNpmScope) {
  const identity = await ctx.machine.npmIdentity();
  if (
    identity.entry !== scope.identity.entry ||
    identity.binary !== scope.identity.binary ||
    identity.stamp !== scope.identity.stamp
  )
    throw new Error('program-scope-unconfirmed');
  for (const root of [await npmGlobalRoot(ctx), await npmGlobalRoot(ctx, scope.npmRoot)])
    if (!(await matchesNpmScope(ctx, scope, root))) throw new Error('program-scope-unconfirmed');
}
/**
 * 从 npm 全局安装记录读取指定包的版本
 *
 * @param ctx - 提供 npm 查询及目录读取能力
 * @param name - 要精确匹配的包名
 * @param root - 已冻结的全局包目录；省略时检查当前默认范围，允许 npm 尚未安装
 * @returns 已校验的版本；包未登记、确认全局目录缺失或默认检查中 npm 缺失时返回 null
 * @throws Error - 指定范围时 npm 缺失、命令失败、安装记录异常或版本字段无效时拒绝 Promise
 * @remarks 退出码 1 仍需检查返回记录，不单凭非零退出码判定失败；版本记录不证明入口存在
 */
export async function npmVersion(ctx: Context, name: string, root?: string): Promise<string | null> {
  const result = await ctx.machine.npm(['ls', '-g', ...npmScopeArgs(ctx, root), '--depth=0', '--json', name], {
    timeoutMs: NPM_READ_TIMEOUT_MS,
  });
  if (result.reason === 'npm-not-found') {
    if (root !== undefined) throw new Error('npm-not-found');
    return null;
  }
  if (result.failed) throw new Error('npm-inspection-failed');
  let npmResult: unknown;
  try {
    npmResult = JSON.parse(result.stdout);
  } catch {
    throw new Error('invalid-npm-result');
  }
  if (
    isObject(npmResult) &&
    isObject(npmResult.error) &&
    npmResult.error.code === 'ENOENT' &&
    (await ctx.machine.treeStamp(await npmGlobalRoot(ctx, root))) === null
  )
    return null;
  // npm ls 的退出码 1 也可能表示未安装，仍须继续检查错误字段与依赖记录
  if (result.code !== 0 && result.code !== 1) throw new Error('npm-inspection-failed');
  if (
    !isObject(npmResult) ||
    npmResult.error !== undefined ||
    (Array.isArray(npmResult.problems) && npmResult.problems.length)
  )
    throw new Error('npm-inspection-failed');
  if (npmResult.dependencies === undefined) return null;
  if (!isObject(npmResult.dependencies)) throw new Error('invalid-npm-result');
  const entry = npmResult.dependencies[name];
  if (entry === undefined) return null;
  if (!isObject(entry) || typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(entry.version))
    throw new Error('invalid-npm-result');
  return entry.version;
}

/**
 * 按平台路径规则比较两个路径
 *
 * @returns 解析为绝对路径后是否相同，Windows 忽略大小写
 * @remarks 不读取文件系统，也不解析符号链接
 */
export function samePath(ctx: Context, left: string, right: string) {
  return normalizePath(ctx.platform, left) === normalizePath(ctx.platform, right);
}

/**
 * 查询 npm 全局包目录，可限定到已冻结的安装范围
 *
 * @param expected - 已确认的包目录；省略时读取当前默认范围
 * @returns npm 返回的绝对包目录，不创建或修改目录
 * @throws Error - npm 不可用、查询失败或返回路径无效时拒绝
 */
export async function npmGlobalRoot(ctx: Context, expected?: string) {
  const result = await ctx.machine.npm(['root', '-g', ...npmScopeArgs(ctx, expected)], {
    timeoutMs: NPM_READ_TIMEOUT_MS,
  });
  if (result.reason === 'npm-not-found') throw new Error('npm-not-found');
  const root = success(result).trim();
  if (!path.isAbsolute(root) || /[\r\n]/.test(root)) throw new Error('invalid-npm-root');
  return root;
}
async function matchesNpmScope(ctx: Context, scope: FrozenNpmScope, root: string) {
  return samePath(ctx, (await ctx.machine.realpath(root)) ?? root, scope.canonical);
}

function npmScopeArgs(ctx: Context, root?: string) {
  if (root === undefined) return [];
  const prefix = ctx.platform === 'win32' ? path.dirname(root) : path.dirname(path.dirname(root));
  return [`--prefix=${prefix}`];
}
