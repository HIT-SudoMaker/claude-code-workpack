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

function envelope(value: unknown): Envelope {
  if (
    !isObject(value) ||
    !keys(value, ['schema', 'checksum', 'record']) ||
    value.schema !== 1 ||
    typeof value.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.checksum) ||
    !isRecord(value.record) ||
    checksum(value.record) !== value.checksum
  )
    throw invalid();
  return { schema: 1, checksum: value.checksum, record: value.record };
}

function decode(text: string): Envelope {
  try {
    const value: unknown = JSON.parse(text);
    return envelope(value);
  } catch (error) {
    throw invalid(error);
  }
}

/** 无记录与无法读取严格区分；损坏内容不会当成新任务。 */
export async function readOperation(machine: Machine, ctx: StorageContext): Promise<OperationRecord | undefined> {
  let text: string | null;
  try {
    text = await machine.read(operationFile(ctx));
  } catch (error) {
    throw unavailable(error);
  }
  return text === null ? undefined : decode(text).record;
}

/** 提交后回读完整校验；调用方只在此 Promise 成功后获得派发资格。 */
export async function writeOperation(machine: Machine, ctx: StorageContext, record: OperationRecord): Promise<void> {
  if (!isRecord(record)) throw invalid();
  const frozen = envelope({ schema: 1, checksum: checksum(record), record: structuredClone(record) });
  const file = operationFile(ctx);
  let before: string | null;
  try {
    before = await machine.read(file);
  } catch (error) {
    throw unavailable(error);
  }
  if (before !== null) decode(before);
  try {
    const expected = before === null ? null : createHash('sha256').update(before).digest('hex');
    await machine.replaceFile(file, Buffer.from(`${JSON.stringify(frozen, null, 2)}\n`), expected);
    const saved = await machine.read(file);
    if (saved === null || checksum(decode(saved)) !== checksum(frozen)) throw unavailable('read-back-mismatch');
  } catch (error) {
    throw unavailable(error);
  }
}

/** 放弃仅删除控制记录，不接触已成功的目标内容。 */
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
    const stamp = createHash('sha256').update(before).digest('hex');
    await machine.remove(file, stamp);
    if ((await machine.read(file)) !== null) throw unavailable('record-remains');
  } catch (error) {
    throw unavailable(error);
  }
}
