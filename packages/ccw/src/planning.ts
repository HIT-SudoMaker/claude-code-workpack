import type { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { freezeClaudeCommand } from './claude-program.js';
import { knownTitle } from './management-catalog.js';
import { createCcline } from './ccline.js';
import { createClaudeDomain } from './claude.js';
import { createPluginsDomain } from './plugins.js';
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

/** 将公开预览与包含敏感运行状态的执行闭包分开保存 */
export type ApprovedPlan = {
  readonly plan: Plan;
  readonly work: ReadonlyMap<string, Prepared>;
};

/** 业务入口：Claude、Plugins、Skills，以及各自负责的额外工具 */
export const CONTENT_DOMAINS: ReadonlyArray<
  readonly [keys: readonly string[], label: string, factory: (ctx: Context) => Domain]
> = [
  [['claude', 'settings', 'data'], 'claude', createClaudeDomain],
  [['plugin'], 'plugins', createPluginsDomain],
  [['skill', 'skill-set'], 'skills', createSkillsDomain],
  [['officecli'], 'officecli', createOfficecli],
  [['ccline'], 'ccline', createCcline],
];

/**
 * 生成资源已准备、尚未执行的计划
 *
 * @param readScope - 为并行准备隔离取消和进度归属的读取作用域
 * @returns 接收请求、取消信号和进度回调的准备函数
 * @remarks 单项问题进入预览，无效请求和取消使准备拒绝；调用方隔离回调异常并消费计划
 */
export function createPlanner(ctx: Context, readScope: AsyncLocalStorage<ReadScope>) {
  // 准备域复用同一上下文；检查域另行装配以使用当次读取预算
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
          const domain = prepareDomains.get(kindOf(selection.id));
          if (!domain) throw new Error('unknown-selection');
          operation = await domain.prepare(selection, commandFor);
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

/** 根据对象标识生成计划标题，不以显示名称代替身份验证 */
function planDisplayTitle(id: string): string {
  const kind = kindOf(id);
  const key = restOf(id) ?? '';
  if (kind === 'plugin' || kind === 'skill') return knownTitle(id, key || id);
  if (kind === 'claude' || kind === 'officecli') return knownTitle(kind);
  return knownTitle(id);
}
