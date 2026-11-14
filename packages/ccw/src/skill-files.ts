import { step, sequence } from './work.js';
import type { Check } from './work.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { treeFilesStamp, isObject } from './machine.js';
import type { TreeFile } from './machine.js';
import { SKILL_ENTRY } from './management-catalog.js';
import { json, unchanged } from './model.js';
import type { Context, Prepared } from './model.js';
import { jsonFingerprint } from './frozen-json.js';
const REVISION_DISPLAY_LENGTH = 12;
/** 准备时冻结的技能目录及来源记录，用于执行前比较 */
interface SkillTarget {
  readonly name: string;
  readonly directory: string;
  readonly stamp: string | null;
  readonly sourceRecord: unknown;
}
/** 待部署的固定来源版本与载荷，stamp 须对应 files 的完整树摘要 */
interface SkillSource {
  readonly repository: string;
  readonly revision: string;
  readonly files: readonly TreeFile[];
  readonly stamp: string;
}

/** 返回技能来源记录路径，不读取或创建文件 */
export const sourcesFile = (ctx: Context) => path.join(ctx.storage, 'sources.json');
const replacedDirectory = (ctx: Context) => path.join(ctx.storage, 'replaced');
const disabledDirectory = (ctx: Context) => path.join(ctx.storage, 'disabled');
/** 仅在仓库匹配且现存目录摘要等于记录摘要时确认受管归属 */
export function ownsSkill(record: unknown, repository: string | undefined, stamp: string | null) {
  return repository !== undefined && stamp !== null && skillSourceMatches(record, repository) && record.stamp === stamp;
}
/**
 * 校验已有来源记录与目标仓库一致，允许尚无记录
 *
 * @throws Error - 已有记录无法证明属于该仓库时抛出 integration-source-conflict
 */
export function checkSkillSource(record: unknown, repository: string) {
  if (record !== undefined && !skillSourceMatches(record, repository)) throw new Error('integration-source-conflict');
}

/**
 * 复核并保留已有技能目录
 *
 * @param before - 执行及最终核验时须匹配的目录摘要
 * @remarks 不写文件或查询更新，目录变化记为执行问题
 */
export function currentSkill(ctx: Context, name: string, directory: string, before: string): Prepared {
  const installed = step([{ code: 'skill-current', detail: name }], async () => {
    unchanged(await ctx.machine.treeStamp(directory), before);
    return {
      state: 'complete',
      effects: [{ state: 'kept', code: 'skill-current', detail: name }],
    };
  });
  return { ...installed, skillDirectories: [directory] };
}
/**
 * 准备替换技能树、保留旧目录并登记来源
 *
 * @param target - 已获替换许可的目录、原摘要和来源记录
 * @param source - 含非空根级 SKILL.md 的文件树，派发前须匹配摘要
 * @returns 延迟流程及覆盖目录，准备时只生成保留路径
 * @remarks 执行时复核目标、来源记录和保留副本；登记失败仅报告元数据问题
 * 取消不回滚目录或副本
 */
export function prepareSkillFiles(ctx: Context, target: SkillTarget, source: SkillSource): Prepared {
  const { name, directory, stamp: before } = target;
  const destination = before === null ? null : path.join(replacedDirectory(ctx), randomUUID() + '-' + name);
  const expectedStamp = source.stamp;
  const installed = step(
    [
      { code: 'skill-install', detail: name + ' · ' + source.revision.slice(0, REVISION_DISPLAY_LENGTH) },
      ...(destination ? [{ code: 'preserved-at', detail: destination }] : []),
    ],
    async fact => {
      const stamp = await ctx.machine.treeStamp(directory);
      if (!fact.dispatched) await unchangedSource(ctx, directory, target.sourceRecord);
      if (
        stamp === expectedStamp &&
        (before !== expectedStamp || (fact.receipt?.kind === 'returned' && !fact.receipt.failure))
      ) {
        if (destination !== null && (await ctx.machine.treeStamp(destination)) !== before)
          return { state: 'blocked', problem: 'target-changed' };
        return {
          state: 'complete',
          effects: [{ state: 'done', code: 'skill-installed', detail: name }],
        };
      }
      if (fact.confirmed || stamp !== before) return { state: 'blocked', problem: 'target-changed' };
      return { state: 'ready' };
    },
    async () => {
      const files = source.files;
      unchanged(skillFilesStamp(files), expectedStamp);
      await unchangedSource(ctx, directory, target.sourceRecord);
      await ctx.effects.replaceTree(directory, files, before, destination === null ? undefined : destination);
      return { receipt: { kind: 'returned', failure: null } };
    },
  );
  const recorded = recordSource(ctx, target, source);
  return { ...sequence([installed, recorded]), skillDirectories: [directory] };
}
/**
 * 为内容匹配的目录补记来源，不替换文件
 *
 * @remarks 执行时复核目录；记录漂移或读写失败仅报告 source-metadata-unavailable
 */
export function repairSkillSource(ctx: Context, target: SkillTarget, source: SkillSource): Prepared {
  const recorded = recordSource(ctx, target, source);
  return { ...recorded, skillDirectories: [target.directory] };
}
/**
 * 移出技能入口并删除匹配的来源记录
 *
 * @param before - 已确认受管归属的目录摘要
 * @param sourceRecord - 执行前须匹配的来源记录
 * @returns 原内容移至停用目录的延迟流程，不动链接目标或共享源
 * @remarks 核验入口及保留位置；元数据问题仅提示，取消不回滚
 */
export function disableSkillEntry(ctx: Context, directory: string, before: string, sourceRecord: unknown): Prepared {
  const destination = path.join(disabledDirectory(ctx), randomUUID() + '-' + path.basename(directory));
  const disabled = step(
    [
      { code: 'entry-disable', detail: directory },
      { code: 'preserved-at', detail: destination },
      { code: 'keep-link-target' },
    ],
    async fact => {
      const stamp = await ctx.machine.treeStamp(directory);
      const preserved = await ctx.machine.treeStamp(destination);
      if (!fact.dispatched) await unchangedSource(ctx, directory, sourceRecord);
      if (stamp === null && preserved === before)
        return {
          state: 'complete',
          effects: [{ state: 'done', code: 'entry-disabled', detail: destination }],
        };
      if (fact.confirmed || stamp !== before || preserved !== null)
        return { state: 'blocked', problem: 'target-changed' };
      return { state: 'ready' };
    },
    async () => {
      await unchangedSource(ctx, directory, sourceRecord);
      await ctx.effects.removeTree(directory, before, destination);
      return { receipt: { kind: 'returned', failure: null } };
    },
  );
  const removed = recordSource(ctx, { name: path.basename(directory), directory, stamp: before, sourceRecord });
  return {
    ...sequence([disabled, removed]),
    skillDirectories: [directory],
  };
}
/**
 * 校验技能入口存在并计算完整载荷的树摘要
 *
 * @throws Error - 缺少非空根级 SKILL.md 时抛出 skill-payload-missing，路径无效时沿用树摘要校验错误
 */
export function skillFilesStamp(files: readonly TreeFile[]): string {
  if (!files.some(file => file.path === SKILL_ENTRY && file.data.length > 0)) throw new Error('skill-payload-missing');
  return treeFilesStamp(files);
}
// 内容已独立核验；省略 source 时删除记录，元数据问题不撤销已部署或停用的内容
function recordSource(ctx: Context, target: SkillTarget, source?: SkillSource) {
  let metadataUnavailable = false;
  const recordTarget = {
    file: sourcesFile(ctx),
    directory: target.directory,
    before: jsonFingerprint(target.sourceRecord),
    source: source ? { repository: source.repository, revision: source.revision, stamp: source.stamp } : undefined,
  };
  const unavailableEffects = [{ state: 'kept', code: 'source-metadata-unavailable' }] as const;
  const unavailable = (): Check => {
    metadataUnavailable = true;
    return { state: 'complete', effects: unavailableEffects };
  };
  return step(
    source ? [{ code: 'skill-source-repair', detail: target.name }] : [],
    async () => {
      if (recordTarget.source)
        unchanged(await ctx.machine.treeStamp(recordTarget.directory), recordTarget.source.stamp);
      if (metadataUnavailable) return unavailable();
      let current;
      try {
        current = (await json(ctx.machine, recordTarget.file))[recordTarget.directory];
      } catch {
        return unavailable();
      }
      if (jsonFingerprint(current) === jsonFingerprint(recordTarget.source))
        return source
          ? { state: 'complete', effects: [{ state: 'kept', code: 'skill-source-recorded' }] }
          : { state: 'complete' };
      if (jsonFingerprint(current) !== recordTarget.before) return unavailable();
      return { state: 'ready' };
    },
    async () => {
      try {
        await ctx.effects.editJson(recordTarget.file, values => {
          unchanged(jsonFingerprint(values[recordTarget.directory]), recordTarget.before);
          if (source) values[recordTarget.directory] = recordTarget.source;
          else delete values[recordTarget.directory];
        });
      } catch {
        metadataUnavailable = true;
      }
      return {
        receipt: { kind: 'returned', failure: null },
        ...(metadataUnavailable && source ? { effects: unavailableEffects } : {}),
      };
    },
  );
}
async function unchangedSource(ctx: Context, directory: string, record: unknown) {
  unchanged(jsonFingerprint((await json(ctx.machine, sourcesFile(ctx)))[directory]), jsonFingerprint(record));
}

function skillSourceMatches(record: unknown, repository: string): record is Record<string, unknown> {
  return isObject(record) && record.repository === repository;
}
