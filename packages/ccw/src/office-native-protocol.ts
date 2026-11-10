import path from 'node:path';

import { cancelled, unchanged } from './model.js';
import type { Change, Context, Prepared } from './model.js';

interface UpdateArtifact {
  readonly file: string;
  readonly stamp: string | null;
}

interface OfficeNativeContract {
  readonly binary: string;
  readonly before: string | null;
  readonly digest: string;
  readonly version: string;
  readonly deployment: { readonly kind: 'reuse' } | { readonly kind: 'replace'; readonly bytes: Uint8Array };
  readonly updates: readonly UpdateArtifact[];
  readonly change: Change;
}

type Attempt = 'pending' | 'issued' | 'returned';
type Checkpoint =
  | { readonly phase: 'cleanup'; readonly index: number; readonly attempt: Attempt }
  | { readonly phase: 'deploy'; readonly attempt: Attempt }
  | { readonly phase: 'confirm-program' }
  | { readonly phase: 'configure-path'; readonly attempt: Attempt }
  | { readonly phase: 'complete' };

/** 原生 OfficeCLI 的私有协议。尝试先于派发记录，进度只在现实确认后推进。
 * 原子文件操作按冻结内容比较后可重试；PATH Adapter 的配置操作是幂等的。
 * 相同字节的重装在返回丢失时无法由摘要证明已替换，故保留尝试并安全重试。
 */
export function createOfficeNativeProtocol(
  ctx: Context,
  contract: OfficeNativeContract,
  readVersion: () => Promise<string | null>,
): Prepared {
  const { binary, before, digest, version } = contract;
  const deployment =
    contract.deployment.kind === 'replace'
      ? { kind: 'replace' as const, bytes: Uint8Array.from(contract.deployment.bytes) }
      : contract.deployment;
  const updates = contract.updates.map(update => ({ ...update }));
  let checkpoint: Checkpoint = { phase: 'cleanup', index: 0, attempt: 'pending' };

  const verifyArtifacts = async () => {
    const cursor = checkpoint.phase === 'cleanup' ? checkpoint.index : updates.length;
    for (let index = 0; index < updates.length; index++) {
      const update = updates[index];
      if (!update) continue;
      const current = await ctx.machine.treeStamp(update.file);
      if (checkpoint.phase === 'cleanup' && index === cursor && checkpoint.attempt === 'issued') {
        if (current === null || current === update.stamp) continue;
      } else if (checkpoint.phase === 'cleanup' && index === cursor && checkpoint.attempt === 'returned') {
        if (current === null) continue;
      } else if (current === (index < cursor ? null : update.stamp)) continue;
      throw new Error('program-changed');
    }
  };

  const verifyBinary = async () => {
    const current = await ctx.machine.fingerprint(binary);
    if (checkpoint.phase === 'deploy' && checkpoint.attempt === 'issued') {
      if (current === before || current === digest) return current;
    } else {
      const expected =
        checkpoint.phase === 'cleanup' || (checkpoint.phase === 'deploy' && checkpoint.attempt === 'pending')
          ? before
          : digest;
      if (current === expected) return current;
    }
    throw new Error('program-changed');
  };

  const verifyComplete = async () => {
    if (checkpoint.phase !== 'complete') throw new Error('program-installation-unconfirmed');
    await verifyBinary();
    await verifyArtifacts();
  };

  const operation: Prepared = {
    get changes() {
      const cursor = checkpoint.phase === 'cleanup' ? checkpoint.index : updates.length;
      const programChange =
        checkpoint.phase === 'cleanup' || (checkpoint.phase === 'deploy' && checkpoint.attempt === 'pending')
          ? contract.change
          : { code: 'program-installation-confirm', detail: `OfficeCLI · native · ${version} · ${binary}` };
      return [
        programChange,
        ...updates
          .slice(cursor)
          .filter(update => update.stamp !== null)
          .map(update => ({
            code: 'program-copy-remove',
            detail: update.file,
          })),
        { code: 'program-user-path', detail: path.dirname(binary) },
        { code: 'keep-user-data' },
      ];
    },
    async run(report, signal) {
      while (checkpoint.phase !== 'complete') {
        cancelled(signal);
        const currentBinary = await verifyBinary();
        await verifyArtifacts();
        switch (checkpoint.phase) {
          case 'cleanup': {
            const { index, attempt } = checkpoint;
            const update = updates[index];
            if (!update) {
              checkpoint =
                deployment.kind === 'reuse' ? { phase: 'confirm-program' } : { phase: 'deploy', attempt: 'pending' };
              break;
            }
            const current = await ctx.machine.treeStamp(update.file);
            if (attempt !== 'pending' && current === null) {
              checkpoint = { phase: 'cleanup', index: index + 1, attempt: 'pending' };
              report({ state: 'done', code: 'program-copy-removed', detail: update.file });
              break;
            }
            if (attempt === 'returned') throw new Error('program-changed');
            unchanged(current, update.stamp);
            if (update.stamp === null) {
              checkpoint = { phase: 'cleanup', index: index + 1, attempt: 'pending' };
              break;
            }
            checkpoint = { phase: 'cleanup', index, attempt: 'issued' };
            await ctx.effects.removeTree(update.file, update.stamp);
            checkpoint = { phase: 'cleanup', index, attempt: 'returned' };
            break;
          }
          case 'deploy': {
            const { attempt } = checkpoint;
            if (attempt === 'returned' || (attempt === 'issued' && before !== digest && currentBinary === digest)) {
              checkpoint = { phase: 'confirm-program' };
              report({ state: 'done', code: 'program-file-ready', detail: binary });
              break;
            }
            if (deployment.kind !== 'replace') throw new Error('program-installation-unconfirmed');
            unchanged(currentBinary, before);
            checkpoint = { phase: 'deploy', attempt: 'issued' };
            await ctx.effects.replaceFile(binary, deployment.bytes, before, true);
            checkpoint = { phase: 'deploy', attempt: 'returned' };
            break;
          }
          case 'confirm-program': {
            if ((await readVersion()) !== version) throw new Error('program-not-ready');
            checkpoint = { phase: 'configure-path', attempt: 'pending' };
            if (deployment.kind === 'reuse') report({ state: 'kept', code: 'program-kept', detail: binary });
            report({ state: 'done', code: 'program-ready', detail: `native · ${version}` });
            break;
          }
          case 'configure-path': {
            if (checkpoint.attempt !== 'returned') {
              checkpoint = { phase: 'configure-path', attempt: 'issued' };
              await ctx.effects.ensureUserPath(path.dirname(binary));
              checkpoint = { phase: 'configure-path', attempt: 'returned' };
            }
            await verifyBinary();
            await verifyArtifacts();
            checkpoint = { phase: 'complete' };
            report({ state: 'done', code: 'program-user-path', detail: path.dirname(binary) });
            break;
          }
          default:
            checkpoint satisfies never;
        }
      }
      await verifyComplete();
      cancelled(signal);
    },
    remaining: () => (checkpoint.phase === 'complete' ? undefined : operation),
    verify: verifyComplete,
  };
  return operation;
}
