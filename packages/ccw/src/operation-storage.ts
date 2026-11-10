import { createHash } from 'node:crypto';
import path from 'node:path';

import { isObject } from './machine.js';
import type { Machine } from './machine.js';
import type {
  Change,
  Context,
  Effect,
  Json,
  JsonObject,
  OperationDefinition,
  OperationFact,
  OperationRecord,
  PlanItem,
} from './model.js';

type StorageContext = Pick<Context, 'storage'>;

/** 唯一当前任务；普通 last-run 摘要不参与恢复判断。 */
export const operationFile = (ctx: StorageContext) => path.join(ctx.storage, 'operation.json');

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function invalid(cause?: unknown): Error {
  return new Error('operation-record-invalid', { cause });
}

function unavailable(cause: unknown): Error {
  return new Error('operation-record-unavailable', { cause });
}

const actions = new Set([
  'install',
  'connect',
  'update',
  'reinstall',
  'configure',
  'login',
  'detach',
  'uninstall',
  'clean',
]);
const phases = new Set(['preparing', 'awaiting-confirmation', 'executing', 'paused', 'completed']);
const statuses = new Set(['pending', 'issued', 'confirmed', 'failed', 'checking', 'unneeded']);
const effectStates = new Set(['done', 'kept', 'failed', 'skipped']);

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function text(value: unknown): value is string {
  return typeof value === 'string';
}

function identity(value: unknown): value is string {
  return text(value) && value.length > 0;
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(text);
}

function optional(value: Record<string, unknown>, key: string, validate: (field: unknown) => boolean): boolean {
  return !Object.hasOwn(value, key) || validate(value[key]);
}

function isJson(value: unknown, ancestors = new Set<object>()): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value) || Object.getOwnPropertySymbols(value).length) return false;
  if (
    Array.isArray(value)
      ? Object.keys(value).length !== value.length
      : Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
  )
    return false;
  const next = new Set(ancestors).add(value);
  return Object.values(value).every(child => isJson(child, next));
}

function isJsonObject(value: unknown): value is JsonObject {
  return isObject(value) && isJson(value);
}

function isChange(value: unknown): value is Change {
  return isObject(value) && keys(value, ['code', 'detail']) && identity(value.code) && optional(value, 'detail', text);
}

function changes(value: unknown): value is readonly Change[] {
  return Array.isArray(value) && value.every(isChange);
}

function isEffect(value: unknown): value is Effect {
  return (
    isObject(value) &&
    keys(value, ['state', 'code', 'detail']) &&
    text(value.state) &&
    effectStates.has(value.state) &&
    identity(value.code) &&
    optional(value, 'detail', text)
  );
}

function isItem(value: unknown): value is PlanItem {
  return (
    isObject(value) &&
    keys(value, ['id', 'title', 'action', 'changes', 'problem']) &&
    identity(value.id) &&
    text(value.title) &&
    text(value.action) &&
    actions.has(value.action) &&
    changes(value.changes) &&
    (value.problem === null || text(value.problem))
  );
}

function isDefinition(value: unknown): value is OperationDefinition {
  return (
    isObject(value) &&
    keys(value, ['id', 'itemId', 'handler', 'payload', 'dependsOn', 'writes', 'changes', 'requiresInput']) &&
    identity(value.id) &&
    identity(value.itemId) &&
    identity(value.handler) &&
    isJsonObject(value.payload) &&
    strings(value.dependsOn) &&
    strings(value.writes) &&
    changes(value.changes) &&
    optional(value, 'requiresInput', strings)
  );
}

function isReceipt(value: unknown): boolean {
  return (
    isObject(value) &&
    keys(value, ['kind', 'failure']) &&
    ((value.kind === 'returned' && (value.failure === null || text(value.failure))) ||
      (value.kind === 'unknown' && text(value.failure)))
  );
}

function isFact(value: unknown): value is OperationFact {
  return (
    isObject(value) &&
    keys(value, ['status', 'confirmed', 'attemptId', 'dispatch', 'receipt', 'evidence', 'problem', 'effects']) &&
    text(value.status) &&
    statuses.has(value.status) &&
    optional(value, 'confirmed', field => field === true) &&
    optional(value, 'attemptId', identity) &&
    optional(value, 'dispatch', isJsonObject) &&
    optional(value, 'receipt', isReceipt) &&
    optional(value, 'evidence', isJsonObject) &&
    optional(value, 'problem', text) &&
    Array.isArray(value.effects) &&
    value.effects.every(isEffect)
  );
}

function isRecord(value: unknown): value is OperationRecord {
  if (
    !isObject(value) ||
    !keys(value, ['schema', 'id', 'phase', 'planId', 'intent', 'items', 'operations', 'facts']) ||
    value.schema !== 1 ||
    !identity(value.id) ||
    !text(value.phase) ||
    !phases.has(value.phase) ||
    !identity(value.planId) ||
    !isJsonObject(value.intent) ||
    !Array.isArray(value.items) ||
    !value.items.every(isItem) ||
    !Array.isArray(value.operations) ||
    !value.operations.every(isDefinition) ||
    !isObject(value.facts) ||
    !Object.values(value.facts).every(isFact)
  )
    return false;
  const itemIds = new Set(value.items.map(item => item.id));
  const definitions = new Map(value.operations.map(definition => [definition.id, definition]));
  if (
    itemIds.size !== value.items.length ||
    definitions.size !== value.operations.length ||
    Object.keys(value.facts).length !== definitions.size
  )
    return false;
  for (const definition of value.operations) {
    if (
      !itemIds.has(definition.itemId) ||
      !Object.hasOwn(value.facts, definition.id) ||
      definition.dependsOn.some(id => !definitions.has(id))
    )
      return false;
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const acyclic = (id: string): boolean => {
    if (visited.has(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    if (!definitions.get(id)?.dependsOn.every(acyclic)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  return value.operations.every(definition => acyclic(definition.id));
}

interface Envelope {
  readonly schema: 1;
  readonly checksum: string;
  readonly record: OperationRecord;
}
interface PayloadResource {
  readonly encoding: 'resource';
  readonly checksum: string;
  readonly characters: number;
  readonly chunks: readonly string[];
}
type StoredPayload = { readonly encoding: 'inline'; readonly value: JsonObject } | PayloadResource;
type StoredRecord = Omit<OperationRecord, 'operations'> & {
  readonly operations: readonly (Omit<OperationDefinition, 'payload'> & { readonly payload: StoredPayload })[];
};
interface ResourceEnvelope {
  readonly schema: 2;
  readonly checksum: string;
  readonly record: StoredRecord;
}
const PAYLOAD_INLINE_BYTES = 128 * 1024;
const RESOURCE_CHARS = 256 * 1024;
const RECORD_BYTES = 2 * 1024 * 1024;
const hashText = (value: string) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const resourceFile = (ctx: StorageContext, digest: string) =>
  path.join(ctx.storage, 'operation-resources', digest + '.part');

function envelope(value: unknown): Envelope {
  if (
    !isObject(value) ||
    !keys(value, ['schema', 'checksum', 'record']) ||
    value.schema !== 1 ||
    !hash(value.checksum) ||
    !isRecord(value.record) ||
    checksum(value.record) !== value.checksum
  )
    throw invalid();
  return { schema: 1, checksum: value.checksum, record: value.record };
}
function isStoredPayload(value: unknown): value is StoredPayload {
  return (
    isObject(value) &&
    ((value.encoding === 'inline' && keys(value, ['encoding', 'value']) && isJsonObject(value.value)) ||
      (value.encoding === 'resource' &&
        keys(value, ['encoding', 'checksum', 'characters', 'chunks']) &&
        hash(value.checksum) &&
        typeof value.characters === 'number' &&
        Number.isSafeInteger(value.characters) &&
        value.characters > 0 &&
        value.characters <= 512 * 1024 * 1024 &&
        Array.isArray(value.chunks) &&
        value.chunks.length > 0 &&
        value.chunks.length <= 4096 &&
        value.chunks.every(hash)))
  );
}
function isStoredRecord(value: unknown): value is StoredRecord {
  if (!isObject(value) || !Array.isArray(value.operations)) return false;
  const operations: unknown[] = [];
  for (const operation of value.operations) {
    if (!isObject(operation) || !isStoredPayload(operation.payload)) return false;
    operations.push({ ...operation, payload: {} });
  }
  return isRecord({ ...value, operations });
}
function decode(text: string): Envelope | ResourceEnvelope {
  try {
    const value: unknown = JSON.parse(text);
    if (isObject(value) && value.schema === 2) {
      if (
        !keys(value, ['schema', 'checksum', 'record']) ||
        !hash(value.checksum) ||
        !isStoredRecord(value.record) ||
        checksum(value.record) !== value.checksum
      )
        throw invalid();
      return { schema: 2, checksum: value.checksum, record: value.record };
    }
    return envelope(value);
  } catch (error) {
    throw invalid(error);
  }
}
async function hydrate(
  machine: Machine,
  ctx: StorageContext,
  stored: Envelope | ResourceEnvelope,
): Promise<OperationRecord> {
  if (stored.schema === 1) return stored.record;
  const operations: OperationDefinition[] = [];
  for (const operation of stored.record.operations) {
    let payload: JsonObject;
    if (operation.payload.encoding === 'inline') payload = operation.payload.value;
    else {
      const pieces: string[] = [];
      let characters = 0;
      for (const digest of operation.payload.chunks) {
        const piece = await machine.read(resourceFile(ctx, digest));
        if (piece === null || piece.length > RESOURCE_CHARS || hashText(piece) !== digest)
          throw invalid('resource-changed');
        characters += piece.length;
        if (characters > operation.payload.characters) throw invalid('resource-size-changed');
        pieces.push(piece);
      }
      const text = pieces.join('');
      if (characters !== operation.payload.characters || hashText(text) !== operation.payload.checksum)
        throw invalid('resource-changed');
      const value: unknown = JSON.parse(text);
      if (!isJsonObject(value)) throw invalid();
      payload = value;
    }
    operations.push({ ...operation, payload });
  }
  const record = { ...stored.record, operations };
  if (!isRecord(record)) throw invalid();
  return record;
}
async function storePayload(machine: Machine, ctx: StorageContext, text: string): Promise<PayloadResource> {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + RESOURCE_CHARS, text.length);
    // Keep each UTF-16 surrogate pair in one UTF-8 chunk.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    const piece = text.slice(offset, end);
    const digest = hashText(piece);
    const file = resourceFile(ctx, digest);
    const before = await machine.read(file);
    if (before === null) await machine.replaceFile(file, Buffer.from(piece), null);
    else if (before !== piece) throw invalid('resource-changed');
    if ((await machine.read(file)) !== piece) throw unavailable('resource-read-back-mismatch');
    chunks.push(digest);
    offset = end;
  }
  return { encoding: 'resource', checksum: hashText(text), characters: text.length, chunks };
}
async function encode(
  machine: Machine,
  ctx: StorageContext,
  record: OperationRecord,
): Promise<Envelope | ResourceEnvelope> {
  const values = record.operations.map(operation => JSON.stringify(operation.payload));
  if (values.every(value => Buffer.byteLength(value) <= PAYLOAD_INLINE_BYTES))
    return envelope({ schema: 1, checksum: checksum(record), record });
  const operations: StoredRecord['operations'][number][] = [];
  for (const [index, operation] of record.operations.entries()) {
    const text = values[index]!;
    const payload: StoredPayload =
      Buffer.byteLength(text) > PAYLOAD_INLINE_BYTES
        ? await storePayload(machine, ctx, text)
        : { encoding: 'inline', value: operation.payload };
    operations.push({ ...operation, payload });
  }
  const stored: StoredRecord = { ...record, operations };
  return { schema: 2, checksum: checksum(stored), record: stored };
}

/** No record and unreadable record remain distinct; missing resources never become a new task. */
export async function readOperation(machine: Machine, ctx: StorageContext): Promise<OperationRecord | undefined> {
  let text: string | null;
  try {
    text = await machine.read(operationFile(ctx));
  } catch (error) {
    throw unavailable(error);
  }
  if (text === null) return undefined;
  try {
    return await hydrate(machine, ctx, decode(text));
  } catch (error) {
    throw invalid(error);
  }
}

/** Verify immutable resources before committing the one current-task envelope. */
export async function writeOperation(machine: Machine, ctx: StorageContext, record: OperationRecord): Promise<void> {
  if (!isRecord(record)) throw invalid();
  record = structuredClone(record);
  const file = operationFile(ctx);
  let before: string | null;
  try {
    before = await machine.read(file);
  } catch (error) {
    throw unavailable(error);
  }
  if (before !== null) await hydrate(machine, ctx, decode(before));
  try {
    const frozen = await encode(machine, ctx, record);
    const text = JSON.stringify(frozen) + '\n';
    if (Buffer.byteLength(text) > RECORD_BYTES) throw unavailable('record-too-large');
    await machine.replaceFile(file, Buffer.from(text), before === null ? null : hashText(before));
    const saved = await machine.read(file);
    if (saved === null || checksum(decode(saved)) !== checksum(frozen)) throw unavailable('read-back-mismatch');
    if (checksum(await hydrate(machine, ctx, decode(saved))) !== checksum(record))
      throw unavailable('read-back-mismatch');
  } catch (error) {
    throw unavailable(error);
  }
}

/** Abandon clears only control data; immutable resources carry no progress and may remain. */
export async function clearOperation(machine: Machine, ctx: StorageContext): Promise<void> {
  const file = operationFile(ctx);
  let before: string | null;
  try {
    before = await machine.read(file);
  } catch (error) {
    throw unavailable(error);
  }
  if (before === null) return;
  decode(before);
  try {
    await machine.remove(file, hashText(before));
    if ((await machine.read(file)) !== null) throw unavailable('record-remains');
  } catch (error) {
    throw unavailable(error);
  }
}
