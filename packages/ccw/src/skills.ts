import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { knownTitle } from './titles.js';
import { bundledSkills, SKILL_ENTRY, skillMembers, skillSuites } from './management-catalog.js';
import { errorCode, isGitRevision, isObject } from './machine.js';
import { json, kindOf, REPLACE_CONSENT, restOf, sequence, success, unchanged } from './model.js';
import type { Context, Domain, Inspection, Item, Prepared, Selection } from './model.js';
import {
  currentSkill,
  disableSkillEntry,
  prepareSkillFiles,
  repairSkillSource,
  skillFilesStamp,
} from './skill-files.js';
import { sourcesFile } from './storage.js';

const ASSET_ROOT = fileURLToPath(new URL('../assets/', import.meta.url));

function memberSuite(name: string) {
  const member = Object.entries(skillMembers).find(([id]) => id === name)?.[1];
  return member === undefined ? undefined : skillSuites[member.suite];
}

function assertRelativeSkillPath(value: string): void {
  if (
    !value ||
    value.includes('\\') ||
    value.includes(':') ||
    path.isAbsolute(value) ||
    value.split('/').some(part => part === '.' || part === '..' || part === '')
  )
    throw new Error('invalid-target');
}

/** 固定 Git 来源与载荷 */
/** 套件载荷内技能入口的路径形状（入口名单一出处 SKILL_ENTRY） */
const suiteEntryPattern = new RegExp(`^(?:[\\w.-]+/)+${SKILL_ENTRY.replaceAll('.', '\\.')}$`);

async function gitSkillSource(ctx: Context, source: { repository: string; folder: string }) {
  assertRelativeSkillPath(source.folder);
  const revision = success(await ctx.machine.execute('git', ['ls-remote', source.repository, 'HEAD'])).split(/\s+/)[0];
  if (!revision || !isGitRevision(revision)) throw new Error('source-unavailable');
  const files = await ctx.machine.source(source.repository, revision, source.folder);
  return { repository: source.repository, revision, files };
}

/** 从来源记录反查套件：未登记成员（如 mattpocock 成员）凭 sources.json 获得更新来源 */
function suiteOfRecord(saved: unknown) {
  const repository = isObject(saved) ? saved.repository : undefined;
  return typeof repository === 'string'
    ? Object.values(skillSuites).find(source => source.repository === repository)
    : undefined;
}

async function memberSkillSource(ctx: Context, name: string, saved?: unknown) {
  const bundled = Object.entries(bundledSkills).find(([id]) => id === name)?.[1];
  if (bundled !== undefined) {
    assertRelativeSkillPath(bundled.asset);
    const text = await ctx.machine.read(path.join(ASSET_ROOT, bundled.asset));
    if (!text?.trim()) throw new Error('skill-payload-missing');
    return {
      repository: bundled.repository,
      revision: bundled.revision,
      files: [{ path: SKILL_ENTRY, data: Buffer.from(text) }],
    };
  }
  const source = memberSuite(name) ?? (name.includes('/') ? undefined : suiteOfRecord(saved));
  if (source === undefined) throw new Error('not-in-update-catalog');
  return gitSkillSource(ctx, { repository: source.repository, folder: `${source.folder}/${name}` });
}

/** 读取来源记录：损坏或不可读时保持未知，不以查无代替 */
async function readSkillMetadata(ctx: Context): Promise<Record<string, unknown>> {
  try {
    return await json(ctx.machine, sourcesFile(ctx));
  } catch (error) {
    throw new Error('source-metadata-unavailable', { cause: error });
  }
}

/** 创建技能域渠道：余段即名字，组别由 kind 决定 */
export function createSkillsDomain(ctx: Context): Domain {
  return {
    inspect: () => inspectSkills(ctx),
    prepare(selection) {
      const name = restOf(selection.id);
      if (name === undefined) throw new Error('unknown-selection');
      const kind = kindOf(selection.id);
      if (kind === 'skill-set') return prepareSkillSet(ctx, name, selection);
      if (kind === 'skill' || kind === 'command')
        return prepareSkill(ctx, name, kind === 'skill' ? 'skills' : 'commands', selection);
      throw new Error('unknown-selection');
    },
  };
}

async function inspectSkills(ctx: Context): Promise<Inspection> {
  const result: Item[] = [];
  let metadata: Record<string, unknown> = {};
  let metadataReadable = true;
  const problems: Inspection['problems'][number][] = [];
  try {
    metadata = await json(ctx.machine, sourcesFile(ctx));
  } catch {
    metadataReadable = false;
    problems.push({ code: 'source-metadata-unavailable', detail: sourcesFile(ctx) });
  }
  for (const group of ['skills', 'commands'] as const) {
    const root = path.join(ctx.claudeRoot, group);
    const collect = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await ctx.machine.entries(directory);
      } catch (error) {
        problems.push({ code: errorCode(error), detail: directory });
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const location = path.join(directory, entry.name);
        if (group === 'commands' && entry.kind === 'directory') {
          await collect(location);
          continue;
        }
        if (group === 'commands' && entry.kind !== 'link' && (entry.kind !== 'file' || !entry.name.endsWith('.md')))
          continue;
        if (group === 'skills' && entry.kind !== 'directory' && entry.kind !== 'link') continue;
        let problem: string | undefined;
        if (group === 'skills') {
          try {
            const text = await ctx.machine.read(path.join(location, SKILL_ENTRY));
            if (text === null && entry.kind === 'directory') continue;
            if (!text?.trim()) problem = 'skill-entry-invalid';
          } catch (error) {
            problem = errorCode(error);
          }
        }
        const name = path.relative(root, location).split(path.sep).join('/');
        const saved = metadata[location];
        const skillSet =
          group === 'skills'
            ? Object.entries(skillSuites).find(
                ([, source]) =>
                  source.repository === (isObject(saved) ? saved.repository : memberSuite(name)?.repository),
              )?.[0]
            : undefined;
        // 更新资格取并集：登记成员、捆绑技能，以及凭来源记录归属到套件的已装成员
        const isOffered =
          group === 'skills' &&
          (Object.hasOwn(skillMembers, name) || Object.hasOwn(bundledSkills, name) || skillSet !== undefined);
        // 已发现条目标题用内联键真身（目录名/相对名），与磁盘及 Claude 所见一致；官方名只归方案入口
        result.push({
          id: `${group === 'skills' ? 'skill' : 'command'}:${name}`,
          title: name,
          kind: group === 'skills' ? 'skill' : 'command',
          location,
          ...(Object.hasOwn(bundledSkills, name) ? { canInstall: true } : {}),
          ...(skillSet ? { skillSet } : {}),
          facts: [{ code: entry.kind === 'link' ? 'shared-link' : 'entry-exists' }],
          ...(problem ? { problem } : {}),
          actions: isOffered ? ['update', 'detach'] : ['detach'],
        });
      }
    };
    await collect(root);
  }
  for (const name of Object.keys(bundledSkills)) {
    if (result.some(item => item.id === `skill:${name}`)) continue;
    result.push({
      id: `skill:${name}`,
      title: knownTitle(`skill:${name}`, name),
      kind: 'skill',
      canInstall: true,
      facts: [{ code: 'not-installed' }],
      actions: ['install'],
    });
  }
  // 方案入口只有整套套件；状态从已发现的成员聚合推导（本地事实），不虚构未安装的成员占位
  for (const id of Object.keys(skillSuites)) {
    const members = result.filter(item => item.kind === 'skill' && item.skillSet === id).length;
    const registered = Object.values(skillMembers).filter(member => member.suite === id).length;
    result.push({
      id: `skill-set:${id}`,
      title: knownTitle(`skill-set:${id}`),
      kind: 'skill',
      canInstall: true,
      facts: [
        ...(members > 0
          ? [{ code: 'skill-members-present', detail: registered > 0 ? `${members}/${registered}` : `${members}` }]
          : metadataReadable
            ? [{ code: 'not-installed' }]
            : []),
      ],
      actions: ['install'],
    });
  }
  return { items: result, problems };
}

/** 安装整套技能，只补齐缺失成员，保留已有内容 */
async function prepareSkillSet(ctx: Context, name: string, selection: Selection): Promise<Prepared> {
  const source = Object.entries(skillSuites).find(([id]) => id === name)?.[1];
  if (!source || selection.action !== 'install') throw new Error('action-unavailable');
  const { revision, files } = await gitSkillSource(ctx, source);
  const candidates = files
    .filter(file => suiteEntryPattern.test(file.path) && file.data.length > 0)
    .map(file => path.posix.dirname(file.path))
    .filter(folder => folder.split('/').every(part => part !== '.' && part !== '..'))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  const folders: string[] = [];
  for (const folder of candidates) {
    // 技能内部的示例 SKILL.md 属于原技能资源，不是另一个安装项
    if (!folders.some(parent => folder.startsWith(`${parent}/`))) folders.push(folder);
  }
  if (!folders.length) throw new Error('skill-payload-missing');
  const names = folders.map(folder => path.posix.basename(folder).toLowerCase());
  if (new Set(names).size !== names.length) throw new Error('skill-name-conflict');
  const operations: Prepared[] = [];
  const metadata = await readSkillMetadata(ctx);
  for (const folder of folders) {
    const member = path.posix.basename(folder);
    const directory = path.join(ctx.claudeRoot, 'skills', member);
    const before = await ctx.machine.treeStamp(directory);
    const entry = before === null ? null : await ctx.machine.read(path.join(directory, SKILL_ENTRY));
    const isEmptyDirectory = before !== null && entry === null && (await ctx.machine.entries(directory)).length === 0;
    if (before !== null && !isEmptyDirectory) {
      if (entry === null || !entry.trim()) throw new Error('local-edits-preserved');
      operations.push({
        changes: [{ code: 'skill-existing-kept', detail: member }],
        async verify() {
          unchanged(await ctx.machine.treeStamp(directory), before);
        },
        async run(report) {
          unchanged(await ctx.machine.treeStamp(directory), before);
          report({ state: 'kept', code: 'skill-existing-kept', detail: member });
        },
      });
      continue;
    }
    const payload = files
      .filter(file => file.path.startsWith(`${folder}/`))
      .map(file => ({ ...file, path: file.path.slice(folder.length + 1) }));
    operations.push(
      prepareSkillFiles(
        ctx,
        { name: member, directory, stamp: before, sourceRecord: metadata[directory] },
        { repository: source.repository, revision, files: payload, stamp: skillFilesStamp(payload) },
      ),
    );
  }
  return sequence(operations);
}

export async function prepareSkill(
  ctx: Context,
  name: string,
  group: 'skills' | 'commands',
  selection: Selection,
): Promise<Prepared> {
  assertRelativeSkillPath(name);
  if (group === 'skills' && name.includes('/')) throw new Error('invalid-target');
  const directory = path.join(ctx.claudeRoot, group, name);
  const before = await ctx.machine.treeStamp(directory);
  const action = selection.action;
  if (!['install', 'update', 'detach'].includes(action)) throw new Error('action-unavailable');
  if (action === 'detach') {
    if (before === null) throw new Error('no-connection');
    return disableSkillEntry(ctx, directory, before);
  }

  if (
    action === 'install' &&
    before !== null &&
    selection.fields?.replace !== REPLACE_CONSENT &&
    (await ctx.machine.read(path.join(directory, SKILL_ENTRY)))?.trim()
  )
    return currentSkill(ctx, name, directory, before);
  const metadata = await readSkillMetadata(ctx);
  const saved = metadata[directory];
  if (
    !Object.hasOwn(skillMembers, name) &&
    !(group === 'skills' && Object.hasOwn(bundledSkills, name)) &&
    !(group === 'skills' && suiteOfRecord(saved) !== undefined)
  )
    throw new Error('not-in-update-catalog');
  const { repository, revision, files } = await memberSkillSource(ctx, name, saved);
  const expected = skillFilesStamp(files);
  const target = { name, directory, stamp: before, sourceRecord: saved };
  const release = { repository, revision, files, stamp: expected };
  if (
    before !== null &&
    (!isObject(saved) || saved.stamp !== before) &&
    selection.fields?.replace !== REPLACE_CONSENT
  ) {
    if (before === expected) return repairSkillSource(ctx, target, release);
    throw new Error('local-edits-preserved');
  }
  if (
    before !== null &&
    isObject(saved) &&
    saved.stamp === before &&
    saved.revision === revision &&
    before === expected
  )
    return currentSkill(ctx, name, directory, before);
  if (before === expected) return repairSkillSource(ctx, target, release);
  return prepareSkillFiles(ctx, target, release);
}
