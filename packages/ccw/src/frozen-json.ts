import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { object } from './model.js';
import type { Assessment, OperationFact } from './model.js';

/** Includes absence without retaining the underlying value in a task record. */
export const jsonFingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify({ value })).digest('hex');

/** Legacy fingerprints and structural values remain explicit comparison policies. */
export interface FrozenJsonField {
  readonly path: readonly string[];
  readonly before: Expected;
  readonly after: Expected;
}
type Expected = string | readonly string[] | { readonly oneOf: readonly unknown[] };

export function jsonField(document: Record<string, unknown>, parts: readonly string[]): unknown {
  let current: unknown = document;
  for (const part of parts) {
    const parent = object(current);
    current = Object.hasOwn(parent, part) ? parent[part] : undefined;
  }
  return current;
}

function matches(value: unknown, expected: Expected): boolean {
  if (typeof expected === 'string') return jsonFingerprint(value) === expected;
  if ('oneOf' in expected) return expected.oneOf.some(candidate => isDeepStrictEqual(value, candidate));
  return expected.includes(jsonFingerprint(value));
}

/** A previously successful write may be verified, but never replayed after drift. */
export function assessFrozenJson(
  document: Record<string, unknown>,
  fields: readonly FrozenJsonField[],
  fact: OperationFact,
  problem = 'target-changed',
): Assessment {
  const current = fields.map(field => jsonField(document, field.path));
  if (fields.every((field, index) => matches(current[index], field.after)))
    return { state: 'complete', evidence: { matched: true } };
  if (
    !fact.confirmed &&
    !(fact.receipt?.kind === 'returned' && fact.receipt.failure === null) &&
    fields.every((field, index) => matches(current[index], field.before))
  )
    return { state: 'ready' };
  return { state: 'unknown', problem };
}

/** Runtime values (including credentials) never leave the atomic JSON edit. */
export function applyFrozenJson(
  document: Record<string, unknown>,
  fields: readonly (Omit<FrozenJsonField, 'after'> & { readonly value: unknown })[],
  problem = 'target-changed',
) {
  for (const field of fields) if (!matches(jsonField(document, field.path), field.before)) throw new Error(problem);
  for (const field of fields) {
    let parent = document;
    for (const part of field.path.slice(0, -1)) {
      const child = object(Object.hasOwn(parent, part) ? parent[part] : undefined);
      Object.defineProperty(parent, part, { value: child, writable: true, enumerable: true, configurable: true });
      parent = child;
    }
    const key = field.path.at(-1);
    if (key === undefined) throw new Error('operation-record-invalid');
    if (field.value === undefined) delete parent[key];
    else
      Object.defineProperty(parent, key, { value: field.value, writable: true, enumerable: true, configurable: true });
  }
}
