import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { knownTitle, programCopySuffix } from './titles.js';
import { createCcline } from './ccline.js';
import { createClaudeDomain, createSettingsDomain } from './claude-config.js';
import { createCleanupDomain, prepareClaudeDataRemoval } from './cleanup.js';
import { createMcpDomain } from './mcp.js';
import { createPluginsDomain } from './plugins.js';
import { createSkillsDomain, overlappingSkillSelections } from './skills.js';
import { errorCode } from './machine.js';
import { CLAUDE_DATA_ID, cancelled, context, defaultInstallAction, kindOf, restOf } from './model.js';
import type {
  CcwOptions,
  Change,
  Context,
  Describe,
  Domain,
  Inspection,
  Plan,
  PlanItem,
  PreparationProgress,
  Prepared,
  Progress,
  Request,
  RunResult,
  Selection,
  OperationHandler,
  Recovery,
} from './model.js';
import { createOfficecli, OFFICECLI_ENTRY_IDS } from './officecli.js';
import { createReadMachine } from './read-machine.js';
import { createEffectMachine } from './effect-machine.js';
import { createOperationController } from './operation-controller.js';

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
  recovery(): Promise<Recovery | undefined>;
  abandon(taskId: string): Promise<void>;
}

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

/** 统一管理当前用户的内容；检查不消费计划，执行逐项报告已发生的效果 */
export function createCcw(options: CcwOptions): Ccw {
  const ctx = context(options);
  const handlers = new Map<string, OperationHandler>();
  const controller = createOperationController(ctx, options.machine, handlers);
  const effects = controller.effects;
  const preparation = new AsyncLocalStorage<{
    signal?: AbortSignal;
    report: (stage: PreparationProgress['stage']) => void;
  }>();
  const preparationContext = { ...ctx, effects, machine: createReadMachine(ctx.machine, () => preparation.getStore()) };
  /** 登记 prepare 域：随 preparationContext 一次建成；inspect 域每次内联新建以吃当次读取预算 */
  const prepareDomains = new Map<string, Domain>();
  for (const [keys, , factory] of CONTENT_DOMAINS) {
    const domain = factory(preparationContext);
    for (const [key, handler] of Object.entries(domain.handlers ?? {})) {
      if (handlers.has(key)) throw new Error('duplicate-operation-handler');
      handlers.set(key, handler);
    }
    for (const key of keys) prepareDomains.set(key, domain);
  }
  const cleanup = createCleanupDomain(preparationContext);
  prepareDomains.set('data', cleanup);
  for (const [key, handler] of Object.entries(cleanup.handlers ?? {})) {
    if (handlers.has(key)) throw new Error('duplicate-operation-handler');
    handlers.set(key, handler);
  }

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
      const submitted = structuredClone(input);
      const emit = progressGuard(progress);
      const observe = (id: string, title: string) => ({
        ...(signal ? { signal } : {}),
        report(stage: PreparationProgress['stage']) {
          emit({ id, title, stage });
        },
      });
      return preparation.run({ ...(signal ? { signal } : {}), report() {} }, () =>
        controller.plan(submitted, async () => {
          if ('resume' in submitted) throw new Error('plan-unavailable');
          const snapshot = submitted;
          if (new Set(snapshot.selected.map(pick => pick.id)).size !== snapshot.selected.length)
            throw new Error('duplicate-selection');
          if (!['install', 'detach', 'uninstall', 'clean'].includes(snapshot.task))
            throw new Error('action-unavailable');
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
          for (const id of overlappingSkillSelections(preparationContext, sorted, work)) {
            const index = items.findIndex(item => item.id === id);
            items[index] = { ...items[index]!, changes: [], problem: 'overlapping-selection' };
            work.delete(id);
          }
          if (shouldRemoveData) {
            await preparation.run(observe(CLAUDE_DATA_ID, knownTitle(CLAUDE_DATA_ID)), async () => {
              preparation.getStore()?.report('inspect');
              const { changes, problem } = await attach(CLAUDE_DATA_ID, () => {
                const prerequisites = claudeRemovals.map(selection => `${selection.id}/program-removed`);
                if (
                  !claudeRemovals.every((selection, index) =>
                    work.get(selection.id)?.operations?.some(operation => operation.id === prerequisites[index]),
                  )
                )
                  throw new Error('dependency-not-ready');
                return prepareClaudeDataRemoval(preparationContext, prerequisites);
              });
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
          return { plan, work };
        }),
      );
    },
    recovery: () => controller.recovery(),
    abandon: id => controller.abandon(id),
    apply: (id, signal, progress) =>
      preparation.run({ ...(signal ? { signal } : {}), report() {} }, () => controller.apply(id, signal, progress)),
  };
}
