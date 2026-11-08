import path from 'node:path';

import { knownTitle } from './titles.js';
import { officeIntegration } from './management-catalog.js';
import { currentSkill, prepareSkillFiles, skillFilesStamp } from './skill-files.js';
import { prepareSkill } from './skills.js';
import { prepareMcp } from './mcp.js';
import { errorCode, isObject } from './machine.js';
import { cancelled, json, object, sequence, unchanged } from './model.js';
import type { Action, Change, Context, Inspection, Item, Prepared, Selection } from './model.js';
import { resolveNpmView } from './npm-registry.js';
import type { NpmRegistry } from './npm-registry.js';
import { officeBinary, samePath } from './program-channels.js';
import { officeVersion, prepareProgram, programs } from './programs.js';

interface OfficeEntry {
  readonly id: 'skill:officecli' | 'mcp:officecli';
  readonly owner: string | null | undefined;
}

const OFFICECLI_SKILL = 'officecli';
/** 区分技能入口证据：来源记录确认，或仅 frontmatter 形态相似；形态不构成认领证据 */
type SkillEvidence = 'confirmed' | 'shape' | 'none';

interface Observation {
  readonly found: Awaited<ReturnType<typeof programs>>;
  readonly entries: readonly OfficeEntry[];
  readonly problems: readonly Change[];
  readonly skillEvidence: SkillEvidence;
  readonly skillStamp: string | null;
  readonly sourceRecord: unknown;
  /** 匹配注册形状的命令；registration 存在但不匹配时为 undefined */
  readonly mcpCommand: string | undefined;
  readonly registration: unknown;
  readonly isConnectionsUnknown: boolean;
}

/** 管理 OfficeCLI 程序与所选 Claude 入口，计划及剩余工作由 CCW 消费 */
export function createOfficecli(ctx: Context) {
  const directory = path.join(ctx.claudeRoot, 'skills', OFFICECLI_SKILL);

  async function commandOwner(command: string, found: Observation['found']): Promise<string | undefined> {
    const candidates = path.isAbsolute(command)
      ? [command]
      : command === 'officecli' || command === 'officecli.exe'
        ? await ctx.machine.locate('officecli')
        : [];
    const candidate = candidates[0];
    if (candidate === undefined) return undefined;
    for (const [id, program] of found.values) if (samePath(ctx, candidate, program.binary)) return id;
    const canonical = await ctx.machine.realpath(candidate);
    if (canonical === null) return undefined;
    for (const [id, program] of found.values) {
      if (samePath(ctx, candidate, program.binary) || samePath(ctx, canonical, program.binary)) return id;
      if (program.channel !== 'npm') continue;
      const packageRoot = path.dirname(path.dirname(program.binary));
      const normalized = ctx.platform === 'win32' ? canonical.toLowerCase() : canonical;
      const prefix = ctx.platform === 'win32' ? packageRoot.toLowerCase() : packageRoot;
      if (normalized.startsWith(`${prefix}${path.sep}`)) return id;
      if (
        program.binary.startsWith(
          path.join(path.dirname(candidate), 'node_modules', '@officecli', 'officecli') + path.sep,
        )
      )
        return id;
    }
    return undefined;
  }

  async function observe(found?: Observation['found']): Promise<Observation> {
    found ??= await programs(ctx, 'officecli');
    const problems: Change[] = found.problems.map(code => ({ code, detail: 'officecli' }));
    let isConnectionsUnknown = false;
    let skillEvidence: SkillEvidence = 'none';
    let skillStamp: string | null = null;
    let mcpCommand: string | undefined;
    let registration: unknown;
    let metadata: Record<string, unknown> = {};
    try {
      metadata = await json(ctx.machine, path.join(ctx.storage, 'sources.json'));
    } catch {
      problems.push({ code: 'source-metadata-unavailable', detail: 'officecli' });
    }
    try {
      skillStamp = await ctx.machine.treeStamp(directory);
      const text = skillStamp !== null ? await ctx.machine.read(path.join(directory, 'SKILL.md')) : null;
      skillEvidence = officeSkillEvidence(text, metadata[directory], skillStamp);
    } catch (error) {
      isConnectionsUnknown = true;
      problems.push({ code: errorCode(error), detail: directory });
    }
    try {
      registration = object((await json(ctx.machine, ctx.stateFile)).mcpServers).officecli;
      mcpCommand = officeMcpCommand(registration);
    } catch (error) {
      isConnectionsUnknown = true;
      problems.push({ code: errorCode(error), detail: ctx.stateFile });
    }
    const entries: OfficeEntry[] = [];
    // 无程序时只认领有来源记录的残留技能入口；仅凭 frontmatter 同名不认领用户自建内容
    if (skillEvidence !== 'none' && (found.values.size > 0 || skillEvidence === 'confirmed'))
      entries.push({
        id: 'skill:officecli',
        owner: found.values.size === 0 ? null : await commandOwner('officecli', found),
      });
    if (mcpCommand !== undefined)
      entries.push({
        id: 'mcp:officecli',
        owner: found.values.size === 0 ? null : await commandOwner(mcpCommand, found),
      });
    return {
      found,
      entries,
      problems,
      skillEvidence,
      skillStamp,
      sourceRecord: metadata[directory],
      mcpCommand,
      registration,
      isConnectionsUnknown,
    };
  }

  function related(observed: Observation, id: string | null) {
    return observed.entries.filter(entry => entry.owner === id);
  }

  async function detach(entries: readonly OfficeEntry[], action: Action): Promise<Prepared> {
    if (entries.length === 0) throw new Error('no-connection');
    const operations: Prepared[] = [];
    for (const entry of entries) {
      const operation =
        entry.id === 'skill:officecli'
          ? await prepareSkill(ctx, 'officecli', 'skills', { id: entry.id, action: 'detach' })
          : await prepareMcp(ctx, 'officecli', { id: entry.id, action: 'detach' });
      let isComplete = false;
      const verify = async () => {
        if (!isComplete || action === 'reinstall') return;
        if (entry.id === 'skill:officecli') unchanged(await ctx.machine.treeStamp(directory), null);
        else unchanged(object((await json(ctx.machine, ctx.stateFile)).mcpServers).officecli, undefined);
      };
      const step: Prepared = {
        ...(operation.writes ? { writes: operation.writes } : {}),
        changes: operation.changes,
        async run(report, signal) {
          cancelled(signal);
          if (isComplete) {
            await verify();
            return;
          }
          await operation.run(report, signal);
          isComplete = true;
        },
        remaining: () => (isComplete ? undefined : step),
        verify,
      };
      operations.push(step);
    }
    return sequence(operations);
  }

  return {
    async inspect(): Promise<Inspection> {
      const observed = await observe();
      const items: Item[] = observed.found.items.map(item => {
        const entries = related(observed, item.id);
        const program = observed.found.values.get(item.id);
        const problem = observed.isConnectionsUnknown ? 'installation-state-unconfirmed' : undefined;
        return {
          ...item,
          facts: [
            ...item.facts,
            ...(program?.channel === 'native' || program?.channel === 'manual'
              ? [{ code: 'program-identity-unchecked' }]
              : []),
            ...connectionFacts(entries),
          ],
          actions: [...item.actions, ...(entries.length ? ['detach' as const] : [])],
          ...(problem ? { problem } : {}),
        };
      });
      if (items.length === 0) {
        const entries = related(observed, null);
        items.push({
          id: 'officecli',
          title: knownTitle('officecli'),
          kind: 'officecli',
          canInstall: true,
          facts: [
            { code: observed.found.problems.length ? 'inspection-incomplete' : 'not-installed' },
            ...connectionFacts(entries),
          ],
          actions: ['install', ...(entries.length ? ['detach' as const] : [])],
          ...(observed.isConnectionsUnknown ? { problem: 'installation-state-unconfirmed' } : {}),
        });
      }
      return {
        items,
        problems: observed.problems,
        grouped: observed.isConnectionsUnknown
          ? []
          : observed.entries.filter(entry => entry.owner !== undefined).map(entry => entry.id),
      };
    },
    async prepare(selection: Selection): Promise<Prepared> {
      const observed = await observe();
      const program =
        observed.found.values.get(selection.id) ??
        (selection.id === 'officecli' && observed.found.values.size === 1
          ? [...observed.found.values.values()][0]
          : undefined);
      const identity = program ? [...observed.found.values].find(([, value]) => value === program)?.[0] : null;
      if (selection.id !== 'officecli' && program === undefined) throw new Error('program-changed');
      if (selection.id === 'officecli' && observed.found.values.size > 1) throw new Error('program-selection-required');
      if (
        observed.isConnectionsUnknown ||
        (selection.action !== 'detach' && observed.found.problems.length > 0 && (!program || program.channel === 'npm'))
      )
        throw new Error('installation-state-unconfirmed');
      const entries = related(observed, identity ?? null);
      if (selection.action === 'detach') return detach(entries, selection.action);
      if (selection.action === 'uninstall') {
        if (!program)
          return sequence([
            await detach(entries, selection.action),
            {
              changes: [{ code: 'program-not-installed' }],
              run(report) {
                report({ state: 'kept', code: 'program-not-installed' });
                return Promise.resolve();
              },
            },
          ]);
        const removal = await prepareProgram(ctx, 'officecli', selection, program);
        const belongs = (value: Observation, entry: OfficeEntry) =>
          entry.owner === identity ||
          (entry.owner === null && value.found.values.size === 0) ||
          (entry.id === 'mcp:officecli' &&
            isObject(value.registration) &&
            typeof value.registration.command === 'string' &&
            path.isAbsolute(value.registration.command) &&
            samePath(ctx, value.registration.command, program.binary));
        const scope = (value: Observation) => value.entries.filter(entry => belongs(value, entry));
        const expected = scope(observed);
        const unmatched = [
          ...(observed.skillStamp !== null &&
          (observed.skillEvidence === 'none' ||
            observed.entries.some(entry => entry.id === 'skill:officecli' && entry.owner === undefined))
            ? [directory]
            : []),
          ...(observed.registration !== undefined &&
          (observed.mcpCommand === undefined ||
            observed.entries.some(entry => entry.id === 'mcp:officecli' && entry.owner === undefined))
            ? ['officecli']
            : []),
        ];
        const preserved: Prepared = {
          changes: unmatched.map(detail => ({ code: 'unmatched-integration-kept', detail })),
          run(report) {
            for (const detail of unmatched) report({ state: 'kept', code: 'unmatched-integration-kept', detail });
            return Promise.resolve();
          },
        };
        const guard = (hasDetached: boolean): Prepared => {
          const verify = async () => {
            const current = await observe(observed.found);
            if (current.isConnectionsUnknown) throw new Error('installation-state-unconfirmed');
            const actual = scope(current);
            unchanged(
              actual.map(entry => entry.id),
              hasDetached ? [] : expected.map(entry => entry.id),
            );
            if (!hasDetached)
              for (const entry of expected)
                unchanged(
                  entry.id === 'skill:officecli' ? current.skillStamp : current.registration,
                  entry.id === 'skill:officecli' ? observed.skillStamp : observed.registration,
                );
          };
          return { changes: [], run: verify, ...(hasDetached ? { verify } : {}) };
        };
        return sequence([
          guard(false),
          ...(expected.length ? [await detach(expected, selection.action)] : []),
          guard(true),
          removal,
          preserved,
        ]);
      }
      if (!['install', 'connect', 'update', 'reinstall'].includes(selection.action))
        throw new Error('action-unavailable');
      const integration = selection.fields?.connection;
      if (observed.skillStamp !== null && observed.skillEvidence === 'none' && integration !== 'mcp')
        throw new Error('integration-source-conflict');
      if (
        observed.registration !== undefined &&
        observed.mcpCommand === undefined &&
        (integration === 'mcp' || integration === 'both')
      )
        throw new Error('integration-source-conflict');
      const stamp = program ? await ctx.machine.treeStamp(program.binary) : null;
      const shouldKeepProgram =
        program && !program.isMissing && (selection.action === 'install' || selection.action === 'connect');
      // 两次读取之间二进制消失时不允许"保留程序"空转通过
      if (shouldKeepProgram && stamp === null) throw new Error('program-changed');
      const version = shouldKeepProgram ? (program.version ?? (await officeVersion(ctx, program.binary))) : null;
      if (shouldKeepProgram && version === null) throw new Error('program-identity-unconfirmed');
      if (shouldKeepProgram) unchanged(await ctx.machine.treeStamp(program.binary), stamp);
      const operation = shouldKeepProgram
        ? {
            targetVersion: version,
            targetBinary: program.binary,
            ...(program.channel === 'npm' ? { targetRegistry: null } : {}),
            changes: [{ code: 'program-kept' }],
            async run(report: Parameters<Prepared['run']>[0]) {
              unchanged(await ctx.machine.treeStamp(program.binary), stamp);
              if (program.channel === 'native') await ctx.machine.ensureUserPath(path.dirname(program.binary));
              report({ state: 'kept' as const, code: 'program-kept' });
            },
            async verify() {
              unchanged(await ctx.machine.treeStamp(program.binary), stamp);
            },
          }
        : await prepareProgram(ctx, 'officecli', selection, program);
      const binary = operation.targetBinary ?? program?.binary ?? officeBinary(ctx);
      const connection = await prepareOfficeConnection(ctx, selection, observed, {
        version: operation.targetVersion,
        binary,
        source: program?.channel === 'npm' ? 'npm' : 'native',
        ...(operation.targetRegistry !== undefined ? { registry: operation.targetRegistry } : {}),
      });
      const before =
        selection.action === 'reinstall' && entries.length ? await detach(entries, selection.action) : undefined;
      return sequence([...(before ? [before] : []), operation, connection]);
    },
  };
}

function connectionFacts(entries: readonly OfficeEntry[]): Change[] {
  return [
    { code: entries.length ? 'connected' : 'not-connected' },
    ...entries.map(entry => ({
      code: entry.id === 'skill:officecli' ? 'office-skill-connected' : 'office-mcp-connected',
    })),
  ];
}

function officeSkillEvidence(text: string | null, source: unknown, stamp: string | null): SkillEvidence {
  if (stamp === null || !text?.trim()) return 'none';
  if (isObject(source) && source.repository === officeIntegration.skill.repository && source.stamp === stamp)
    return 'confirmed';
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  return frontmatter !== undefined && /(?:^|\n)\s*name:\s*["']?officecli["']?\s*(?:\r?\n|$)/i.test(frontmatter)
    ? 'shape'
    : 'none';
}

/** 生成 officecli 的 MCP 注册形状：识别与注册同源 */
function officeMcpRegistration(command: string): { command: string; args: string[]; env: Record<string, string> } {
  return { command, args: [...officeIntegration.mcp.args], env: { ...officeIntegration.mcp.env } };
}

function officeMcpCommand(value: unknown): string | undefined {
  if (!isObject(value) || typeof value.command !== 'string') return undefined;
  const shape = officeMcpRegistration(value.command);
  if (
    !Array.isArray(value.args) ||
    value.args.length !== shape.args.length ||
    value.args.some((arg, index) => arg !== shape.args[index])
  )
    return undefined;
  const command = value.command;
  return /^(?:officecli|officecli\.exe)$/i.test(command) ||
    (path.isAbsolute(command) && /(?:^|[\\/])officecli(?:\.exe)?$/i.test(command))
    ? command
    : undefined;
}

interface OfficeTarget {
  readonly version: string | null;
  readonly binary: string;
  readonly source: 'npm' | 'native';
  readonly registry?: NpmRegistry;
}

async function officeRevision(ctx: Context, target: OfficeTarget): Promise<string> {
  const version = target.version;
  if (version === null) throw new Error('source-version-unavailable');
  if (target.source === 'npm') {
    const resolved = await resolveNpmView(
      ctx.machine,
      '@officecli/officecli@' + version,
      'gitHead',
      value => (typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null),
      target.registry ?? null,
    );
    if (resolved === null) throw new Error('source-version-unavailable');
    return resolved.value;
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('source-version-unavailable');
  const reference: unknown = JSON.parse(
    await ctx.machine.fetchText('https://api.github.com/repos/iOfficeAI/OfficeCLI/git/ref/tags/v' + version),
  );
  if (!isObject(reference) || reference.ref !== 'refs/tags/v' + version || !isObject(reference.object))
    throw new Error('source-version-unavailable');
  let object = reference.object;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof object.sha !== 'string' || !/^[a-f0-9]{40}$/.test(object.sha))
      throw new Error('source-version-unavailable');
    if (object.type === 'commit') return object.sha;
    if (object.type !== 'tag') throw new Error('source-version-unavailable');
    const tag: unknown = JSON.parse(
      await ctx.machine.fetchText('https://api.github.com/repos/iOfficeAI/OfficeCLI/git/tags/' + object.sha),
    );
    if (!isObject(tag) || tag.sha !== object.sha || !isObject(tag.object))
      throw new Error('source-version-unavailable');
    object = tag.object;
  }
  throw new Error('source-version-unavailable');
}

async function prepareOfficeConnection(
  ctx: Context,
  selection: Selection,
  observed: Observation,
  target: OfficeTarget,
): Promise<Prepared> {
  const directory = path.join(ctx.claudeRoot, 'skills', OFFICECLI_SKILL);
  const { skillStamp: before, sourceRecord: record, mcpCommand: command } = observed;
  const hasMcp = command !== undefined && (!path.isAbsolute(command) || samePath(ctx, command, target.binary));
  const integration = selection.fields?.connection;
  const mcp = (action: Selection['action'], hasDetached = false) =>
    prepareMcp(
      ctx,
      'officecli',
      { ...selection, action },
      {
        hasDetached,
        registration: () => officeMcpRegistration(target.binary),
      },
    );

  if (selection.action === 'install') {
    if (before !== null && observed.skillEvidence !== 'none') {
      const skill = currentSkill(ctx, 'officecli', directory, before);
      if (integration === 'both') return sequence([skill, await mcp('connect')]);
      return integration === 'mcp' ? mcp('connect') : skill;
    }
  }
  if (selection.action === 'update') {
    if (observed.problems.some(problem => problem.code === 'source-metadata-unavailable'))
      throw new Error('source-metadata-unavailable');
    if (
      before === null ||
      !isObject(record) ||
      record.repository !== officeIntegration.skill.repository ||
      record.stamp !== before
    ) {
      const code = before === null ? 'office-connection-kept' : 'office-local-skill-kept';
      return {
        changes: [{ code }],
        run(report) {
          report({ state: 'kept', code });
          return Promise.resolve();
        },
      };
    }
  }

  const isReinstall = selection.action === 'reinstall';
  if (
    (isReinstall || integration === 'mcp' || integration === 'both') &&
    observed.registration !== undefined &&
    !hasMcp
  )
    throw new Error('integration-source-conflict');
  const shouldConnectBoth =
    integration === 'both' ||
    (isReinstall &&
      ((hasMcp && integration !== 'mcp') || (observed.skillEvidence !== 'none' && integration === 'mcp')));
  if (integration === 'mcp' && !shouldConnectBoth) return mcp('connect', isReinstall);
  if (before !== null && selection.fields?.replace !== 'yes' && (!isObject(record) || record.stamp !== before))
    throw new Error('local-edits-preserved');
  if (isReinstall && before !== null && observed.skillEvidence === 'none')
    throw new Error('integration-source-conflict');

  const revision = await officeRevision(ctx, target);
  let skill: Prepared;
  if (before !== null && isObject(record) && record.stamp === before && record.revision === revision && !isReinstall) {
    skill = currentSkill(ctx, 'officecli', directory, before);
  } else {
    const repository = officeIntegration.skill.repository;
    const files = await ctx.machine.source(repository, revision, officeIntegration.skill.folder);
    skill = prepareSkillFiles(
      ctx,
      { name: 'officecli', directory, stamp: isReinstall ? null : before, sourceRecord: record },
      { repository, revision, files, stamp: skillFilesStamp(files) },
    );
  }
  return shouldConnectBoth ? sequence([skill, await mcp('connect', isReinstall)]) : skill;
}
