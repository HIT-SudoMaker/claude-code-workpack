import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import {
  knownTitle,
  catalogEntry,
  BUNDLED_SKILLS,
  SKILL_ENTRY,
  SKILL_MEMBERS,
  SKILL_SUITES,
  SKILLS_CLI,
} from './management-catalog.js';
import { isObject, isGitRevision, errorCode } from './machine.js';
import { json, object, kindOf, restOf, success, normalizePath, unchanged, commandReceipt } from './model.js';
import type { Context, Domain, Prepared, Selection, Item, Effect } from './model.js';
import { sourcesFile, disableSkillEntry, ownsSkill, checkSkillSource } from './skill-files.js';
import { step, work } from './work.js';
import { jsonFingerprint } from './frozen-json.js';

const ASSET_ROOT = fileURLToPath(new URL('../assets/', import.meta.url));
const MAX_SKILL_DIRECTORY_LENGTH = 255;

/**
 * 按固定来源管理技能及套件
 *
 * @remarks 官方 CLI 负责发现和安装，CCW 限定清理范围并记录归属
 * 检查错误归入对应条目，不中断其他技能
 */
export function createSkillsDomain(ctx: Context): Domain {
  return {
    async inspect() {
      let records: Record<string, unknown> = {};
      let problem: string | undefined;
      try {
        records = await metadata(ctx);
      } catch (error) {
        problem = errorCode(error);
      }
      const names = new Set([
        ...Object.keys(SKILL_MEMBERS),
        ...Object.keys(BUNDLED_SKILLS),
        ...Object.keys(records)
          .filter(
            directory =>
              path.dirname(directory) === path.join(ctx.claudeRoot, 'skills') && suiteFor(records[directory]),
          )
          .map(directory => path.basename(directory)),
      ]);
      const items: Item[] = [];
      for (const name of names) {
        validName(name);
        const directory = path.join(ctx.claudeRoot, 'skills', name);
        const record = records[directory];
        const suite = Object.entries(SKILL_SUITES).find(
          ([, value]) => isObject(record) && record.repository === value.repository,
        )?.[0];
        const item = {
          id: 'skill:' + name,
          title: knownTitle('skill:' + name, name),
          kind: 'skill' as const,
          location: directory,
          ...(suite ? { skillSet: suite } : {}),
          canInstall: Object.hasOwn(BUNDLED_SKILLS, name),
        };
        try {
          const stamp = await ctx.machine.treeStamp(directory);
          const present = stamp !== null && !!(await ctx.machine.read(path.join(directory, SKILL_ENTRY)))?.trim();
          const issue = problem ?? (stamp !== null && !present ? 'skill-entry-missing' : undefined);
          items.push({
            ...item,
            canUninstall: ownsSkill(record, repositoryFor(name, record), stamp),
            facts: [{ code: present ? 'entry-exists' : 'not-installed' }],
            ...(issue ? { problem: issue } : {}),
          });
        } catch (error) {
          items.push({ ...item, facts: [], problem: errorCode(error) });
        }
      }
      for (const [name, suite] of Object.entries(SKILL_SUITES)) {
        const members = items.filter(item => item.skillSet === name);
        const count = members.filter(item => item.facts.some(fact => fact.code === 'entry-exists')).length;
        const issue = problem ?? members.find(item => item.problem)?.problem;
        items.push({
          id: 'skill-set:' + name,
          title: suite.title,
          kind: 'skill',
          location: path.join(ctx.claudeRoot, 'skills'),
          canInstall: true,
          canUninstall: members.some(item => item.canUninstall),
          facts: count ? [{ code: 'skill-members-present', detail: String(count) }] : [{ code: 'not-installed' }],
          ...(issue ? { problem: issue } : {}),
        });
      }
      return { items, problems: [] };
    },
    prepare(selection) {
      const name = restOf(selection.id);
      if (!name) throw new Error('unknown-selection');
      const shouldDetach = selection.action === 'detach';
      return kindOf(selection.id) === 'skill-set'
        ? prepareSuite(ctx, name, shouldDetach)
        : prepareSkill(ctx, name, shouldDetach);
    },
  };
}

/**
 * 找出与同批套件计划覆盖目录重叠的单项技能
 *
 * @param prepared - 已准备计划的目录范围；尚未准备的条目按无目录处理
 * @returns 需要按重叠处理的单项技能 ID 集合，不修改选择或计划
 */
export function overlappingSkillSelections(
  ctx: Context,
  selections: readonly Selection[],
  prepared: ReadonlyMap<string, Prepared>,
) {
  const targets = (id: string) =>
    prepared.get(id)?.skillDirectories?.map(directory => normalizePath(ctx.platform, directory)) ?? [];
  const suiteTargets = new Set(
    selections.filter(selection => kindOf(selection.id) === 'skill-set').flatMap(selection => targets(selection.id)),
  );
  return new Set(
    selections
      .filter(
        selection => kindOf(selection.id) === 'skill' && targets(selection.id).some(target => suiteTargets.has(target)),
      )
      .map(selection => selection.id),
  );
}

async function prepareSkill(ctx: Context, name: string, shouldDetach: boolean): Promise<Prepared> {
  validName(name);
  const directory = path.join(ctx.claudeRoot, 'skills', name);
  const records = await metadata(ctx);
  const record = records[directory];
  const before = await ctx.machine.treeStamp(directory);
  if (shouldDetach) {
    if (before === null) throw new Error('no-connection');
    const repository = repositoryFor(name, record);
    if (!repository) throw new Error('integration-source-conflict');
    checkSkillSource(record, repository);
    if (!ownsSkill(record, repository, before)) throw new Error('local-edits-preserved');
    return disableSkillEntry(ctx, directory, before, record);
  }
  const bundled = catalogEntry(BUNDLED_SKILLS, name);
  if (bundled) {
    const source = path.dirname(path.join(ASSET_ROOT, bundled.asset));
    return refresh(ctx, { ...bundled, source, stamp: await ctx.machine.treeStamp(source) }, records, [name]);
  }
  const member = catalogEntry(SKILL_MEMBERS, name);
  const suite = member ? SKILL_SUITES[member.suite] : suiteFor(record);
  if (!suite) throw new Error('not-in-update-catalog');
  return refresh(ctx, await remoteSource(ctx, suite.repository, suite.folder + '/' + name), records, [name]);
}

async function prepareSuite(ctx: Context, name: string, shouldDetach: boolean): Promise<Prepared> {
  const suite = catalogEntry(SKILL_SUITES, name);
  if (!suite) throw new Error('unknown-selection');
  const records = await metadata(ctx);
  if (shouldDetach) {
    const children = [];
    for (const [directory, record] of Object.entries(records)) {
      if (
        path.dirname(directory) !== path.join(ctx.claudeRoot, 'skills') ||
        !isObject(record) ||
        record.repository !== suite.repository ||
        repositoryFor(path.basename(directory), record) !== suite.repository
      )
        continue;
      const stamp = await ctx.machine.treeStamp(directory);
      if (stamp !== record.stamp) throw new Error('local-edits-preserved');
      if (stamp !== null) children.push(disableSkillEntry(ctx, directory, stamp, record));
    }
    if (!children.length) throw new Error('no-connection');
    return work(children);
  }
  return refresh(ctx, await remoteSource(ctx, suite.repository, suite.folder), records);
}

interface SkillSource {
  readonly repository: string;
  readonly revision: string;
  readonly source: string;
  readonly stamp?: string | null;
}

async function refresh(
  ctx: Context,
  source: SkillSource,
  records: Record<string, unknown>,
  selected?: readonly string[],
): Promise<Prepared> {
  const root = path.join(ctx.claudeRoot, 'skills');
  const verifyRoots = async () => {
    for (const directory of [root, path.join(ctx.storage, 'skills'), path.join(ctx.storage, 'skills-cli')]) {
      let parent = directory;
      while (true) {
        const real = await ctx.machine.realpath(parent);
        if (real !== null) {
          if (normalizePath(ctx.platform, real) !== normalizePath(ctx.platform, parent))
            throw new Error('linked-parent');
          break;
        }
        const ancestor = path.dirname(parent);
        if (ancestor === parent) throw new Error('invalid-config-root');
        parent = ancestor;
      }
    }
  };
  await verifyRoots();
  const listing = success(
    await ctx.machine.npm([...SKILLS_CLI, 'a', source.source, '--list'], { env: cliEnvironment(ctx) }),
    'skill-source-unavailable',
  );
  const available = listedSkills(listing);
  const lockFiles = [
    path.join(ctx.home, '.agents/.skill-lock.json'),
    path.join(ctx.storage, 'skills/.skill-lock.json'),
  ];
  const locks = await Promise.all(
    lockFiles.map(async file => {
      const skills = object((await json(ctx.machine, file)).skills);
      return { file, skills };
    }),
  );
  const repositoryName = source.repository.replace('https://github.com/', '');
  const officialNames = new Set(
    locks.flatMap(lock =>
      Object.entries(lock.skills)
        .filter(([, record]) => isObject(record) && record.sourceType === 'github' && record.source === repositoryName)
        .map(([name]) => installedName(name)),
    ),
  );
  const entries = await ctx.machine.entries(root);
  const names = selected ? [...selected] : available;
  if (names.some(name => !available.includes(name))) throw new Error('skill-payload-missing');
  const oldNames = selected ?? [
    ...officialNames,
    ...Object.entries(records)
      .filter(
        ([directory, record]) =>
          path.dirname(directory) === root && isObject(record) && record.repository === source.repository,
      )
      .map(([directory]) => path.basename(directory)),
  ];
  const targets = await Promise.all(
    [...new Set([...names, ...oldNames])].map(async name => {
      validName(name);
      const directory = path.join(root, name);
      const record = records[directory];
      const before = await ctx.machine.treeStamp(directory);
      checkSkillSource(record, source.repository);
      if (
        before !== null &&
        !ownsSkill(record, source.repository, before) &&
        !(officialNames.has(name) && entries.find(entry => entry.name === name)?.kind === 'link') &&
        (await ctx.machine.entries(directory)).length
      )
        throw new Error('local-edits-preserved');
      return { name, directory, record, before };
    }),
  );
  const installed = new Map<string, string>();
  const removed = new Set<string>();
  const targetNames = new Set(targets.map(target => target.name));
  // 共享锁会被同批其他来源更新，只冻结当前来源及目标名称
  const lockScope = (skills: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(skills).filter(
        ([name, record]) =>
          targetNames.has(installedName(name)) ||
          (isObject(record) && record.sourceType === 'github' && record.source === repositoryName),
      ),
    );
  const verifyBefore = async () => {
    await verifyRoots();
    const current = await metadata(ctx);
    if (source.stamp !== undefined) unchanged(await ctx.machine.treeStamp(source.source), source.stamp);
    for (const lock of locks)
      unchanged(lockScope(object((await json(ctx.machine, lock.file)).skills)), lockScope(lock.skills));
    for (const target of targets) {
      unchanged(await ctx.machine.treeStamp(target.directory), target.before);
      unchanged(jsonFingerprint(current[target.directory]), jsonFingerprint(target.record));
    }
  };
  const operation = step(
    [{ code: 'skills-refresh', detail: `${names.length} · ${source.repository}` }],
    async fact => {
      if (!fact.dispatched) {
        await verifyBefore();
        return { state: 'ready' };
      }
      for (const target of targets) {
        const expected = installed.get(target.name) ?? null;
        if ((await ctx.machine.treeStamp(target.directory)) !== expected)
          return { state: 'blocked', problem: fact.receipt?.failure ?? 'skill-install-unconfirmed' };
      }
      if (names.some(name => !installed.has(name)))
        return { state: 'blocked', problem: fact.receipt?.failure ?? 'skill-install-unconfirmed' };
      if (fact.receipt?.failure) return { state: 'blocked', problem: fact.receipt.failure };
      return { state: 'complete' };
    },
    async (signal, verify) => {
      const effects: Effect[] = [];
      let receipt;
      try {
        await verifyBefore();
        const existing = targets.filter(target => target.before !== null);
        if (existing.length) {
          const privateHome = path.join(ctx.storage, 'skills-cli');
          try {
            success(
              await ctx.effects.npm(
                [
                  ...SKILLS_CLI,
                  'remove',
                  ...existing.map(target => target.name),
                  '--global',
                  '--agent',
                  'claude-code',
                  '--yes',
                ],
                {
                  env: { ...cliEnvironment(ctx), HOME: privateHome, USERPROFILE: privateHome },
                  ...(signal ? { signal } : {}),
                },
              ),
              'skill-remove-failed',
            );
          } finally {
            await verify(async () => {
              for (const target of existing)
                if ((await ctx.machine.treeStamp(target.directory)) === null) {
                  removed.add(target.name);
                  effects.push({ state: 'done', code: 'skill-removed', detail: target.name });
                }
            });
          }
        }
        for (const target of targets) {
          let current = await ctx.machine.treeStamp(target.directory);
          if (
            current !== null &&
            current === target.before &&
            (await ctx.machine.entries(target.directory)).length === 0
          ) {
            await ctx.effects.removeTree(target.directory, current);
            current = null;
          }
          if (current !== null) throw new Error('skill-remove-failed');
          if (target.before !== null && !removed.has(target.name))
            effects.push({ state: 'done', code: 'skill-removed', detail: target.name });
          removed.add(target.name);
        }
        const result = await ctx.effects.npm(
          [
            ...SKILLS_CLI,
            'a',
            source.source,
            '--skill',
            ...(selected ?? ['*']),
            '--agent',
            'claude-code',
            '--global',
            '--yes',
            '--copy',
            '--json',
          ],
          { env: cliEnvironment(ctx), ...(signal ? { signal } : {}) },
        );
        receipt = commandReceipt(result, 'skill-command-failed');
        const entries: unknown = JSON.parse(result.stdout);
        if (!Array.isArray(entries)) throw new Error('skill-cli-output-invalid');
        await verify(async () => {
          for (const entry of entries) {
            if (!isObject(entry) || entry.status !== 'installed') continue;
            const name = typeof entry.name === 'string' ? installedName(entry.name) : undefined;
            const target = targets.find(target => target.name === name && names.includes(target.name));
            if (
              !target ||
              entry.scope !== 'global' ||
              entry.mode !== 'copy' ||
              !Array.isArray(entry.agents) ||
              entry.agents.length !== 1 ||
              entry.agents[0] !== 'Claude Code' ||
              typeof entry.path !== 'string' ||
              normalizePath(ctx.platform, entry.path) !== normalizePath(ctx.platform, target.directory)
            )
              throw new Error('skill-cli-output-invalid');
            const text = await ctx.machine.read(path.join(target.directory, SKILL_ENTRY));
            const stamp = await ctx.machine.treeStamp(target.directory);
            if (!text?.trim() || stamp === null) throw new Error('skill-payload-missing');
            installed.set(target.name, stamp);
            effects.push({ state: 'done', code: 'skill-installed', detail: target.name });
          }
        });
      } catch (error) {
        receipt = { kind: 'unknown' as const, failure: errorCode(error) };
      }
      // 部分失败仍登记已核实结果，仅修改本次来源的记录
      if (removed.size) {
        try {
          await ctx.effects.editJson(sourcesFile(ctx), current => {
            for (const target of targets) {
              if (!removed.has(target.name)) continue;
              unchanged(jsonFingerprint(current[target.directory]), jsonFingerprint(target.record));
              const stamp = installed.get(target.name);
              if (stamp)
                current[target.directory] = { repository: source.repository, revision: source.revision, stamp };
              else delete current[target.directory];
            }
          });
        } catch {
          effects.push({ state: 'kept', code: 'source-metadata-unavailable' });
        }
      }
      return { receipt, effects };
    },
  );
  return {
    ...operation,
    action: targets.some(target => target.before !== null) ? 'update' : 'install',
    skillDirectories: targets.map(target => target.directory),
  };
}

function cliEnvironment(ctx: Context) {
  return { CLAUDE_CONFIG_DIR: ctx.claudeRoot, XDG_STATE_HOME: ctx.storage, NO_COLOR: '1', FORCE_COLOR: undefined };
}

function listedSkills(output: string) {
  const plain = stripVTControlCharacters(output);
  const listed = plain.split('Available Skills')[1];
  const end = 'Use --skill <name> to install specific skills';
  if (!listed?.includes(end)) throw new Error('skill-cli-output-invalid');
  const section = listed.split(end)[0]!;
  const names = [...section.matchAll(/^[│|] {4}(\S[^\r\n]*)/gm)].map(match => installedName(match[1]!));
  if (!names.length) throw new Error('skill-payload-missing');
  names.forEach(validName);
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new Error('skill-name-conflict');
  return names;
}

// CLI 显示名需按其规则转换为目录名
function installedName(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, MAX_SKILL_DIRECTORY_LENGTH) || 'unnamed-skill'
  );
}

async function remoteSource(ctx: Context, repository: string, folder: string): Promise<SkillSource> {
  const revision = success(await ctx.machine.execute('git', ['ls-remote', repository, 'HEAD'])).split(/\s+/)[0];
  if (!revision || !isGitRevision(revision)) throw new Error('source-unavailable');
  return { repository, revision, source: `${repository}/tree/${revision}/${folder}` };
}

async function metadata(ctx: Context) {
  try {
    return await json(ctx.machine, sourcesFile(ctx));
  } catch {
    throw new Error('source-metadata-unavailable');
  }
}

function repositoryFor(name: string, record: unknown) {
  const bundled = catalogEntry(BUNDLED_SKILLS, name);
  const member = catalogEntry(SKILL_MEMBERS, name);
  return bundled?.repository ?? (member ? SKILL_SUITES[member.suite].repository : suiteFor(record)?.repository);
}

function suiteFor(record: unknown) {
  return isObject(record)
    ? Object.values(SKILL_SUITES).find(suite => suite.repository === record.repository)
    : undefined;
}

function validName(name: string) {
  if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new Error('invalid-target');
}
