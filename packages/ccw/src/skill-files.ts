import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { treeFilesStamp } from './machine.js';
import type { TreeFile } from './machine.js';
import { SKILL_ENTRY } from './management-catalog.js';
import { cancelled, json, unchanged } from './model.js';
import type { Context, Effect, Prepared } from './model.js';
import { disabledDirectory, replacedDirectory, sourcesFile } from './storage.js';

export function currentSkill(ctx: Context, name: string, directory: string, before: string): Prepared {
  const verify = async () => unchanged(await ctx.machine.treeStamp(directory), before);
  return {
    changes: [{ code: 'skill-current', detail: name }],
    async run(report) {
      await verify();
      report({ state: 'kept', code: 'skill-current', detail: name });
    },
    verify,
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
  if (!files.some(file => file.path === SKILL_ENTRY && file.data.length > 0)) throw new Error('skill-payload-missing');
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
  const file = sourcesFile(ctx);
  try {
    await ctx.effects.editJson(file, values => {
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
  const destination = before === null ? undefined : path.join(replacedDirectory(ctx), `${randomUUID()}-${name}`);
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
        await ctx.effects.replaceTree(directory, source.files, before, destination);
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
  const destination = path.join(disabledDirectory(ctx), `${randomUUID()}-${path.basename(directory)}`);
  const records = sourcesFile(ctx);
  return {
    writes: [directory, records],
    changes: [
      { code: 'entry-disable', detail: directory },
      { code: 'preserved-at', detail: destination },
      { code: 'keep-link-target' },
    ],
    async run(report) {
      await ctx.effects.removeTree(directory, before, destination);
      report({ state: 'done', code: 'entry-disabled', detail: destination });
      // 解除后清除该路径的过期来源记录（防误归属旧套件）；失败只降级提示
      let metadata: Record<string, unknown> | null;
      try {
        metadata = await json(ctx.machine, records);
      } catch {
        // 记录不可读时降级提示，不影响解除结果
        report({ state: 'kept', code: 'source-metadata-unavailable' });
        metadata = null;
      }
      if (metadata !== null && Object.hasOwn(metadata, directory))
        try {
          await ctx.effects.editJson(records, values => {
            delete values[directory];
          });
        } catch {
          report({ state: 'kept', code: 'source-metadata-unavailable' });
        }
    },
  };
}
