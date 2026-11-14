import { AsyncLocalStorage } from 'node:async_hooks';

import { errorCode } from './machine.js';
import { cancelled, context } from './model.js';
import type {
  CcwOptions,
  Domain,
  Inspection,
  ItemResult,
  Plan,
  PlanItem,
  PreparationProgress,
  Progress,
  Request,
  RunResult,
} from './model.js';
import { createReadMachine } from './read-machine.js';
import type { ReadScope } from './read-machine.js';
import { createEffectMachine, createEffectScope } from './effect-machine.js';
import { inspectClaudeData } from './cleanup.js';
import { CONTENT_DOMAINS, createPlanner } from './planning.js';
import type { ApprovedPlan } from './planning.js';

export type { Action, Inspection, Item, Pick, Plan, Request } from './model.js';

const INSPECTION_TIMEOUT_MS = 5_000;
const VERIFICATION_TIMEOUT_MS = 30_000;

/** 检查、准备并执行当前用户的工具配置 */
export interface Ccw {
  /**
   * 汇总各工具域的安装与配置状态
   *
   * @param signal - 取消本次检查的信号
   * @param scope - contents 检查工具，data 仅清点可清理的 Claude 数据
   * @returns 状态与检查问题；单域失败不阻断其他域
   * @throws Error - 取消时以 cancelled 拒绝
   * @remarks 不消费现有计划，不写入受管目标；外部探测共享五秒预算
   */
  inspect(signal?: AbortSignal, scope?: 'contents' | 'data'): Promise<Inspection>;
  /**
   * 根据选择准备一份可预览的内存计划
   *
   * @param request - 安装、移除或清理任务及所选对象；输入会先复制
   * @param signal - 取消资源准备的信号
   * @param progress - 准备进度接收器；抛错或拒绝后停止通知，不中断准备
   * @returns 不含凭据的计划副本；空选择记录为计划问题，单项准备失败记录在对应条目中
   * @throws Error - 并发操作、无效请求或取消时拒绝
   * @remarks 新请求使旧计划失效；可查询或暂存来源，但不写入受管目标
   */
  plan(
    request: Request,
    signal?: AbortSignal,
    progress?: (event: PreparationProgress) => void | Promise<void>,
  ): Promise<Plan>;
  /**
   * 消费当前计划并逐项执行已确认的变更
   *
   * @param planId - 当前实例最近一次准备的计划标识
   * @param signal - 停止后续写入的信号，不取消已发生效果的核验
   * @param progress - 进度接收器；接收副本，失败后停止通知
   * @returns 逐项结果；失效计划、执行失败和取消通过结果表达
   * @remarks 计划只能消费一次；不回滚已发生的效果，独立项目可继续执行
   */
  apply(planId: string, signal?: AbortSignal, progress?: (event: Progress) => void | Promise<void>): Promise<RunResult>;
}

/**
 * 创建独立持有计划和操作锁的 CCW 实例
 *
 * @throws Error - 用户目录或配置根不是有效的绝对非根路径
 * @remarks 创建时不安装工具，读写由实例方法触发
 */
export function createCcw(options: CcwOptions): Ccw {
  const ctx = context(options);
  let busy = false;
  let approved: ApprovedPlan | undefined;
  const effectScope = createEffectScope(options.machine);
  const effects = effectScope.machine;
  const readScope = new AsyncLocalStorage<ReadScope>();
  const preparationContext = { ...ctx, effects, machine: createReadMachine(ctx.machine, () => readScope.getStore()) };
  const plan = createPlanner(preparationContext, readScope);

  async function inspect(signal?: AbortSignal, scope: 'contents' | 'data' = 'contents'): Promise<Inspection> {
    cancelled(signal);
    const deadlineMs = performance.now() + INSPECTION_TIMEOUT_MS;
    const reading = {
      ...ctx,
      effects: createEffectMachine(options.machine, () => false),
      machine: createReadMachine(ctx.machine, () => ({ deadlineMs, ...(signal ? { signal } : {}) }), {
        shouldShareReads: true,
      }),
    };
    /** 吸收单域检查失败：收敛为该域问题项，不打断其余域 */
    const guard = async (name: string, domain: Domain): Promise<Inspection> => {
      try {
        return await domain.inspect();
      } catch (error) {
        return { items: [], problems: [{ code: errorCode(error), detail: name }] };
      }
    };
    const results =
      scope === 'data'
        ? [await inspectClaudeData(reading)]
        : await Promise.all(CONTENT_DOMAINS.map(([, label, factory]) => guard(label, factory(reading))));
    cancelled(signal);
    return { items: results.flatMap(result => result.items), problems: results.flatMap(result => result.problems) };
  }

  async function apply(
    planId: string,
    signal?: AbortSignal,
    progress?: (event: Progress) => void | Promise<void>,
  ): Promise<RunResult> {
    if (busy) return failedRun('operation-in-progress');
    const current = approved;
    if (!current || current.plan.id !== planId) return failedRun('plan-unavailable');
    approved = undefined;
    busy = true;
    const notify = progressGuard(progress);
    const problems = new Map<string, string>();
    const finished = new Set<string>();
    let wasCancelled = false;
    const verify = <T>(read: () => Promise<T>): Promise<T> =>
      readScope.run(
        {
          deadlineMs: performance.now() + VERIFICATION_TIMEOUT_MS,
          commandTimeoutMs: VERIFICATION_TIMEOUT_MS,
          timeoutCode: 'verification-timeout',
        },
        read,
      );
    const resultFor = (item: PlanItem): ItemResult => {
      const outcome = current.work.get(item.id)?.result();
      const failure = problems.get(item.id);
      const done = !!outcome?.complete && !item.problem && failure === undefined;
      const effects = [...(outcome?.effects ?? [])];
      const causes = new Set([
        ...(item.problem ? [item.problem] : []),
        ...(failure === undefined ? [] : [failure]),
        ...(outcome?.problems ?? []),
      ]);
      if (!done && wasCancelled && !finished.has(item.id) && !item.problem) causes.add('cancelled');
      for (const problem of causes)
        if (!effects.some(effect => effect.code === problem))
          effects.push({
            state: problem === 'cancelled' || problem === 'dependency-not-ready' ? 'skipped' : 'failed',
            code: problem,
          });
      const hasEffect = effects.some(effect => effect.state === 'done' || effect.state === 'kept');
      const failed = effects.some(effect => effect.state === 'failed');
      const result: ItemResult = {
        id: item.id,
        title: item.title,
        state: done
          ? 'done'
          : hasEffect
            ? 'partial'
            : failed
              ? 'failed'
              : causes.has('cancelled')
                ? 'cancelled'
                : causes.has('dependency-not-ready')
                  ? 'skipped'
                  : 'failed',
        effects,
      };
      return result;
    };
    try {
      for (const item of current.plan.items) {
        const job = current.work.get(item.id);
        if (!job || item.problem) {
          notify({ kind: 'checked', id: item.id, result: resultFor(item) });
          continue;
        }
        try {
          cancelled(signal);
          await job.run({
            ...(signal ? { signal } : {}),
            perform: action => effectScope.run(action, signal),
            verify,
            started: () => notify({ kind: 'started', id: item.id }),
            report: effect => notify({ kind: 'effect', id: item.id, effect }),
          });
          finished.add(item.id);
        } catch (error) {
          if (errorCode(error) === 'cancelled') {
            wasCancelled = true;
          } else problems.set(item.id, errorCode(error));
        }
        notify({ kind: 'checked', id: item.id, result: resultFor(item) });
        if (wasCancelled) break;
      }
      wasCancelled ||= signal?.aborted === true;
      for (const [id, job] of current.work) {
        try {
          await verify(() => job.verify());
        } catch (error) {
          problems.set(id, errorCode(error));
        }
      }
      const results = current.plan.items.map(item => {
        const result = resultFor(item);
        notify({ kind: 'finished', id: item.id, result });
        return result;
      });
      const result: RunResult = {
        state: results.every(item => item.state === 'done')
          ? 'done'
          : wasCancelled
            ? 'cancelled'
            : results.some(item => item.state === 'done' || item.state === 'partial')
              ? 'partial'
              : 'failed',
        items: results,
      };
      return result;
    } catch (error) {
      return failedRun(errorCode(error));
    } finally {
      busy = false;
    }
  }

  return {
    inspect,
    async plan(input, signal, progress) {
      if (busy) throw new Error('operation-in-progress');
      approved = undefined;
      busy = true;
      try {
        const current = await plan(input, signal, progressGuard(progress));
        approved = current;
        return structuredClone(current.plan);
      } finally {
        busy = false;
      }
    },
    apply: (id, signal, progress) =>
      readScope.run({ ...(signal ? { signal } : {}) }, () => apply(id, signal, progress)),
  };
}

const failedRun = (problem: string): RunResult => ({
  state: 'failed',
  items: [{ id: 'plan', title: '操作计划', state: 'failed', effects: [{ state: 'failed', code: problem }] }],
});

/** 复制公开进度并隔离接收器异常 */
function progressGuard<P>(callback?: (event: P) => unknown) {
  let observer = callback;
  return (event: P) => {
    if (!observer) return;
    try {
      void Promise.resolve(observer(structuredClone(event))).catch(() => {
        observer = undefined;
      });
    } catch {
      observer = undefined;
    }
  };
}
