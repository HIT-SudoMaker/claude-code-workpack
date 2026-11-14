import { errorCode } from './machine.js';
import { cancelled } from './model.js';
import type { Change, Effect } from './model.js';

/** 记录外部调用是否返回；回执本身不证明目标已经就绪 */
export type Receipt =
  | { readonly kind: 'returned'; readonly failure: string | null }
  | { readonly kind: 'unknown'; readonly failure: string };

/** 向核验函数提供执行历史；工具专属状态由各工具自行持有 */
export interface Attempt {
  /** 曾核验为完成，可能没有实际写入 */
  readonly confirmed?: true;
  /** 已进入派发阶段，禁止自动再次派发 */
  readonly dispatched?: true;
  readonly receipt?: Receipt;
}
/** 表达当前事实已完成、可派发或阻止执行 */
export type Check =
  | { readonly state: 'complete'; readonly effects?: readonly Effect[] }
  | { readonly state: 'ready' }
  | { readonly state: 'blocked'; readonly problem: string };
/** 交付写调用的回执与已知效果，随后仍需事实核验 */
interface Outcome {
  readonly receipt: Receipt;
  readonly effects?: readonly Effect[];
}
interface Execution {
  readonly signal?: AbortSignal;
  /** 在当前写入资格内调用效果函数 */
  perform<T>(action: () => Promise<T>): Promise<T>;
  /** 在独立读取作用域核验，避免调用方取消抹去已发生的事实 */
  verify<T>(read: () => Promise<T>): Promise<T>;
  started(): void;
  report(effect: Effect): void;
}
/** 持有一组变更说明及本次执行结果 */
export interface Work {
  readonly changes: readonly Change[];
  /** 返回当前核验状态，不触发读取或写入 */
  result(): { readonly complete: boolean; readonly effects: readonly Effect[]; readonly problems: readonly string[] };
  /**
   * 执行本项并通过调度器核验已发生效果
   *
   * @param execution - 写入资格、独立读取与进度通知能力
   * @param allowed - 前置条件是否满足；为 false 时记录依赖未就绪
   * @returns 本次执行结束，不代表所有步骤成功；通过 result 读取结果
   * @throws Error - 取消检查触发时以 cancelled 拒绝；未捕获的子项、核验或通知失败原样传播
   * @remarks 派发期间的拒绝先转为未知回执；随后的事实核验仍可确认完成
   */
  run(execution: Execution, allowed?: boolean): Promise<void>;
  /** 重新核验此前完成的步骤；发现漂移时更新结果，不重新派发写入 */
  verify(): Promise<void>;
}

/**
 * 构造先观察、至多派发一次、再核验的执行步骤
 *
 * @param changes - 准备时可展示的变更说明
 * @param check - 只读核验函数；接收执行历史并返回当前事实
 * @param apply - 可选写入函数；接收取消信号及独立核验能力，返回回执
 * @returns 延迟执行并保存核验结果的步骤
 * @remarks 写入异常先记为未知回执，仍可通过事实核验确认完成；成功退出码也不单独证明完成
 * 目标漂移后不自动重发
 */
export function step(
  changes: readonly Change[],
  check: (attempt: Attempt) => Promise<Check>,
  apply?: (signal: AbortSignal | undefined, verify: Execution['verify']) => Promise<Outcome>,
): Work {
  let attempt: Attempt = {};
  let complete = false;
  let effects: readonly Effect[] = [];
  let problem: string | undefined;
  const assess = async (): Promise<Check> => {
    try {
      return await check(attempt);
    } catch (error) {
      return { state: 'blocked', problem: errorCode(error) };
    }
  };
  const accept = (result: Check) => {
    complete = result.state === 'complete';
    problem = result.state === 'blocked' ? result.problem : undefined;
    if (result.state === 'complete') {
      attempt = { ...attempt, confirmed: true };
      effects = result.effects ?? effects;
    }
  };
  return {
    changes,
    result: () => ({ complete, effects, problems: problem ? [problem] : [] }),
    async run(execution, allowed = true) {
      cancelled(execution.signal);
      if (!allowed) {
        problem = 'dependency-not-ready';
        return;
      }
      const before = await assess();
      accept(before);
      if (before.state !== 'ready') {
        for (const effect of effects) execution.report(effect);
        return;
      }
      if (!apply || attempt.dispatched) {
        problem = 'operation-unconfirmed';
        return;
      }
      execution.started();
      cancelled(execution.signal);
      attempt = { ...attempt, dispatched: true };
      let outcome: Outcome;
      try {
        outcome = await execution.perform(() => apply(execution.signal, read => execution.verify(read)));
      } catch (error) {
        outcome = { receipt: { kind: 'unknown', failure: errorCode(error) } };
      }
      attempt = { ...attempt, receipt: outcome.receipt };
      effects = outcome.effects ?? [];
      for (const effect of effects) execution.report(effect);
      const after = await execution.verify(assess);
      const reported = effects;
      accept(after);
      if (after.state === 'ready') problem = outcome.receipt.failure ?? 'operation-unconfirmed';
      for (const effect of effects)
        if (
          !reported.some(
            previous =>
              previous.code === effect.code && previous.state === effect.state && previous.detail === effect.detail,
          )
        )
          execution.report(effect);
    },
    async verify() {
      if (complete) {
        const result = await assess();
        accept(result);
        if (result.state === 'ready') problem = 'target-changed';
      }
    },
  };
}

/**
 * 按次序执行独立子项，结果中记录的失败不阻断其他项
 *
 * @param children - 本次执行的子项，空数组表示无变更
 * @returns 汇总全部子项状态与效果的工作项
 * @remarks 子项 run 的拒绝会中止后续项；已发生的效果不回滚
 */
export const work = (children: readonly Work[]): Work => combine(children, false);
/**
 * 按前置依赖执行子项，前项未就绪时阻止后继写入
 *
 * @param children - 按依赖先后排列的子项
 * @returns 保留已发生效果并汇总依赖问题的工作项
 */
export const sequence = (children: readonly Work[]): Work => combine(children, true);

/** 汇总子步骤；顺序流程在每个后继步骤前重新核验前置项 */
function combine(children: readonly Work[], sequential: boolean): Work {
  return {
    changes: children.flatMap(child => child.changes),
    result: () => {
      const results = children.map(child => child.result());
      const problems = results.flatMap(result => result.problems);
      return {
        complete: results.every(result => result.complete),
        effects: results.flatMap(result => result.effects),
        problems: problems.some(problem => problem !== 'dependency-not-ready')
          ? problems.filter(problem => problem !== 'dependency-not-ready')
          : problems,
      };
    },
    async run(execution, allowed = true) {
      let ready = allowed;
      let previous: Work | undefined;
      for (const child of children) {
        if (sequential && previous) {
          const predecessor = previous;
          await execution.verify(() => predecessor.verify());
          ready &&= predecessor.result().complete;
        }
        await child.run(execution, ready);
        previous = child;
      }
    },
    async verify() {
      for (const child of children) await child.verify();
    },
  };
}
