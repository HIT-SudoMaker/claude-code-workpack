import { errorCode, succeeded } from './machine.js';
import type { ReadMachine } from './machine.js';

/** npm 公开来源输入；null 在查询时表示读取当前配置，在卸载计划中表示无需来源 */
export type NpmRegistry = string | null;

/** 已解析的 npm 元数据及取得该值时使用的来源 */
export interface NpmResolution<T> {
  /** 通过调用者校验的元数据 */
  readonly value: T;
  /** 随元数据冻结的已确认公开来源地址，供后续安装复用 */
  readonly registry: string;
}

const NPM_MIRROR = 'https://registry.npmmirror.com';
/** npm 官方公共注册表 */
export const NPM_OFFICIAL = 'https://registry.npmjs.org';
/** npm 只读子进程的最长等待时间，单位为毫秒 */
export const NPM_READ_TIMEOUT_MS = 5_000;

const NPM_AUDIT_FREE = ['--no-audit', '--no-fund'] as const;
/** Claude 与 CCometixLine 所需的安装期脚本开关，集中维护该固定策略 */
export const NPM_ENABLE_SCRIPTS = ['--ignore-scripts=false'] as const;
const QUERY_FLAGS = ['--fetch-retries=0', '--fetch-timeout=4000'] as const;
const INSTALL_FLAGS = ['--fetch-retries=1', '--fetch-timeout=30000'] as const;

/**
 * 判断输入是否为不含前后缀的三段数字版本号
 *
 * @param value - 待校验的边界数据
 * @returns 是否可收窄为精确版本字符串
 */
export const isExactVersion = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);

/**
 * 从当前 npm 来源及镜像查询并校验元数据
 *
 * @param packageSpec - 包名及可选版本或标签
 * @param field - npm view 查询字段
 * @param parse - 校验解析后的 JSON，无效值返回 null
 * @returns 首个有效值及来源；npm 不可用或全部查询无效时为 null
 * @throws Error - 来源配置或地址无法确认、配置查询拒绝或 npm 身份变化时拒绝
 * @remarks 单次查询失败或内容无效时尝试镜像；返回来源供安装绑定，不修改 npm 配置
 */
export async function resolveNpmView<T>(
  machine: Pick<ReadMachine, 'npm'>,
  packageSpec: string,
  field: string,
  parse: (value: unknown) => T | null,
): Promise<NpmResolution<T> | null> {
  for (const candidate of [null, NPM_MIRROR]) {
    const registry = candidate === null ? await configuredRegistry(machine, packageSpec) : publicRegistry(candidate);
    if (registry === null) return null;
    const args = ['view', packageSpec, field, '--json', ...QUERY_FLAGS, ...registryFlags(registry, packageSpec)];
    try {
      const result = await machine.npm(args, { timeoutMs: NPM_READ_TIMEOUT_MS });
      if (!succeeded(result)) continue;
      const value = parse(JSON.parse(result.stdout) as unknown);
      if (value !== null) return { value, registry };
    } catch (error) {
      if (errorCode(error) === 'npm-changed') throw error;
    }
  }
  return null;
}

/**
 * 为安装命令绑定已冻结的公开来源及网络参数
 *
 * @param args - 末项为目标包的 npm 安装参数
 * @param registry - 已确认的来源地址，不能为 null
 * @returns 保留目标包末项并补入来源、重试及关闭审计参数的新数组
 * @throws Error - 目标包缺失时抛出 invalid-npm-command，来源无效时抛出 source-registry-unconfirmed
 * @remarks 仅构造参数，不执行命令或修改 npm 配置；作用域包同时绑定作用域来源
 */
export function npmInstallArgs(args: readonly string[], registry: NpmRegistry): readonly string[] {
  const target = args.at(-1);
  if (target === undefined) throw new Error('invalid-npm-command');
  if (registry === null) throw new Error('source-registry-unconfirmed');
  return [
    ...args.slice(0, -1),
    ...NPM_AUDIT_FREE,
    ...INSTALL_FLAGS,
    ...registryFlags(publicRegistry(registry), target),
    target,
  ];
}

/**
 * 为卸载命令补入关闭审计与资助查询的参数
 *
 * @param args - 末项为目标包的 npm 卸载参数
 * @returns 保留目标包末项的新参数数组，不执行命令
 * @throws Error - 目标包缺失时抛出 invalid-npm-command
 */
export function npmUninstallArgs(args: readonly string[]): readonly string[] {
  const target = args.at(-1);
  if (target === undefined) throw new Error('invalid-npm-command');
  return [...args.slice(0, -1), ...NPM_AUDIT_FREE, target];
}

/**
 * 比较三段数字版本，用于阻止程序降级
 *
 * @param left - 左侧版本，正常比较要求为三段数字
 * @param right - 右侧版本，正常比较要求为三段数字
 * @returns 正值表示左侧更新，负值表示右侧更新，零表示三段相同
 * @remarks 仅比较前三段且缺失段按零处理；不校验输入或解析版本后缀，非数字段可能产生 NaN
 */
export function compareVersions(left: string, right: string) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// 按 npm view 的项目及用户配置解析作用域来源，再将同一来源绑定到全局安装
async function configuredRegistry(machine: Pick<ReadMachine, 'npm'>, packageSpec: string): Promise<string | null> {
  const scope = packageScope(packageSpec);
  for (const key of [...(scope ? [`${scope}:registry`] : []), 'registry']) {
    const result = await machine.npm(['config', 'get', key], { timeoutMs: NPM_READ_TIMEOUT_MS });
    if (result.reason === 'npm-not-found') return null;
    if (!succeeded(result)) throw new Error('source-registry-unconfirmed');
    const value = result.stdout.trim();
    if (key !== 'registry' && (value === 'undefined' || value === 'null' || value === '')) continue;
    return publicRegistry(value);
  }
  throw new Error('source-registry-unconfirmed');
}

function registryFlags(registry: string, packageSpec: string) {
  const scope = packageScope(packageSpec);
  if (scope === undefined) return [`--registry=${registry}`];
  return [`--registry=${registry}`, `--${scope}:registry=${registry}`];
}

// 冻结的来源地址不含凭据、查询参数及片段，认证仍由 npm 处理
function publicRegistry(value: string): string {
  try {
    const url = new URL(value);
    if (
      value !== value.trim() ||
      /[\r\n\0]/.test(value) ||
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return value;
  } catch {
    throw new Error('source-registry-unconfirmed');
  }
}

function packageScope(packageSpec: string) {
  return /^(@[a-z0-9._-]+)\/[a-z0-9._-]+(?:@[^\s]+)?$/i.exec(packageSpec)?.[1];
}
