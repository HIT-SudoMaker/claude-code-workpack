import type { Action, Effect, ItemResult, PlanItem, Progress, Recovery, RunResult } from './model.js';
import { CLEANUP_RESIDUE_CODES } from './cleanup.js';
import { contentName, describeDiagnostic, failureLabel, safeText } from './render.js';

export type RunTone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning' | 'muted';
type RunState = ItemResult['state'] | 'waiting' | 'running' | 'skipped';

export interface RunDetail {
  readonly symbol?: string;
  readonly text: string;
  readonly tone: RunTone;
}

export interface RunRow {
  readonly id: string;
  readonly symbol: string;
  readonly status: string;
  readonly tone: RunTone;
  readonly title: string;
  readonly details: readonly RunDetail[];
}

export interface RunView {
  readonly phase: 'progress' | 'result';
  readonly title: string;
  readonly summary: string;
  readonly rows: readonly RunRow[];
  readonly activeId?: string;
}

interface ExecutionItem {
  readonly id: string;
  readonly title: string;
  readonly action?: Action;
  readonly state: ItemResult['state'] | 'waiting' | 'running';
  readonly effects: readonly Effect[];
  readonly isPending?: boolean;
}

const INDICATORS: Readonly<Record<RunState, Pick<RunRow, 'symbol' | 'status' | 'tone'>>> = {
  waiting: { symbol: '·', status: '等待', tone: 'muted' },
  running: { symbol: '▶', status: '执行中', tone: 'accent' },
  done: { symbol: '✔', status: '完成', tone: 'success' },
  partial: { symbol: '!', status: '部分完成', tone: 'danger' },
  failed: { symbol: '✕', status: '失败', tone: 'danger' },
  skipped: { symbol: '○', status: '已跳过', tone: 'warning' },
  cancelled: { symbol: '○', status: '已停止', tone: 'muted' },
};

const EFFECTS: Readonly<
  Record<Effect['state'], { readonly symbol: string; readonly tone: RunTone; readonly statement: string }>
> = {
  done: { symbol: '✔', tone: 'success', statement: '已完成' },
  kept: { symbol: '—', tone: 'muted', statement: '已保留' },
  failed: { symbol: '✕', tone: 'danger', statement: '未完成' },
  skipped: { symbol: '○', tone: 'warning', statement: '未执行' },
};

function executionState(item: Pick<ExecutionItem, 'state' | 'effects'>): RunState {
  return item.state === 'failed' && item.effects.length > 0 && item.effects.every(effect => effect.state === 'skipped')
    ? 'skipped'
    : item.state;
}

function executionSummary(items: readonly ExecutionItem[]) {
  const states = items.map(executionState);
  const count = (state: RunState) => states.filter(value => value === state).length;
  const processed = states.length - count('waiting') - count('running');
  return `处理 ${processed}/${items.length} · 完成 ${count('done')} · 失败 ${count('failed') + count('partial')} · 跳过 ${count('skipped')}${count('cancelled') ? ` · 已停止 ${count('cancelled')}` : ''}`;
}

function detail(effect: Effect): RunDetail {
  const presentation = EFFECTS[effect.state];
  return {
    symbol: presentation.symbol,
    text: `${EFFECTS[effect.state].statement} · ${describeDiagnostic(effect)}`,
    tone: presentation.tone,
  };
}

function executionRows(items: readonly ExecutionItem[], shouldShowDetails = false): RunRow[] {
  return items.map(item => {
    const state = executionState(item);
    const indicator = INDICATORS[state];
    return {
      id: item.id,
      title: contentName(item),
      ...indicator,
      ...(state === 'failed' ? { status: failureLabel(item.action) } : {}),
      details: shouldShowDetails
        ? [
            { text: `标识：${safeText(item.id)}`, tone: 'muted' },
            ...item.effects.map(detail),
            {
              text:
                item.isPending === true
                  ? '本项仍有未完成步骤'
                  : item.isPending === false
                    ? '本项无可续办步骤'
                    : '本项续办状态未提供',
              tone: 'muted',
            },
          ]
        : [],
    };
  });
}

function activeItem(items: readonly ExecutionItem[]) {
  return (
    items.find(item => item.state === 'running')?.id ?? [...items].reverse().find(item => item.state !== 'waiting')?.id
  );
}

function progressView(items: readonly ExecutionItem[]): RunView {
  const activeId = activeItem(items);
  return {
    phase: 'progress',
    title: '执行进度',
    summary: executionSummary(items),
    rows: executionRows(items),
    ...(activeId !== undefined ? { activeId } : {}),
  };
}

function resultTitle(result: RunResult, items: readonly ExecutionItem[], action?: Action) {
  if (
    result.state === 'done' &&
    result.items.some(item => item.effects.some(effect => CLEANUP_RESIDUE_CODES.includes(effect.code)))
  ) {
    return '清理完成（有保留）';
  }
  if (result.state === 'failed') {
    const actions = new Set(items.map(item => item.action));
    return failureLabel(action ?? (actions.size === 1 ? items[0]?.action : undefined));
  }
  return INDICATORS[result.state].status;
}

function resultView(result: RunResult, items: readonly ExecutionItem[], action?: Action, detailsId?: string): RunView {
  return {
    phase: 'result',
    title: detailsId === undefined ? `运行结果 · ${resultTitle(result, items, action)}` : '结果详情',
    summary:
      detailsId === undefined
        ? executionSummary(items)
        : result.remaining
          ? '本次仍有可续办任务'
          : '本次没有可续办任务',
    rows: executionRows(
      detailsId === undefined ? items : items.filter(item => item.id === detailsId),
      detailsId !== undefined,
    ),
  };
}

/** 统一投影冻结计划的进度与结果；名称由计划条目携带 */
export function createRunPresentation(
  plan: { readonly items: readonly PlanItem[] },
  action?: Action,
  history: Recovery['items'] = [],
) {
  const execution = new Map<string, ExecutionItem>(
    plan.items.map(item => [
      item.id,
      { id: item.id, title: item.title, action: item.action, state: 'waiting', effects: [] },
    ]),
  );
  for (const item of history) {
    if (item.state === 'done' && !execution.has(item.id))
      execution.set(item.id, {
        id: item.id,
        title: item.title,
        ...(action ? { action } : {}),
        state: 'done',
        effects: [],
      });
  }
  const items = () => [...execution.values()];
  const recordResult = (result: RunResult) => {
    for (const item of result.items) {
      const previous = execution.get(item.id);
      execution.set(item.id, {
        ...previous,
        ...item,
        title: previous?.title ?? item.title,
      });
    }
  };
  return {
    progress(event?: Progress): RunView {
      if (event) {
        const previous = execution.get(event.id);
        if (previous) {
          execution.set(
            event.id,
            event.kind === 'finished'
              ? { ...previous, ...event.result, title: previous.title }
              : event.kind === 'started'
                ? { ...previous, state: 'running' }
                : { ...previous, effects: [...previous.effects, event.effect] },
          );
        }
      }
      return progressView(items());
    },
    result(result: RunResult): RunView {
      recordResult(result);
      return resultView(result, items(), action);
    },
    details(result: RunResult, id: string): RunView {
      recordResult(result);
      return resultView(result, items(), action, id);
    },
  };
}

/** 状态行文本形状：交互窄屏回退与非交互输出共用 */
export const statusLine = (row: RunRow) => `${row.symbol} ${row.status}  ${row.title}`;

export function describeRun(view: RunView) {
  return [
    view.title,
    view.summary,
    ...view.rows.flatMap(row => [
      statusLine(row),
      ...row.details.map(value => `  ${value.symbol ? `${value.symbol} ` : ''}${value.text}`),
    ]),
  ]
    .filter(Boolean)
    .join('\n');
}

export function describeResult(result: RunResult) {
  const items: ExecutionItem[] = result.items.map(item => ({ ...item }));
  return describeRun(resultView(result, items));
}
