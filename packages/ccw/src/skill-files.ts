import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isObject, treeFilesStamp } from './machine.js';
import type { TreeFile } from './machine.js';
import { SKILL_ENTRY } from './management-catalog.js';
import { json, unchanged } from './model.js';
import type {
  Context,
  JsonObject,
  Json,
  OperationDefinition,
  OperationHandler,
  OperationOutcome,
  Prepared,
} from './model.js';
import { disabledDirectory, replacedDirectory, sourcesFile } from './storage.js';

/** Fingerprints include absence without persisting the underlying document. */
export const extensionDigest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify({ value })).digest('hex');
export function extensionString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('operation-record-invalid');
  return value;
}
export function extensionNullableString(value: unknown): string | null {
  return value === null ? null : extensionString(value);
}
function isJson(value: unknown): value is Json {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(isJson)) ||
    (isObject(value) && Object.values(value).every(isJson))
  );
}
export function extensionObject(value: unknown): JsonObject {
  if (!isObject(value) || !isJson(value)) throw new Error('operation-record-invalid');
  return value;
}
export function extensionObjects(value: unknown): readonly JsonObject[] {
  if (!Array.isArray(value)) throw new Error('operation-record-invalid');
  return value.map(extensionObject);
}
export function extensionPrepared(operations: readonly OperationDefinition[]): Prepared {
  return {
    operations,
    changes: operations.flatMap(operation => operation.changes),
    writes: [...new Set(operations.flatMap(operation => operation.writes))],
  };
}
export function currentSkill(_ctx: Context, name: string, directory: string, before: string): Prepared {
  const itemId = `skill:${name}`;
  return extensionPrepared([
    {
      id: `${itemId}/keep`,
      itemId,
      handler: 'skill.keep',
      payload: { directory, stamp: before, name },
      dependsOn: [],
      writes: [],
      changes: [{ code: 'skill-current', detail: name }],
    },
  ]);
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
export function skillFilesStamp(files: readonly TreeFile[]): string {
  if (!files.some(file => file.path === SKILL_ENTRY && file.data.length > 0)) throw new Error('skill-payload-missing');
  return treeFilesStamp(files);
}
function sourceOperation(
  ctx: Context,
  target: SkillTarget,
  source: SkillSource,
  dependsOn: readonly string[],
): OperationDefinition {
  const itemId = `skill:${target.name}`;
  return {
    id: `${itemId}/source`,
    itemId,
    handler: 'skill.source',
    dependsOn,
    writes: [sourcesFile(ctx)],
    changes: [{ code: 'skill-source-repair', detail: target.name }],
    payload: {
      file: sourcesFile(ctx),
      directory: target.directory,
      stamp: source.stamp,
      before: extensionDigest(target.sourceRecord),
      source: { repository: source.repository, revision: source.revision, stamp: source.stamp },
    },
  };
}
export function repairSkillSource(ctx: Context, target: SkillTarget, source: SkillSource): Prepared {
  return extensionPrepared([sourceOperation(ctx, target, source, [])]);
}
export function prepareSkillFiles(ctx: Context, target: SkillTarget, source: SkillSource): Prepared {
  const { name, directory, stamp: before } = target;
  const itemId = `skill:${name}`;
  const destination = before === null ? null : path.join(replacedDirectory(ctx), `${randomUUID()}-${name}`);
  const deploy: OperationDefinition = {
    id: `${itemId}/deploy`,
    itemId,
    handler: 'skill.deploy',
    dependsOn: [],
    writes: [directory, ...(destination ? [destination] : [])],
    payload: {
      name,
      directory,
      before,
      destination,
      stamp: source.stamp,
      repository: source.repository,
      revision: source.revision,
      files: source.files.map(file => ({ path: file.path, base64: Buffer.from(file.data).toString('base64') })),
    },
    changes: [
      { code: 'skill-install', detail: `${name} · ${source.revision.slice(0, 12)}` },
      ...(destination ? [{ code: 'preserved-at', detail: destination }] : []),
    ],
  };
  return extensionPrepared([deploy, sourceOperation(ctx, target, source, [deploy.id])]);
}
export function disableSkillEntry(ctx: Context, directory: string, before: string): Prepared {
  const name = path.basename(directory);
  const itemId = `${directory.includes(`${path.sep}commands${path.sep}`) ? 'command' : 'skill'}:${name}`;
  const destination = path.join(disabledDirectory(ctx), `${randomUUID()}-${name}`);
  const disable: OperationDefinition = {
    id: `${itemId}/disable`,
    itemId,
    handler: 'skill.disable',
    dependsOn: [],
    writes: [directory, destination],
    payload: { directory, before, destination },
    changes: [
      { code: 'entry-disable', detail: directory },
      { code: 'preserved-at', detail: destination },
      { code: 'keep-link-target' },
    ],
  };
  return extensionPrepared([
    disable,
    {
      id: `${itemId}/source-remove`,
      itemId,
      handler: 'skill.source-remove',
      dependsOn: [disable.id],
      writes: [sourcesFile(ctx)],
      payload: { file: sourcesFile(ctx), directory },
      changes: [],
    },
  ]);
}
async function observed(observe: () => Promise<JsonObject>): Promise<OperationOutcome> {
  const receipt = { kind: 'returned' as const, failure: null };
  try {
    return { receipt, evidence: await observe() };
  } catch {
    return { receipt };
  }
}
export function skillFileHandlers(ctx: Context): Readonly<Record<string, OperationHandler>> {
  return {
    'skill.keep': {
      async assess(definition) {
        unchanged(await ctx.machine.treeStamp(extensionString(definition.payload.directory)), definition.payload.stamp);
        return {
          state: 'complete',
          evidence: { stamp: definition.payload.stamp! },
          effects: [{ state: 'kept', code: 'skill-current', detail: extensionString(definition.payload.name) }],
        };
      },
      execute() {
        return Promise.reject(new Error('operation-unavailable'));
      },
    },
    'skill.deploy': {
      async assess(definition, fact) {
        const p = definition.payload;
        const stamp = await ctx.machine.treeStamp(extensionString(p.directory));
        if (
          stamp === p.stamp &&
          (p.before !== p.stamp || (fact.receipt?.kind === 'returned' && !fact.receipt.failure))
        ) {
          if (p.destination !== null && (await ctx.machine.treeStamp(extensionString(p.destination))) !== p.before)
            return { state: 'unknown', problem: 'target-changed' };
          return {
            state: 'complete',
            evidence: { stamp },
            effects: [{ state: 'done', code: 'skill-installed', detail: extensionString(p.name) }],
          };
        }
        if (fact.status === 'confirmed' || stamp !== p.before) return { state: 'unknown', problem: 'target-changed' };
        return { state: 'ready', dispatch: { before: stamp } };
      },
      async execute(definition) {
        const p = definition.payload;
        const files = extensionObjects(p.files).map(file => ({
          path: extensionString(file.path),
          data: Buffer.from(extensionString(file.base64), 'base64'),
        }));
        unchanged(skillFilesStamp(files), p.stamp);
        await ctx.effects.replaceTree(
          extensionString(p.directory),
          files,
          extensionNullableString(p.before),
          p.destination === null ? undefined : extensionString(p.destination),
        );
        return observed(async () => ({ stamp: await ctx.machine.treeStamp(extensionString(p.directory)) }));
      },
    },
    'skill.source': {
      async assess(definition, fact) {
        const p = definition.payload;
        unchanged(await ctx.machine.treeStamp(extensionString(p.directory)), p.stamp);
        if (fact.evidence?.metadataUnavailable === true)
          return {
            state: 'complete',
            evidence: fact.evidence,
            effects: [{ state: 'kept', code: 'source-metadata-unavailable' }],
          };
        let current;
        try {
          current = (await json(ctx.machine, extensionString(p.file)))[extensionString(p.directory)];
        } catch {
          return {
            state: 'complete',
            evidence: { metadataUnavailable: true },
            effects: [{ state: 'kept', code: 'source-metadata-unavailable' }],
          };
        }
        if (extensionDigest(current) === extensionDigest(p.source))
          return {
            state: 'complete',
            evidence: { recorded: true, target: extensionDigest(p.source) },
            effects: [{ state: 'kept', code: 'skill-source-recorded' }],
          };
        if (extensionDigest(current) !== p.before)
          return {
            state: 'complete',
            evidence: { metadataUnavailable: true },
            effects: [{ state: 'kept', code: 'source-metadata-unavailable' }],
          };
        return { state: 'ready' };
      },
      async execute(definition) {
        const p = definition.payload;
        try {
          await ctx.effects.editJson(extensionString(p.file), values => {
            unchanged(extensionDigest(values[extensionString(p.directory)]), p.before);
            values[extensionString(p.directory)] = p.source;
          });
          return {
            receipt: { kind: 'returned', failure: null },
            evidence: { recorded: true, target: extensionDigest(p.source) },
          };
        } catch {
          return {
            receipt: { kind: 'returned', failure: null },
            evidence: { metadataUnavailable: true },
            effects: [{ state: 'kept', code: 'source-metadata-unavailable' }],
          };
        }
      },
    },
    'skill.disable': {
      async assess(definition, fact, facts) {
        const p = definition.payload;
        const stamp = await ctx.machine.treeStamp(extensionString(p.directory));
        const preserved = await ctx.machine.treeStamp(extensionString(p.destination));
        if (stamp === null && preserved === p.before)
          return {
            state: 'complete',
            evidence: { preserved },
            effects: [{ state: 'done', code: 'entry-disabled', detail: extensionString(p.destination) }],
          };
        const successor = typeof p.supersededBy === 'string' ? facts[p.supersededBy] : undefined;
        if (successor?.status === 'confirmed' && successor.evidence?.stamp === stamp && preserved === p.before)
          return {
            state: 'complete',
            evidence: { preserved, superseded: true },
            effects: [{ state: 'done', code: 'entry-disabled', detail: extensionString(p.destination) }],
          };
        if (fact.status === 'confirmed' || stamp !== p.before || preserved !== null)
          return { state: 'unknown', problem: 'target-changed' };
        return { state: 'ready' };
      },
      async execute(definition) {
        const p = definition.payload;
        await ctx.effects.removeTree(
          extensionString(p.directory),
          extensionString(p.before),
          extensionString(p.destination),
        );
        return observed(async () => ({ preserved: await ctx.machine.treeStamp(extensionString(p.destination)) }));
      },
    },
    'skill.source-remove': {
      async assess(definition, fact, facts) {
        if (fact.evidence?.metadataUnavailable === true)
          return {
            state: 'complete',
            evidence: fact.evidence,
            effects: [{ state: 'kept', code: 'source-metadata-unavailable' }],
          };
        try {
          const metadata = await json(ctx.machine, extensionString(definition.payload.file));
          const directory = extensionString(definition.payload.directory);
          const successor =
            typeof definition.payload.supersededBy === 'string' ? facts[definition.payload.supersededBy] : undefined;
          if (successor?.status === 'confirmed' && successor.evidence?.target === extensionDigest(metadata[directory]))
            return { state: 'complete', evidence: { superseded: true } };
          if (!Object.hasOwn(metadata, directory)) return { state: 'complete', evidence: { absent: true } };
        } catch {
          return {
            state: 'complete',
            evidence: { metadataUnavailable: true },
            effects: [{ state: 'kept', code: 'source-metadata-unavailable' }],
          };
        }
        return { state: 'ready' };
      },
      async execute(definition) {
        try {
          await ctx.effects.editJson(extensionString(definition.payload.file), values => {
            delete values[extensionString(definition.payload.directory)];
          });
          return { receipt: { kind: 'returned', failure: null }, evidence: { absent: true } };
        } catch {
          return { receipt: { kind: 'returned', failure: null }, evidence: { metadataUnavailable: true } };
        }
      },
    },
  };
}
