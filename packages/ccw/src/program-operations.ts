import { createHash } from 'node:crypto';
import { step } from './work.js';
import type { Work, Receipt } from './work.js';
import type { Change, Context } from './model.js';
import { cancelled, commandReceipt } from './model.js';
import { errorCode } from './machine.js';
import { npmVersion, verifyNpmScope } from './program-channels.js';
import type { FrozenNpmScope } from './program-channels.js';
import { npmInstallArgs, npmUninstallArgs } from './npm-registry.js';
import type { NpmRegistry } from './npm-registry.js';
/**
 * 准备移除摘要匹配的程序文件
 *
 * @param target - 路径与树摘要，null 表示原本不存在
 * @param changes - 预览说明，可为空数组
 * @returns 目标缺失即完成，摘要变化则以 program-changed 阻止移除
 */
export function removeProgramFile(
  ctx: Context,
  target: { readonly file: string; readonly before: string | null },
  changes: readonly Change[],
): Work {
  const { file, before } = target;
  return step(
    changes,
    async fact => {
      const current = await ctx.machine.treeStamp(file);
      if (current === null)
        return {
          state: 'complete',
          effects: fact.dispatched ? [{ state: 'done', code: 'program-removed', detail: file }] : [],
        };
      if (fact.confirmed || current !== before) return { state: 'blocked', problem: 'program-changed' };
      return { state: 'ready' };
    },
    before === null
      ? undefined
      : async () => {
          await ctx.effects.removeTree(file, before);
          return { receipt: { kind: 'returned', failure: null } };
        },
  );
}
/**
 * 准备按摘要替换程序文件
 *
 * @param target - 路径、原指纹、目标 SHA-256 和字节；bytes 为 null 时仅复用匹配的原件
 * @param changes - 预览说明，可为空数组
 * @returns 按最终摘要确认的替换步骤；拒绝覆盖准备后变化的目标
 * @remarks 写入前复核候选字节的摘要
 */
export function deployProgram(
  ctx: Context,
  target: {
    readonly binary: string;
    readonly before: string | null;
    readonly digest: string;
    readonly bytes: Uint8Array | null;
  },
  changes: readonly Change[],
): Work {
  return step(
    changes,
    async fact => {
      const current = await ctx.machine.fingerprint(target.binary);
      if (current === target.digest && (target.bytes === null || fact.dispatched))
        return {
          state: 'complete',
          effects: [
            {
              state: target.bytes === null ? 'kept' : 'done',
              code: target.bytes === null ? 'program-kept' : 'program-file-ready',
            },
          ],
        };
      if (fact.dispatched || current !== target.before)
        return { state: 'blocked', problem: fact.receipt?.failure ?? 'program-changed' };
      return { state: 'ready' };
    },
    async () => {
      if (!target.bytes || createHash('sha256').update(target.bytes).digest('hex') !== target.digest)
        throw new Error('release-checksum-mismatch');
      await ctx.effects.replaceFile(target.binary, target.bytes, target.before, true);
      return { receipt: { kind: 'returned', failure: null } };
    },
  );
}
/**
 * 准备将程序目录加入用户 PATH
 *
 * @param directory - 非根绝对目录，不得包含换行或空字符
 * @returns 已包含时直接完成，否则写入后核验
 */
export function programPath(ctx: Context, directory: string, changes: readonly Change[]): Work {
  return step(
    changes,
    async () =>
      (await ctx.machine.userPathContains(directory))
        ? { state: 'complete', effects: [{ state: 'done', code: 'program-user-path' }] }
        : { state: 'ready' },
    async () => {
      await ctx.effects.ensureUserPath(directory);
      return { receipt: { kind: 'returned', failure: null } };
    },
  );
}
/**
 * 准备绑定 npm 身份、范围和来源的程序变更
 *
 * @param target - version 为 null 表示卸载；readBinary 重读安装入口，assertReady 检查工具前置条件
 * @returns 延迟步骤及当前入口读取器
 * @remarks 每次检查和写入前复核 npm 身份与范围，写入前还复核原版本与指纹
 * 安装使用冻结来源与精确版本；已有目标版本和入口时保留
 * 派发后按版本及捕获指纹确认结果；回执丢失仍捕获，捕获失败不算完成
 */
export function npmProgram(
  ctx: Context,
  target: {
    readonly name: string;
    readonly readBinary?: () => Promise<string>;
    readonly binary: string;
    readonly version: string | null;
    readonly beforeVersion: string | null;
    readonly beforeStamp: string | null;
    readonly scope: FrozenNpmScope;
    readonly registry: NpmRegistry;
    readonly args: readonly string[];
    /** 工具专属前置条件，在观察及派发前再次核对 */
    readonly assertReady?: () => Promise<void>;
  },
  changes: readonly Change[],
): Work & { binary(): string } {
  let installedBinary = target.binary;
  let captured: string | null | undefined;
  const operation = step(
    changes,
    async fact => {
      await verifyNpmScope(ctx, target.scope);
      await target.assertReady?.();
      const version = await npmVersion(ctx, target.name, target.scope.npmRoot);
      if (fact.dispatched && target.readBinary && version !== null) installedBinary = await target.readBinary();
      const stamp = await ctx.machine.fingerprint(installedBinary);
      if (fact.dispatched) {
        if (captured === undefined)
          return { state: 'blocked', problem: fact.receipt?.failure ?? 'program-installation-unconfirmed' };
        if (
          version === target.version &&
          (target.version === null ? stamp === null : stamp !== null && stamp === captured)
        )
          return {
            state: 'complete',
            effects: [{ state: 'done', code: target.version === null ? 'program-removed' : 'program-ready' }],
          };
        return {
          state: 'blocked',
          problem:
            fact.receipt?.failure ??
            (stamp !== captured
              ? 'program-changed'
              : target.version === null
                ? 'program-removal-unconfirmed'
                : 'program-not-ready'),
        };
      }
      if (version !== target.beforeVersion || stamp !== target.beforeStamp)
        return { state: 'blocked', problem: 'program-changed' };
      if (target.version !== null && version === target.version && stamp !== null)
        return {
          state: 'complete',
          effects: [{ state: 'kept', code: 'program-kept' }],
        };
      return { state: 'ready' };
    },
    async (signal, verify) => {
      cancelled(signal);
      await verifyNpmScope(ctx, target.scope);
      await target.assertReady?.();
      if (
        (await npmVersion(ctx, target.name, target.scope.npmRoot)) !== target.beforeVersion ||
        (await ctx.machine.fingerprint(target.binary)) !== target.beforeStamp
      )
        throw new Error('program-changed');
      let receipt: Receipt;
      try {
        const result = await ctx.effects.npm(
          target.version === null
            ? npmUninstallArgs(['uninstall', '-g', ...target.scope.args, '--ignore-scripts', target.name])
            : npmInstallArgs(
                ['install', '-g', ...target.scope.args, ...target.args, target.name + '@' + target.version],
                target.registry,
              ),
        );
        receipt = commandReceipt(result, target.version === null ? 'npm-uninstall-failed' : 'npm-install-failed');
      } catch (error) {
        receipt = { kind: 'unknown', failure: errorCode(error) };
      }
      try {
        await verify(async () => {
          if (target.readBinary && target.version !== null) installedBinary = await target.readBinary();
          captured = await ctx.machine.fingerprint(installedBinary);
        });
      } catch {
        // 捕获失败保留未知状态，不能用空指纹伪装已确认的卸载结果
        captured = undefined;
      }
      return { receipt };
    },
  );
  return { ...operation, binary: () => installedBinary };
}
