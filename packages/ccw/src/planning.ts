import type { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { freezeClaudeCommand } from './claude-program.js';
import { knownTitle } from './management-catalog.js';
import { createCcline } from './ccline.js';
import { createClaudeDomain } from './claude.js';
import { prepareDataCleanup } from './cleanup.js';
import { createPluginsDomain } from './plugins.js';
import { createSettingsDomain } from './settings.js';
import { createSkillsDomain, overlappingSkillSelections } from './skills.js';
import { createOfficecli } from './officecli.js';
import { errorCode } from './machine.js';
import type { ReadScope } from './read-machine.js';
import { cancelled, kindOf, restOf } from './model.js';
import type {
  ClaudeCommand,
  Context,
  Domain,
  Plan,
  PlanItem,
  PreparationProgress,
  Prepared,
  Request,
  Selection,
} from './model.js';

const PREPARATION_CONCURRENCY = 2;

/** 公开预览与单独保存的内部执行项 */
export type ApprovedPlan = {
  readonly plan: Plan;
  readonly work: ReadonlyMap<string, Prepared>;
};

/** 程序和接入的域注册表，顺序与检查结果一致 */
export const CONTENT_DOMAINS: ReadonlyArray<
  readonly [keys: readonly string[], label: string, factory: (ctx: Context) => Domain]
> = [
  [['claude'], 'claude', createClaudeDomain],
  [['settings'], 'settings', createSettingsDomain],
  [['plugin'], 'plugins', createPluginsDomain],
  [['skill', 'skill-set'], 'skills', createSkillsDomain],
  [['officecli'], 'officecli', createOfficecli],
  [['ccline'], 'ccline', createCcline],
];

/**
 * 创建计划准备器
 *
 * @param readScope - 为并行准备隔离取消和进度归属的读取作用域
 * @returns 准备资源并返回待确认计划的函数
 * @remarks 准备函数将单项问题写入预览，无效请求或取消时拒绝 Promise
 * 调用方负责隔离进度回调异常和消费计划
 */
export function createPlanner(ctx: Context, readScope: AsyncLocalStorage<ReadScope>) {
  // 复用准备域，检查时另行装配以使用当次读取预算
  const prepareDomains = new Map<string, Domain>();
  for (const [keys, , factory] of CONTENT_DOMAINS) {
    const domain = factory(ctx);
    for (const key of keys) prepareDomains.set(key, domain);
  }

  return async (
    input: Request,
    signal: AbortSignal | undefined,
    emit: (event: PreparationProgress) => void,
  ): Promise<ApprovedPlan> => {
    cancelled(signal);
    const snapshot = structuredClone(input);
    if (new Set(snapshot.selected.map(pick => pick.id)).size !== snapshot.selected.length)
      throw new Error('duplicate-selection');
    if (!['install', 'uninstall', 'clean'].includes(snapshot.task)) throw new Error('action-unavailable');
    if (snapshot.selected.some(pick => (kindOf(pick.id) === 'data') !== (snapshot.task === 'clean')))
      throw new Error('action-unavailable');
    if ('removeData' in snapshot || snapshot.selected.some(pick => 'action' in pick))
      throw new Error('action-unavailable');
    const request: Selection[] = snapshot.selected.map(pick => ({
      id: pick.id,
      action:
        snapshot.task === 'clean'
          ? 'clean'
          : snapshot.task === 'install'
            ? pick.id === 'settings'
              ? 'configure'
              : 'install'
            : ['claude', 'officecli', 'ccline'].includes(kindOf(pick.id))
              ? 'uninstall'
              : 'detach',
      ...(pick.fields ? { fields: pick.fields } : {}),
    }));
    const work = new Map<string, Prepared>();
    const claudeSelections = request.filter(selection => kindOf(selection.id) === 'claude');
    const otherSelections = request.filter(selection => kindOf(selection.id) !== 'claude');
    let existingCommand: Promise<ClaudeCommand> | undefined;
    const commandFor = async (): Promise<ClaudeCommand> => {
      if (claudeSelections.length) {
        const selection = claudeSelections.length === 1 ? claudeSelections[0] : undefined;
        const command = selection ? work.get(selection.id)?.claude : undefined;
        if (!command) throw new Error('dependency-not-ready');
        return command;
      }
      return (existingCommand ??= freezeClaudeCommand(ctx));
    };
    const prepareItem = async (selection: Selection): Promise<PlanItem> => {
      cancelled(signal);
      const title = planDisplayTitle(selection.id);
      const scope = {
        ...(signal ? { signal } : {}),
        report: stage => emit({ id: selection.id, title, stage }),
      } satisfies ReadScope;
      return readScope.run(scope, async () => {
        scope.report('inspect');
        let operation: Prepared | undefined;
        let problem: string | null = null;
        try {
          if (snapshot.task === 'clean') operation = await prepareDataCleanup(ctx, selection);
          else {
            const domain = prepareDomains.get(kindOf(selection.id));
            if (!domain) throw new Error('unknown-selection');
            operation = await domain.prepare(selection, commandFor);
          }
          work.set(selection.id, operation);
        } catch (error) {
          problem = errorCode(error);
        }
        cancelled(signal);
        return {
          id: selection.id,
          title,
          action: operation?.action ?? selection.action,
          changes: operation?.changes ?? [],
          problem,
        };
      });
    };
    const prepareGroup = async (selections: readonly Selection[]): Promise<PlanItem[]> => {
      const items: PlanItem[] = [];
      let next = 0;
      const workers = await Promise.allSettled(
        Array.from({ length: Math.min(PREPARATION_CONCURRENCY, selections.length) }, async () => {
          while (next < selections.length) {
            const index = next++;
            const selection = selections[index];
            if (selection) items[index] = await prepareItem(selection);
          }
        }),
      );
      for (const result of workers) if (result.status === 'rejected') throw result.reason;
      return items;
    };
    const claudeItems = await prepareGroup(claudeSelections);
    const otherItems = await prepareGroup(otherSelections);
    const ordered = snapshot.task === 'uninstall' ? [...otherItems, ...claudeItems] : [...claudeItems, ...otherItems];
    const overlaps = overlappingSkillSelections(ctx, request, work);
    const items = ordered.map(item =>
      overlaps.has(item.id) ? { ...item, changes: [], problem: 'overlapping-selection' } : item,
    );
    for (const id of overlaps) work.delete(id);
    const plan: Plan = { id: randomUUID(), items, problem: items.length === 0 ? 'empty-selection' : null };
    cancelled(signal);
    return { plan, work };
  };
}

/** 根据对象标识生成计划标题 */
function planDisplayTitle(id: string): string {
  const kind = kindOf(id);
  const key = restOf(id) ?? '';
  if (kind === 'plugin' || kind === 'skill') return knownTitle(id, key || id);
  if (kind === 'claude' || kind === 'officecli') return knownTitle(kind);
  return knownTitle(id);
}
