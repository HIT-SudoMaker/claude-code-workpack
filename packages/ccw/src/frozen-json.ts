import { createHash } from 'node:crypto';
import { json, object } from './model.js';
import type { Change, Context, Effect } from './model.js';
import { step } from './work.js';
import type { Check, Attempt, Work } from './work.js';

/** 以摘要固定字段修改前后的值，缺失也参与比较 */
interface FrozenJsonField {
  readonly path: readonly string[];
  readonly before: string;
  readonly after: string;
}

/**
 * 计算区分 undefined 与 null 的 JSON 摘要
 *
 * @param value - 可序列化配置值，undefined 表示缺失
 * @returns SHA-256 十六进制摘要，保留键顺序
 * @throws TypeError - 循环引用或 bigint 等不可序列化内容；访问器及 toJSON 异常原样传播
 */
export const jsonFingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify({ value })).digest('hex');

/**
 * 冻结字段并准备原子 JSON 编辑
 *
 * @param options - 文件、原值摘要、目标字段及可公开的变更说明和效果
 * @returns 不公开字段值的延迟编辑步骤
 * @throws 无法克隆目标值或计算摘要时同步抛出
 * @remarks 路径和值均复制，undefined 表示删除；写入前及原子回调内都复核原值
 */
export function frozenJsonWork(
  ctx: Context,
  options: {
    readonly file: string;
    readonly fields: readonly (Omit<FrozenJsonField, 'after'> & { readonly value: unknown })[];
    readonly changes: readonly Change[];
    readonly effects: readonly Effect[];
  },
): Work {
  const { file, changes, effects } = options;
  const fields = options.fields.map(field => {
    const value: unknown = structuredClone(field.value);
    return { path: [...field.path], before: field.before, after: jsonFingerprint(value), value };
  });
  return step(
    changes,
    async fact => {
      const result = assessFrozenJson(await json(ctx.machine, file), fields, fact);
      return result.state === 'complete' ? { ...result, effects } : result;
    },
    async () => {
      await ctx.effects.editJson(file, document => applyFrozenJson(document, fields));
      return { receipt: { kind: 'returned', failure: null } };
    },
  );
}

/**
 * 比较字段与冻结值，判断完成、可写或漂移
 *
 * @param document - 当前配置快照
 * @param fields - 每个字段的路径和修改前后摘要
 * @param fact - 已派发与已确认的执行历史
 * @param problem - 目标不符时使用的问题码
 * @returns 只读核验结果
 * @throws Error - 路径经过非对象时为 invalid-settings；读取或摘要异常原样传播
 * @remarks 已确认的写入不能因目标回退而重新派发
 */
export function assessFrozenJson(
  document: Readonly<Record<string, unknown>>,
  fields: readonly FrozenJsonField[],
  fact: Attempt,
  problem = 'target-changed',
): Check {
  const current = fields.map(field => jsonFingerprint(jsonField(document, field.path)));
  if (fields.every((field, index) => current[index] === field.after)) return { state: 'complete' };
  if (
    !fact.confirmed &&
    !(fact.receipt?.kind === 'returned' && fact.receipt.failure === null) &&
    fields.every((field, index) => current[index] === field.before)
  )
    return { state: 'ready' };
  return { state: 'blocked', problem };
}

/**
 * 核对冻结摘要后原地修改指定 JSON 字段
 *
 * @param document - 原子编辑回调内的可变配置对象
 * @param fields - 字段路径、原值摘要及目标值；undefined 表示删除
 * @param problem - 当前值与冻结摘要不符时抛出的问题码
 * @throws Error - 原值漂移、路径经过非对象值或字段路径为空；属性访问或摘要计算异常原样传播
 * @remarks 所有摘要先核对再赋值；文件持久化及原子性由调用方负责
 */
export function applyFrozenJson(
  document: Record<string, unknown>,
  fields: readonly (Omit<FrozenJsonField, 'after'> & { readonly value: unknown })[],
  problem = 'target-changed',
) {
  for (const field of fields)
    if (jsonFingerprint(jsonField(document, field.path)) !== field.before) throw new Error(problem);
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

/**
 * 沿自有属性路径读取 JSON 字段
 *
 * @param document - 待读取的 JSON 对象
 * @param parts - 字段路径；空路径返回整个对象
 * @returns 字段值；路径缺失时返回 undefined
 * @throws Error - 已存在的中间值不是对象时抛出 invalid-settings
 */
export function jsonField(document: Readonly<Record<string, unknown>>, parts: readonly string[]): unknown {
  let current: unknown = document;
  for (const part of parts) {
    const parent = object(current);
    current = Object.hasOwn(parent, part) ? parent[part] : undefined;
  }
  return current;
}
