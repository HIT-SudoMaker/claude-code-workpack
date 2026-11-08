import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { treeFilesStamp } from './machine.js';
import type { TreeFile } from './machine.js';
import { cancelled, unchanged } from './model.js';
import type { Context, Effect, Prepared } from './model.js';

export function currentSkill(ctx: Context, name: string, directory: string, before: string): Prepared {
  return {
    changes: [{ code: 'skill-current', detail: name }],
    async run(report) {
      unchanged(await ctx.machine.treeStamp(directory), before);
      report({ state: 'kept', code: 'skill-current', detail: name });
    },
    async verify() {
      unchanged(await ctx.machine.treeStamp(directory), before);
    },
  };
}

interface SkillTarget {
  readonly name: string;
  readonly directory: string;
  readonly stamp: string | null;
  readonly sourceRecord: unknown;
}

interface SkillSource {
  readonly repository: string;
  readonly revision: string;
  readonly files: readonly TreeFile[];
  readonly stamp: string;
}

/** 校验技能入口并冻结载荷摘要 */
export function skillFilesStamp(files: readonly TreeFile[]): string {
  if (!files.some(file => file.path === 'SKILL.md' && file.data.length > 0)) throw new Error('skill-payload-missing');
  return treeFilesStamp(files);
}

export function repairSkillSource(ctx: Context, target: SkillTarget, source: SkillSource): Prepared {
  return {
    changes: [{ code: 'skill-source-repair', detail: target.name }],
    async run(report) {
      unchanged(await ctx.machine.treeStamp(target.directory), source.stamp);
      await saveSkillSource(ctx, report, target, source);
    },
  };
}

async function saveSkillSource(
  ctx: Context,
  report: (effect: Effect) => void,
  target: SkillTarget,
  source: SkillSource,
) {
  const file = path.join(ctx.storage, 'sources.json');
  try {
    await ctx.machine.editJson(file, values => {
      unchanged(values[target.directory], target.sourceRecord);
      values[target.directory] = { repository: source.repository, revision: source.revision, stamp: source.stamp };
    });
    report({ state: 'kept', code: 'skill-source-recorded' });
  } catch {
    report({ state: 'kept', code: 'source-metadata-unavailable' });
  }
}

export function prepareSkillFiles(ctx: Context, target: SkillTarget, source: SkillSource): Prepared {
  const { name, directory, stamp: before } = target;
  const destination = before === null ? undefined : path.join(ctx.storage, 'replaced', `${randomUUID()}-${name}`);
  let isDeployed = false;
  let isComplete = false;
  const verify = async () => unchanged(await ctx.machine.treeStamp(directory), source.stamp);
  const operation: Prepared = {
    get changes() {
      return isDeployed
        ? [{ code: 'skill-confirm', detail: name }]
        : [
            { code: 'skill-install', detail: `${name} · ${source.revision.slice(0, 12)}` },
            ...(destination ? [{ code: 'preserved-at', detail: destination }] : []),
          ];
    },
    async run(report, signal) {
      cancelled(signal);
      if (!isDeployed) {
        await ctx.machine.replaceTree(directory, source.files, before, destination);
        isDeployed = true;
        report({ state: 'done', code: 'skill-installed', detail: name });
      }
      await verify();
      await saveSkillSource(ctx, report, target, source);
      isComplete = true;
      report({ state: 'kept', code: 'skill-confirm', detail: name });
    },
    remaining: () => (isComplete ? undefined : operation),
    verify,
  };
  return operation;
}

export function disableSkillEntry(ctx: Context, directory: string, before: string): Prepared {
  const destination = path.join(ctx.storage, 'disabled', `${randomUUID()}-${path.basename(directory)}`);
  return {
    writes: [directory],
    changes: [
      { code: 'entry-disable', detail: directory },
      { code: 'preserved-at', detail: destination },
      { code: 'keep-link-target' },
    ],
    async run(report) {
      await ctx.machine.removeTree(directory, before, destination);
      report({ state: 'done', code: 'entry-disabled', detail: destination });
    },
  };
}
