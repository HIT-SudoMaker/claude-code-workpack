import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { errorCode, succeeded } from './machine.js';
import type { CommandResult } from './machine.js';
import { cancelled, claudeEnvironment, userBinary } from './model.js';
import type { Context, Effect, Prepared } from './model.js';
import { npmInstallArgs, npmUninstallArgs } from './npm-registry.js';
import type { NpmRegistry } from './npm-registry.js';
import {
  freezeNpmScope,
  npmBinary,
  npmGlobalRoot,
  npmScriptFlags,
  npmVersion,
  PROGRAM_PACKAGES,
  samePath,
} from './program-channels.js';
import type { NpmScope, Program } from './program-channels.js';
import { installScratch } from './storage.js';

interface ClaudeInstallContract {
  readonly version: string;
  readonly registry: NpmRegistry;
}

interface ClaudeInstallation {
  inspect(): Promise<{ readonly values: ReadonlyMap<string, Program>; readonly problems: readonly string[] }>;
  installed(channel: 'npm' | 'native'): Promise<Program | undefined>;
}

type NpmSlot = { readonly kind: 'available'; readonly scope: NpmScope } | { readonly kind: 'unavailable' };
type NpmSnapshot =
  | { readonly kind: 'absent' }
  | { readonly kind: 'package'; readonly manifest: string; readonly binary: string; readonly stamp: string | null };
type Receipt =
  | { readonly kind: 'returned'; readonly failure: string | null }
  | { readonly kind: 'unknown'; readonly failure: string };
const commandReceipt = (result: CommandResult, failure: string): Receipt =>
  result.failed || result.code === null
    ? { kind: 'unknown', failure }
    : { kind: 'returned', failure: succeeded(result) ? null : failure };
interface Installer {
  readonly directory: string;
  readonly stamp: string;
}

/** 每次外部命令的 issued 在派发前记录；离开 issued 必须持有即时读回的现实锚点。
 * npm/CMD 从不重发，只有已知失败且原残留未变的 uninstall 可以重试。
 */
type Checkpoint =
  | { readonly phase: 'npm' }
  | { readonly phase: 'npm-issued' }
  | { readonly phase: 'npm-confirm'; readonly receipt: Receipt; readonly snapshot: NpmSnapshot }
  | { readonly phase: 'cleanup'; readonly snapshot: NpmSnapshot }
  | { readonly phase: 'cleanup-issued'; readonly snapshot: NpmSnapshot }
  | { readonly phase: 'cleanup-confirm'; readonly previous: NpmSnapshot }
  | { readonly phase: 'cmd'; readonly previous: NpmSnapshot }
  | { readonly phase: 'stage-cmd'; readonly previous: NpmSnapshot; readonly directory: string; readonly script: string }
  | { readonly phase: 'cmd-ready'; readonly previous: NpmSnapshot; readonly installer: Installer }
  | { readonly phase: 'cmd-issued'; readonly previous: NpmSnapshot; readonly installer: Installer }
  | {
      readonly phase: 'cmd-confirm';
      readonly previous: NpmSnapshot;
      readonly receipt: Receipt;
      readonly stamp: string | null;
      readonly installer: Installer | null;
    }
  | { readonly phase: 'complete'; readonly binary: string; readonly stamp: string; readonly channel: 'npm' | 'native' }
  | { readonly phase: 'unconfirmed' };

/** 新装 Claude 的领域协议：npm → 验收 → 清残留 → 官方 CMD → 验收。
 * 依赖只提供观察；全部进度、命令收据与所有权都集中在本模块。
 */
export async function createClaudeInstallProtocol(
  ctx: Context,
  contract: ClaudeInstallContract,
  installation: ClaudeInstallation,
): Promise<Prepared> {
  const { version, registry } = contract;
  const native = userBinary(ctx, 'claude');
  let slot: NpmSlot;
  try {
    slot = { kind: 'available', scope: await freezeNpmScope(ctx) };
  } catch (error) {
    if (errorCode(error) !== 'npm-not-found') throw error;
    slot = { kind: 'unavailable' };
  }
  const npmRoot = slot.kind === 'available' ? slot.scope.npmRoot : undefined;
  const manifest = npmRoot === undefined ? undefined : path.join(npmRoot, PROGRAM_PACKAGES.claude, 'package.json');
  let checkpoint: Checkpoint = { phase: 'npm' };

  const verifyScope = async () => {
    if (slot.kind === 'available') return slot.scope.verify();
    // 准备时没有 npm 也是冻结的上下文，冷启动不能悄悄换用新出现的 manager。
    try {
      await npmGlobalRoot(ctx);
    } catch (error) {
      if (errorCode(error) === 'npm-not-found') return;
      throw error;
    }
    throw new Error('program-scope-unconfirmed');
  };
  const readSnapshot = async (): Promise<NpmSnapshot> => {
    if (manifest === undefined) return { kind: 'absent' };
    const stamp = await ctx.machine.treeStamp(manifest);
    if (stamp === null) return { kind: 'absent' };
    const binary = await npmBinary(ctx, 'claude', npmRoot);
    return { kind: 'package', manifest: stamp, binary, stamp: await ctx.machine.treeStamp(binary) };
  };
  const verifySnapshot = async (snapshot: NpmSnapshot) => {
    if (manifest === undefined) return;
    if ((await ctx.machine.treeStamp(manifest)) !== (snapshot.kind === 'absent' ? null : snapshot.manifest))
      throw new Error('program-changed');
    if (snapshot.kind === 'package' && (await ctx.machine.treeStamp(snapshot.binary)) !== snapshot.stamp)
      throw new Error('program-changed');
  };
  const verifyEmptySlot = async (previous: NpmSnapshot) => {
    await verifySnapshot({ kind: 'absent' });
    if (previous.kind === 'package' && (await ctx.machine.treeStamp(previous.binary)) !== null)
      throw new Error('program-changed');
  };
  const unconfirmed = (cause?: unknown): never => {
    checkpoint = { phase: 'unconfirmed' };
    throw new Error('program-installation-unconfirmed', { cause });
  };
  const captureSnapshot = async () => {
    try {
      return await readSnapshot();
    } catch (error) {
      return unconfirmed(error);
    }
  };
  const verifyEmptyMachine = async () => {
    const found = await installation.inspect();
    if (found.values.size) throw new Error('program-changed');
    if (found.problems.length) throw new Error('installation-state-unconfirmed');
  };
  const complete = async (
    program: Program,
    channel: 'npm' | 'native',
    binary: string,
    stamp: string | null,
    report: (effect: Effect) => void,
  ) => {
    // 版本探测也可能跨越外部修改；验收不能把探测后的新文件当成新的所有权锚点。
    if (
      program.channel !== channel ||
      !samePath(ctx, program.binary, binary) ||
      stamp === null ||
      (await ctx.machine.treeStamp(binary)) !== stamp
    )
      throw new Error('program-changed');
    await verifyScope();
    checkpoint = { phase: 'complete', binary, stamp, channel };
    report({ state: 'done', code: 'program-ready', detail: `${channel === 'npm' ? 'npm' : 'CMD'} · ${version}` });
  };
  const verifyComplete = async () => {
    if (checkpoint.phase !== 'complete') throw new Error('program-installation-unconfirmed');
    await verifyScope();
    if ((await ctx.machine.treeStamp(checkpoint.binary)) !== checkpoint.stamp) throw new Error('program-changed');
  };
  const cleanInstaller = async (installer: Installer) => {
    const stamp = await ctx.machine.treeStamp(installer.directory);
    if (stamp === null) return;
    if (stamp !== installer.stamp) throw new Error('installer-conflict');
    await ctx.effects.removeTree(installer.directory, installer.stamp);
  };

  const operation: Prepared = {
    get changes() {
      const confirming =
        checkpoint.phase === 'npm-issued' ||
        checkpoint.phase === 'npm-confirm' ||
        checkpoint.phase === 'cmd-issued' ||
        checkpoint.phase === 'cmd-confirm';
      const cmd = checkpoint.phase.startsWith('cmd') || checkpoint.phase === 'stage-cmd';
      return [
        {
          code: confirming
            ? 'program-installation-confirm'
            : ctx.platform === 'win32'
              ? 'program-install-cmd'
              : 'program-install',
          detail: `${cmd ? 'CMD' : 'npm'} · ${version}`,
        },
        { code: 'keep-user-data' },
      ];
    },
    async run(report, signal) {
      while (checkpoint.phase !== 'complete') {
        // initialize 派发后的第一次观察必须先锚定文件，不能被 scope 查询故障推迟到续办。
        if (checkpoint.phase !== 'stage-cmd') await verifyScope();
        switch (checkpoint.phase) {
          case 'npm': {
            cancelled(signal);
            await verifyEmptyMachine();
            checkpoint = { phase: 'npm-issued' };
            report({ state: 'kept', code: 'npm-install-started' });
            let receipt: Receipt = { kind: 'returned', failure: 'npm-install-failed' };
            if (slot.kind === 'available') {
              try {
                const result = await ctx.effects.npm(
                  npmInstallArgs(
                    [
                      'install',
                      '-g',
                      ...slot.scope.args,
                      ...npmScriptFlags('claude'),
                      `${PROGRAM_PACKAGES.claude}@${version}`,
                    ],
                    registry,
                  ),
                );
                receipt = commandReceipt(result, 'npm-install-failed');
              } catch (error) {
                if (errorCode(error) === 'npm-changed') throw error;
                receipt = { kind: 'unknown', failure: errorCode(error) };
              }
            }
            if (receipt.kind === 'returned' && receipt.failure === null)
              report({ state: 'done', code: 'package-command-completed' });
            const snapshot = await captureSnapshot();
            checkpoint = { phase: 'npm-confirm', receipt, snapshot };
            break;
          }
          case 'npm-confirm': {
            const { receipt, snapshot } = checkpoint;
            await verifySnapshot(snapshot);
            const installed = await installation.installed('npm');
            if (installed !== undefined) {
              await verifySnapshot(snapshot);
              if (snapshot.kind !== 'package') throw new Error('program-changed');
              await complete(installed, 'npm', snapshot.binary, snapshot.stamp, report);
              break;
            }
            cancelled(signal);
            // 未知结果没有失败凭证；验收不成立时不能清残留或改走另一个安装器。
            if (receipt.kind === 'unknown') unconfirmed();
            const failure = receipt.failure ?? 'program-not-ready';
            report({ state: 'kept', code: failure });
            if (ctx.platform !== 'win32') throw new Error(failure);
            checkpoint = { phase: 'cleanup', snapshot };
            break;
          }
          case 'cleanup': {
            cancelled(signal);
            const { snapshot } = checkpoint;
            await verifySnapshot(snapshot);
            const remainder = await npmVersion(ctx, PROGRAM_PACKAGES.claude, npmRoot);
            if (remainder === null) {
              checkpoint = { phase: 'cmd', previous: snapshot };
              break;
            }
            if (remainder !== version || slot.kind !== 'available') throw new Error('program-changed');
            checkpoint = { phase: 'cleanup-issued', snapshot };
            let receipt: Receipt;
            try {
              const result = await ctx.effects.npm(
                npmUninstallArgs(['uninstall', '-g', ...slot.scope.args, PROGRAM_PACKAGES.claude]),
              );
              receipt = commandReceipt(result, 'failed-install-cleanup-failed');
            } catch (error) {
              if (errorCode(error) === 'npm-changed') throw error;
              receipt = { kind: 'unknown', failure: errorCode(error) };
            }
            // 立即封存删除结果，后续 npm 查询故障不丢失已完成的删除，也不接管续办时的外部文件。
            const after = await captureSnapshot();
            if (after.kind === 'absent') {
              await verifyEmptySlot(snapshot);
              checkpoint = { phase: 'cleanup-confirm', previous: snapshot };
              break;
            }
            await verifySnapshot(snapshot);
            if (receipt.kind === 'unknown') unconfirmed();
            if (receipt.failure === null) throw new Error('program-changed');
            checkpoint = { phase: 'cleanup', snapshot };
            throw new Error(receipt.failure);
          }
          case 'cleanup-confirm': {
            const { previous } = checkpoint;
            await verifyEmptySlot(previous);
            if ((await npmVersion(ctx, PROGRAM_PACKAGES.claude, npmRoot)) !== null) throw new Error('program-changed');
            checkpoint = { phase: 'cmd', previous };
            report({ state: 'kept', code: 'failed-install-cleaned' });
            break;
          }
          case 'cmd': {
            cancelled(signal);
            const { previous } = checkpoint;
            await verifyEmptySlot(previous);
            await verifyEmptyMachine();
            report({ state: 'kept', code: 'cmd-install-started' });
            const script = await ctx.machine.fetchText('https://claude.ai/install.cmd');
            if (/^\s*</.test(script) || !script.trim()) throw new Error('installer-unavailable');
            const directory = installScratch(ctx, `claude-${randomUUID()}`);
            checkpoint = { phase: 'stage-cmd', previous, directory, script };
            let initialized: boolean;
            try {
              initialized = await ctx.effects.initialize(path.join(directory, 'install.cmd'), script);
            } catch (error) {
              if (errorCode(error) === 'installer-conflict') return unconfirmed(error);
              // initialize 的返回丢失由下一段核对预期内容，不重新分配目录或下载脚本。
              break;
            }
            // 已知冲突没有创建所有权，不能在续办时凭相同字节接管既有目录。
            if (!initialized) return unconfirmed(new Error('installer-conflict'));
            break;
          }
          case 'stage-cmd': {
            const { previous, directory, script } = checkpoint;
            try {
              const stamp = await ctx.machine.treeStamp(directory);
              if (stamp === null) return unconfirmed();
              const entries = await ctx.machine.entries(directory);
              if (
                entries.length !== 1 ||
                entries[0]?.name !== 'install.cmd' ||
                entries[0]?.kind !== 'file' ||
                (await ctx.machine.read(path.join(directory, 'install.cmd'))) !== script
              )
                unconfirmed();
              if ((await ctx.machine.treeStamp(directory)) !== stamp) return unconfirmed();
              checkpoint = { phase: 'cmd-ready', previous, installer: { directory, stamp } };
            } catch (error) {
              unconfirmed(error);
            }
            break;
          }
          case 'cmd-ready': {
            cancelled(signal);
            const { previous, installer } = checkpoint;
            await verifyEmptySlot(previous);
            await verifyEmptyMachine();
            if ((await ctx.machine.treeStamp(installer.directory)) !== installer.stamp)
              throw new Error('installer-conflict');
            checkpoint = { phase: 'cmd-issued', previous, installer };
            let receipt: Receipt;
            try {
              const result = await ctx.effects.execute(
                'cmd.exe',
                ['/d', '/v:off', '/s', '/c', '.\\install.cmd', version],
                {
                  env: claudeEnvironment(ctx),
                  cwd: installer.directory,
                },
              );
              receipt = commandReceipt(result, 'cmd-install-failed');
            } catch (error) {
              receipt = { kind: 'unknown', failure: errorCode(error) };
            }
            if (receipt.kind === 'returned' && receipt.failure === null)
              report({ state: 'done', code: 'package-command-completed' });
            const captured = await (async () => {
              try {
                // 先锚定安装结果；脚本清理失败不得掩盖首次安装快照未知。
                const stamp = await ctx.machine.treeStamp(native);
                return { stamp };
              } catch (error) {
                // 只清理派发前已拥有的目录，安装结果未知优先于脚本清理故障。
                try {
                  await cleanInstaller(installer);
                } catch {
                  /* 保留首次快照未知。 */
                }
                return unconfirmed(error);
              }
            })();
            checkpoint = {
              phase: 'cmd-confirm',
              previous,
              receipt,
              stamp: captured.stamp,
              installer,
            };
            break;
          }
          case 'cmd-confirm': {
            const current = checkpoint;
            await verifyEmptySlot(current.previous);
            if ((await ctx.machine.treeStamp(native)) !== current.stamp) throw new Error('program-changed');
            if (current.installer !== null) {
              await cleanInstaller(current.installer);
              checkpoint = { ...current, installer: null };
            }
            const installed = await installation.installed('native');
            if (installed === undefined) {
              if (current.receipt.kind === 'unknown') unconfirmed();
              throw new Error(current.receipt.failure ?? 'program-not-ready');
            }
            await complete(installed, 'native', native, current.stamp, report);
            break;
          }
          case 'npm-issued':
          case 'cleanup-issued':
          case 'cmd-issued':
          case 'unconfirmed':
            return unconfirmed();
          default:
            checkpoint satisfies never;
        }
      }
      await verifyComplete();
      cancelled(signal);
    },
    remaining: () => (checkpoint.phase === 'complete' ? undefined : operation),
    async verify() {
      if (
        checkpoint.phase === 'unconfirmed' ||
        checkpoint.phase === 'npm-issued' ||
        checkpoint.phase === 'cleanup-issued' ||
        checkpoint.phase === 'cmd-issued'
      )
        throw new Error('program-installation-unconfirmed');
      if (checkpoint.phase === 'complete') await verifyComplete();
    },
  };
  return operation;
}
