import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { knownTitle, programCopySuffix } from './titles.js';
import { createCcline } from './ccline.js';
import { ClaudeProgramVerificationError, createClaudeDomain, createSettingsDomain } from './claude-config.js';
import { createCleanupDomain, prepareClaudeDataRemoval } from './cleanup.js';
import { createMcpDomain } from './mcp.js';
import { createPluginsDomain } from './plugins.js';
import { createSkillsDomain } from './skills.js';
import { errorCode } from './machine.js';
import { CLAUDE_DATA_ID, cancelled, context, defaultInstallAction, kindOf, normalizePath, restOf } from './model.js';
import type {
  CcwOptions,
  Change,
  Context,
  Describe,
  Domain,
  Effect,
  Inspection,
  ItemResult,
  Plan,
  PlanItem,
  PreparationProgress,
  Prepared,
  Progress,
  Request,
  RunResult,
  Selection,
} from './model.js';
import { createOfficecli, OFFICECLI_ENTRY_IDS } from './officecli.js';
import { createReadMachine } from './read-machine.js';
import { createEffectMachine, createEffectScope } from './effect-machine.js';
import { writeLastRun } from './storage.js';

export type { Action, Inspection, Item, Pick, Plan, Request } from './model.js';
export interface Ccw {
  /** 并行读取独立内容；外部探测共享 5 秒预算，取消后不交付迟到结果 */
  inspect(scope?: 'contents' | 'data', signal?: AbortSignal): Promise<Inspection>;
  /** 准备只读资源，接受取消并报告当前获取步骤；不交付已取消的计划 */
  plan(
    request: Request,
    signal?: AbortSignal,
    progress?: (event: PreparationProgress) => void | Promise<void>,
  ): Promise<Plan>;
  /** 消费当前计划；观察回调失败后停止通知，实际结果仍由返回值交付 */
  apply(planId: string, signal?: AbortSignal, progress?: (event: Progress) => void | Promise<void>): Promise<RunResult>;
}

type PlanState =
  | { readonly phase: 'idle' | 'preparing' | 'applying' }
  | { readonly phase: 'ready'; readonly plan: Plan; readonly work: ReadonlyMap<string, Prepared> };

const INVALID_PROGRAM_PLAN_REASONS = new Set([
  'program-changed',
  'program-scope-unconfirmed',
  'program-installation-unconfirmed',
  'npm-changed',
]);

/** 内容域清单单一出处：kind 键供计划路由，标签进检查问题详情 */
const CONTENT_DOMAINS: ReadonlyArray<
  readonly [keys: readonly string[], label: string, factory: (ctx: Context) => Domain]
> = [
  [['claude'], 'claude', createClaudeDomain],
  [['officecli'], 'officecli', createOfficecli],
  [['settings'], 'settings', createSettingsDomain],
  [['plugin'], 'plugins', createPluginsDomain],
  [['mcp'], 'mcp', createMcpDomain],
  [['skill', 'skill-set', 'command'], 'skills', createSkillsDomain],
  [['ccline'], 'ccline', createCcline],
];

/** 约束观察器：回调失败即自失效，绝不打断流程 */
function progressGuard<P>(callback?: (event: P) => unknown) {
  let observer = callback;
  return (event: P) => {
    if (observer === undefined) return;
    try {
      void Promise.resolve(observer(event)).catch(() => {
        observer = undefined;
      });
    } catch {
      observer = undefined;
    }
  };
}

/** 构造失败的 RunResult：problem 项失败、无 problem 项跳过 */
function planFailure(
  items: readonly { readonly id: string; readonly title: string; readonly problem: string | null }[],
): RunResult {
  return {
    state: 'failed',
    items: items.map(item => ({
      id: item.id,
      title: item.title,
      state: 'failed',
      effects: [
        {
          state: item.problem ? 'failed' : 'skipped',
          code: item.problem ?? 'changes-not-started',
        },
      ],
    })),
  };
}

/** 生成准备前的纯描述；需要来源证据的标题由领域准备步骤用同一份事实补全 */
function planDisplayTitle(id: string, selected: readonly Selection[]): string {
  const kind = kindOf(id);
  const key = restOf(id) ?? '';
  if (kind === 'mcp' || kind === 'plugin' || kind === 'skill' || kind === 'command') return key || id;
  if (kind === 'claude' || kind === 'officecli')
    return `${knownTitle(kind)}${programCopySuffix(
      id,
      selected.map(other => other.id),
    )}`;
  return knownTitle(id);
}

/** 只并发解除操作；同一配置文件独占，独立入口最多同时处理四项 */
async function detachBatch(
  ctx: Context,
  items: readonly PlanItem[],
  work: ReadonlyMap<string, Prepared>,
  run: (item: PlanItem) => Promise<ItemResult>,
): Promise<ItemResult[]> {
  const waiting = items.map((item, index) => ({
    item,
    index,
    files: (work.get(item.id)?.writes ?? []).map(file => normalizePath(ctx.platform, file)),
  }));
  const occupied = new Set<string>();
  const running = new Set<Promise<void>>();
  const results: ItemResult[] = [];
  try {
    while (waiting.length || running.size) {
      while (running.size < 4) {
        const next = waiting.findIndex(entry => entry.files.every(file => !occupied.has(file)));
        if (next < 0) break;
        const entry = waiting.splice(next, 1)[0];
        if (!entry) break;
        for (const file of entry.files) occupied.add(file);
        const task = run(entry.item)
          .then(result => {
            results[entry.index] = result;
          })
          .finally(() => {
            for (const file of entry.files) occupied.delete(file);
            running.delete(task);
          });
        running.add(task);
      }
      if (running.size) await Promise.race(running);
    }
  } finally {
    await Promise.allSettled(running);
  }
  return results;
}

/** 统一管理当前用户的内容；检查不消费计划，执行逐项报告已发生的效果 */
export function createCcw(options: CcwOptions): Ccw {
  const ctx = context(options);
  let lifecycle: PlanState = { phase: 'idle' };
  const effectScope = createEffectScope(options.machine, () => lifecycle.phase === 'applying');
  const effects = effectScope.machine;
  const preparation = new AsyncLocalStorage<{
    signal?: AbortSignal;
    report: (stage: PreparationProgress['stage']) => void;
  }>();
  const preparationContext = { ...ctx, effects, machine: createReadMachine(ctx.machine, () => preparation.getStore()) };
  /** 登记 prepare 域：随 preparationContext 一次建成；inspect 域每次内联新建以吃当次读取预算 */
  const prepareDomains = new Map<string, Domain>();
  for (const [keys, , factory] of CONTENT_DOMAINS) {
    const domain = factory(preparationContext);
    for (const key of keys) prepareDomains.set(key, domain);
  }
  prepareDomains.set('data', createCleanupDomain(preparationContext));
  let remaining: { id: string; items: PlanItem[]; work: Map<string, Prepared> } | undefined;

  async function inspect(scope: 'contents' | 'data' = 'contents', signal?: AbortSignal): Promise<Inspection> {
    cancelled(signal);
    const deadlineMs = performance.now() + 5_000;
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
        ? [await guard('data', createCleanupDomain(reading))]
        : await Promise.all(CONTENT_DOMAINS.map(([, label, factory]) => guard(label, factory(reading))));
    cancelled(signal);
    const grouped = new Set(results.flatMap(result => result.grouped ?? []));
    return {
      items: results.flatMap(result => result.items).filter(item => !grouped.has(item.id)),
      problems: results.flatMap(result => result.problems),
    };
  }

  async function prepare(selection: Selection, describe: Describe): Promise<Prepared> {
    const domain = prepareDomains.get(kindOf(selection.id));
    if (!domain) throw new Error('unknown-selection');
    return domain.prepare(selection, describe);
  }

  return {
    inspect,
    async plan(input, signal, progress) {
      cancelled(signal);
      if (lifecycle.phase === 'preparing' || lifecycle.phase === 'applying') throw new Error('operation-in-progress');
      lifecycle = { phase: 'preparing' };
      const emit = progressGuard(progress);
      const observe = (id: string, title: string) => ({
        ...(signal ? { signal } : {}),
        report(stage: PreparationProgress['stage']) {
          emit({ id, title, stage });
        },
      });
      try {
        if ('resume' in input) {
          const saved = remaining;
          remaining = undefined;
          if (!saved || saved.id !== input.resume) throw new Error('plan-unavailable');
          const plan = { id: randomUUID(), items: saved.items, problem: null };
          lifecycle = { phase: 'ready', plan, work: saved.work };
          return structuredClone(plan);
        }
        remaining = undefined;
        const snapshot = structuredClone(input);
        if (!['install', 'detach', 'uninstall', 'clean'].includes(snapshot.task)) throw new Error('action-unavailable');
        if ('removeData' in snapshot && (snapshot.task !== 'uninstall' || typeof snapshot.removeData !== 'boolean'))
          throw new Error('action-unavailable');
        const shouldRemoveData = snapshot.task === 'uninstall' && snapshot.removeData === true;
        const request: Selection[] = snapshot.selected.map(pick => {
          if (
            pick.maintenance !== undefined &&
            (snapshot.task !== 'install' || !['update', 'reinstall', 'login'].includes(pick.maintenance))
          )
            throw new Error('action-unavailable');
          if (pick.removal !== undefined && (snapshot.task !== 'uninstall' || pick.removal !== 'detach'))
            throw new Error('action-unavailable');
          const isProgram = ['claude', 'officecli', 'ccline'].includes(kindOf(pick.id));
          const action =
            snapshot.task === 'install'
              ? (pick.maintenance ?? defaultInstallAction(pick.id))
              : snapshot.task === 'uninstall'
                ? pick.removal === 'detach' || !isProgram
                  ? 'detach'
                  : 'uninstall'
                : snapshot.task;
          return {
            id: pick.id,
            action,
            ...(pick.fields ? { fields: pick.fields } : {}),
            ...(shouldRemoveData && kindOf(pick.id) === 'claude' ? { removeData: true } : {}),
          };
        });
        const claudeRemovals = request.filter(
          selection => selection.action === 'uninstall' && kindOf(selection.id) === 'claude',
        );
        if (shouldRemoveData && !claudeRemovals.length) throw new Error('claude-removal-required');
        const work = new Map<string, Prepared>();
        const items: PlanItem[] = [];
        const seen = new Set<string>();
        const sorted = [...request].sort((a, b) =>
          snapshot.task === 'uninstall'
            ? Number(kindOf(a.id) === 'claude') - Number(kindOf(b.id) === 'claude')
            : Number(kindOf(a.id) !== 'claude') - Number(kindOf(b.id) !== 'claude'),
        );
        const hasOfficeConnectionChange = sorted.some(
          selection => kindOf(selection.id) === 'officecli' && selection.action !== 'update',
        );
        /** 装配单项计划：成功记入 work 并取 changes，失败收敛为 problem 码 */
        const attach = async (id: string, prepareOperation: () => Promise<Prepared>) => {
          let problem: string | null = null;
          let changes: readonly Change[] = [];
          try {
            const operation = await prepareOperation();
            changes = operation.changes;
            work.set(id, operation);
          } catch (error) {
            problem = errorCode(error);
          }
          return { changes, problem };
        };
        const prepareItem = async (selection: Selection): Promise<PlanItem> => {
          cancelled(signal);
          let title = planDisplayTitle(selection.id, sorted);
          let observer = observe(selection.id, title);
          return preparation.run({ ...observer, report: stage => observer.report(stage) }, async () => {
            observer.report('inspect');
            const { changes, problem } = await attach(selection.id, async () => {
              if (seen.has(selection.id)) throw new Error('duplicate-selection');
              seen.add(selection.id);
              if (hasOfficeConnectionChange && (OFFICECLI_ENTRY_IDS as readonly string[]).includes(selection.id))
                throw new Error('overlapping-selection');
              return prepare(selection, resolved => {
                cancelled(signal);
                if (title === resolved) return;
                title = resolved;
                observer = observe(selection.id, title);
                observer.report('inspect');
              });
            });
            cancelled(signal);
            return { id: selection.id, title, action: selection.action, changes, problem };
          });
        };
        let next = 0;
        const workers = await Promise.allSettled(
          Array.from({ length: Math.min(2, sorted.length) }, async () => {
            while (next < sorted.length) {
              const index = next++;
              const selection = sorted[index];
              if (selection) items[index] = await prepareItem(selection);
            }
          }),
        );
        for (const result of workers) if (result.status === 'rejected') throw result.reason;
        if (shouldRemoveData) {
          await preparation.run(observe(CLAUDE_DATA_ID, knownTitle(CLAUDE_DATA_ID)), async () => {
            preparation.getStore()?.report('inspect');
            const { changes, problem } = await attach(CLAUDE_DATA_ID, () =>
              prepareClaudeDataRemoval(preparationContext, async () => {
                for (const selection of claudeRemovals) {
                  const program = work.get(selection.id);
                  if (!program?.verify) throw new Error('dependency-not-ready');
                  await program.verify();
                }
              }),
            );
            items.push({
              id: CLAUDE_DATA_ID,
              title: knownTitle(CLAUDE_DATA_ID),
              action: 'uninstall',
              changes,
              problem,
            });
          });
        }
        const plan: Plan = { id: randomUUID(), items, problem: items.length === 0 ? 'empty-selection' : null };
        cancelled(signal);
        lifecycle = { phase: 'ready', plan, work };
        return structuredClone(plan);
      } catch (error) {
        lifecycle = { phase: 'idle' };
        throw error;
      } finally {
        preparation.disable();
      }
    },
    async apply(planId, signal, progress) {
      if (lifecycle.phase !== 'ready' || lifecycle.plan.id !== planId)
        return planFailure([
          {
            id: 'plan',
            title: knownTitle('plan'),
            problem:
              lifecycle.phase === 'preparing' || lifecycle.phase === 'applying'
                ? 'operation-in-progress'
                : 'plan-unavailable',
          },
        ]);
      const current = lifecycle;
      lifecycle = { phase: 'applying' };
      if (current.plan.items.some(item => item.problem !== null)) {
        lifecycle = { phase: 'idle' };
        return planFailure(current.plan.items);
      }
      return effectScope.run(async () => {
        const guard = progressGuard(progress);
        const notify = (event: Progress) => guard(structuredClone(event));
        try {
          let hasClaudeFailure = false;
          let isClaudePlanInvalidated = false;
          const unfinished = new Map<string, Prepared>();
          const unfinishedItems: PlanItem[] = [];
          const runItem = async (item: PlanItem): Promise<ItemResult> => {
            const effects: Effect[] = [];
            const report = (effect: Effect) => {
              effects.push(effect);
              notify({ kind: 'effect', id: item.id, effect });
            };
            let state: ItemResult['state'] = 'done';
            let isPlanInvalidated = false;
            notify({ kind: 'started', id: item.id });
            try {
              cancelled(signal);
              if (
                hasClaudeFailure &&
                item.action !== 'detach' &&
                (kindOf(item.id) === 'plugin' || item.action === 'login' || item.id === CLAUDE_DATA_ID)
              )
                throw new Error('dependency-not-ready');
              const operation = current.work.get(item.id);
              if (operation === undefined) throw new Error('plan-unavailable');
              await operation.run(report, signal);
            } catch (error) {
              const code = errorCode(error);
              isPlanInvalidated =
                INVALID_PROGRAM_PLAN_REASONS.has(code) || (code === 'dependency-not-ready' && isClaudePlanInvalidated);
              if (
                !effects.some(
                  effect => effect.code === code && (effect.state === 'failed' || effect.state === 'skipped'),
                )
              )
                report({ state: code === 'cancelled' || code === 'dependency-not-ready' ? 'skipped' : 'failed', code });
              state =
                code === 'cancelled'
                  ? 'cancelled'
                  : effects.some(effect => effect.state === 'done')
                    ? 'partial'
                    : 'failed';
              if (
                kindOf(item.id) === 'claude' &&
                (isPlanInvalidated ||
                  error instanceof ClaudeProgramVerificationError ||
                  !effects.some(effect => effect.code === 'program-ready'))
              ) {
                hasClaudeFailure = true;
                isClaudePlanInvalidated ||= isPlanInvalidated;
              }
            }
            let isPending = false;
            if (state !== 'done' && !isPlanInvalidated) {
              const operation = current.work.get(item.id);
              const rest = operation?.remaining ? operation.remaining() : operation;
              if (rest) {
                isPending = true;
                unfinished.set(item.id, rest);
                unfinishedItems.push({ ...item, changes: rest.changes });
              }
            }
            const result = { id: item.id, title: item.title, state, effects, isPending };
            notify({ kind: 'finished', id: item.id, result });
            return result;
          };
          const results: ItemResult[] = [];
          if (
            current.plan.items.every(
              item => item.action === 'detach' && current.work.get(item.id)?.writes !== undefined,
            )
          )
            results.push(...(await detachBatch(ctx, current.plan.items, current.work, runItem)));
          else for (const item of current.plan.items) results.push(await runItem(item));
          const token = unfinished.size ? randomUUID() : undefined;
          if (token)
            remaining = {
              id: token,
              items: current.plan.items
                .filter(item => unfinished.has(item.id))
                .map(item => unfinishedItems.find(value => value.id === item.id) ?? item),
              work: unfinished,
            };
          const result: RunResult = {
            state: results.some(item => item.state === 'cancelled')
              ? 'cancelled'
              : results.every(item => item.state === 'done') && current.plan.problem === null
                ? 'done'
                : results.some(item => item.state === 'done' || item.state === 'partial')
                  ? 'partial'
                  : 'failed',
            items: results,
            ...(token ? { remaining: token } : {}),
          };
          // 最近执行落盘供诊断收集读取，尽力而为
          await writeLastRun(ctx, current.plan, result, token);
          return result;
        } finally {
          lifecycle = { phase: 'idle' };
        }
      });
    },
  };
}
