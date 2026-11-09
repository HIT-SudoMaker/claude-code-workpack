import { errorCode, succeeded } from './machine.js';
import type { Machine } from './machine.js';

export type NpmRegistry = string | null;

export interface NpmResolution<T> {
  readonly value: T;
  readonly registry: NpmRegistry;
}

const NPM_MIRROR = 'https://registry.npmmirror.com';
export const NPM_OFFICIAL = 'https://registry.npmjs.org';
export const NPM_READ_TIMEOUT_MS = 5_000;

const NPM_AUDIT_FREE = ['--no-audit', '--no-fund'] as const;
/** 需要安装期脚本的包（claude、ccline）以此启用脚本执行；字面量不得散布 */
export const NPM_ENABLE_SCRIPTS = ['--ignore-scripts=false'] as const;
const queryFlags = ['--fetch-retries=0', '--fetch-timeout=4000'] as const;
const installFlags = ['--fetch-retries=1', '--fetch-timeout=30000'] as const;

/** 精确三段版本号（无前后缀） */
export const isExactVersion = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);

function registryFlags(registry: string, packageSpec: string) {
  const scope = /^(@[a-z0-9._-]+)\/[a-z0-9._-]+(?:@[^\s]+)?$/i.exec(packageSpec)?.[1];
  if (scope === undefined) return [`--registry=${registry}`];
  return [`--registry=${registry}`, `--${scope}:registry=${registry}`];
}

function registries(preferred: NpmRegistry = null) {
  const values: NpmRegistry[] = preferred === null ? [null, NPM_MIRROR] : [preferred, null, NPM_MIRROR];
  return values.filter((value, index) => values.indexOf(value) === index);
}

/** 查询当前 npm 配置，并在失败或返回无效值时尝试国内镜像 */
export async function resolveNpmView<T>(
  machine: Machine,
  packageSpec: string,
  field: string,
  parse: (value: unknown) => T | null,
  preferred: NpmRegistry = null,
): Promise<NpmResolution<T> | null> {
  for (const registry of registries(preferred)) {
    const args = [
      'view',
      packageSpec,
      field,
      '--json',
      ...queryFlags,
      ...(registry === null ? [] : registryFlags(registry, packageSpec)),
    ];
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

/** 为一次已冻结来源的安装设置网络边界，不改变用户 npm 配置 */
export function npmInstallArgs(args: readonly string[], registry: NpmRegistry): readonly string[] {
  const target = args.at(-1);
  if (target === undefined) throw new Error('invalid-npm-command');
  return [
    ...args.slice(0, -1),
    ...NPM_AUDIT_FREE,
    ...installFlags,
    ...(registry === null ? [] : registryFlags(registry, target)),
    target,
  ];
}

/** 卸载同样规避审计与资助的网络请求 */
export function npmUninstallArgs(args: readonly string[]): readonly string[] {
  const target = args.at(-1);
  if (target === undefined) throw new Error('invalid-npm-command');
  return [...args.slice(0, -1), ...NPM_AUDIT_FREE, target];
}
