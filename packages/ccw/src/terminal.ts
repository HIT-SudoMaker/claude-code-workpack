import { isDeepStrictEqual } from 'node:util';

import type { Action, Ccw, Inspection, Item, Pick, Plan, Request } from './ccw.js';
import {
  ACTION_NAMES,
  BACK_TO_HOME,
  contentEntries,
  contentName,
  contentOrder,
  contentRows,
  DEFAULT_PREFERENCES,
  describeChange,
  describeDiagnostic,
  describeItem,
  describeInspectionProblem,
  describePreparation,
  effectiveConnection,
  entryRows,
  entrySelected,
  failureLabel,
  GROUPS,
  HOME_TITLE,
  inspectedItems,
  MODEL_FIELDS,
  planVerb,
  preparationTitle,
  PROBLEM_MARK,
  reason,
  SETTINGS_FIELDS,
  SETTINGS_LANGUAGES,
  SETTINGS_STYLES,
  UNCONFIRMED,
  USER_SCOPE_SUFFIX,
} from './render.js';
import type { MenuRow, SettingsEditor } from './render.js';
import { createRunPresentation } from './run-presentation.js';
import type { RunView } from './run-presentation.js';
import {
  apiConfigurationProblem,
  CLAUDE_DATA_ID,
  defaultInstallAction,
  kindOf,
  REPLACE_CONSENT,
  restOf,
} from './model.js';
import { knownTitle } from './titles.js';

export interface SelectionPage {
  readonly title: string;
  readonly rows: readonly (MenuRow & {
    readonly checked: boolean;
    readonly enter: 'toggle' | 'edit' | 'open';
  })[];
  readonly submitLabel: string;
}
export type SelectionChange = { readonly kind: 'toggle'; readonly index: number } | { readonly kind: 'all' };
export interface FormField {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly secret?: boolean;
  readonly placeholder?: string;
}
export type FormProblem = { readonly message: string; readonly field: string; readonly detail?: string } | null;
export interface Terminal {
  /** 等待只读任务时保留 Esc；离开后取消任务并忽略迟到结果；首帧文案由调用方交付 */
  wait<T>(
    title: string,
    work: (signal: AbortSignal, update?: (message: string) => void) => Promise<T>,
    signal?: AbortSignal,
    firstFrame?: string,
  ): Promise<T | null>;
  choose(
    title: string | RunView,
    choices: readonly (string | MenuRow)[],
    defaultIndex?: number,
    cancelIndex?: number,
  ): Promise<number>;
  /** 原地编辑整页字段；校验失败保留输入并定位字段，取消不交付草稿 */
  form(
    title: string,
    fields: readonly FormField[],
    validate: (values: Readonly<Record<string, string>>) => FormProblem,
  ): Promise<Record<string, string> | null>;
  /** 暂停界面并释放终端输入，任务结束后恢复界面 */
  handoff<T>(work: () => Promise<T>): Promise<T>;
  /** 勾选同步更新草稿并返回新画面；返回事件不再携带第二份选择状态 */
  select(
    page: SelectionPage,
    change: (event: SelectionChange) => SelectionPage,
    focus?: number,
  ): Promise<{ readonly kind: 'open' | 'submit' | 'cancel' | 'refresh'; readonly index: number }>;
  show(view: RunView): void;
}

async function chooseWithDetails(
  terminal: Terminal,
  title: string,
  choices: readonly string[],
  details: string,
  defaultIndex = choices.length - 1,
) {
  let focus = defaultIndex;
  while (true) {
    const choice = await terminal.choose(title, [...choices, '查看详情'], focus, choices.length - 1);
    if (choice !== choices.length) return choice;
    await terminal.choose(details, ['返回']);
    focus = choice;
  }
}

async function editSettings(
  item: Item,
  editor: SettingsEditor,
  terminal: Terminal,
  prior?: Pick,
): Promise<Pick | null> {
  const values: Record<string, string> = { ...item.values, ...prior?.fields };
  const fields: Record<string, string> = { ...prior?.fields };
  if (editor !== 'connection') {
    const choices = editor === 'language' ? SETTINGS_LANGUAGES : SETTINGS_STYLES;
    const current = values[editor] ?? DEFAULT_PREFERENCES[editor];
    const index = await terminal.choose(
      editor === 'language' ? '默认输出语言' : '输出风格',
      [...choices.map(choice => choice.label), '返回'],
      Math.max(
        0,
        choices.findIndex(choice => choice.value === current),
      ),
    );
    const choice = choices[index];
    if (choice === undefined) return null;
    fields[editor] = choice.value;
    return { id: item.id, fields };
  }
  const mode = await terminal.choose(
    '模型配置',
    ['官方登录', '第三方 API', '返回'],
    effectiveConnection(values, item.facts) === 'api' ? 1 : 0,
  );
  if (mode === 2) return null;
  for (const field of SETTINGS_FIELDS.connection) delete fields[field];
  if (mode === 0) {
    fields.mode = 'official';
    fields.login = 'yes';
  } else {
    const api: Record<string, string> = { mode: 'api', auth: values.auth ?? 'key' };
    for (const { key } of MODEL_FIELDS) if (values[key] !== undefined) api[key] = values[key];
    for (const key of ['baseUrl', 'secret']) if (prior?.fields?.[key] !== undefined) api[key] = prior.fields[key];
    const edited = await terminal.form(
      '第三方 API',
      [
        { key: 'baseUrl', label: 'Base URL', value: api.baseUrl ?? '', placeholder: '必填' },
        { key: 'secret', label: 'API Key', value: api.secret ?? '', secret: true, placeholder: '必填' },
        ...MODEL_FIELDS.map(model => ({
          key: model.key,
          label: model.label,
          value: api[model.key] ?? '',
          placeholder: '选填，可添加 [1m]',
        })),
      ],
      form => {
        const problem = apiConfigurationProblem(form.baseUrl, Boolean(form.secret?.trim()));
        return problem
          ? {
              message: reason(problem),
              field: problem === 'credential-required' ? 'secret' : 'baseUrl',
              detail: describeDiagnostic({ code: problem }),
            }
          : null;
      },
    );
    if (edited === null) return null;
    for (const [key, value] of Object.entries(edited)) {
      const trimmed = value.trim();
      if (key === 'secret') {
        if (trimmed) {
          api.secret = trimmed;
          api.auth = 'key';
        }
      } else if (trimmed || Object.hasOwn(api, key)) api[key] = trimmed;
    }
    Object.assign(fields, api);
  }
  if (values.language === undefined) fields.language = DEFAULT_PREFERENCES.language;
  if (values.outputStyle === undefined) fields.outputStyle = DEFAULT_PREFERENCES.outputStyle;
  return { id: item.id, fields };
}

const TASK_ORDER = ['install', 'inspect', 'uninstall', 'clean'] as const;
/** 草稿标记"仅解除接入"：勾选与路由三处共享同一字面量 */
const DETACH_REMOVAL = { removal: 'detach' as const };
type Task = (typeof TASK_ORDER)[number];
const TASKS: Readonly<Record<Task, { name: string; actions: readonly Action[] }>> = {
  install: { name: '安装套件', actions: ['install', 'connect', 'configure'] },
  inspect: { name: '检查套件', actions: [] },
  uninstall: { name: '卸载套件', actions: ['uninstall', 'detach'] },
  clean: { name: '清理数据', actions: ['clean'] },
};
function availableActions(item: Item, task: Task): readonly Action[] {
  if (task === 'install' && item.skillSet) return [];
  if (task === 'install')
    return item.canInstall ? [defaultInstallAction(item.id)] : item.actions.filter(action => action === 'connect');
  return item.actions
    .filter(action => TASKS[task].actions.includes(action))
    .sort((a, b) => Number(b === 'uninstall') - Number(a === 'uninstall'));
}

export async function runTerminal(ccw: Ccw, terminal: Terminal, signal?: AbortSignal) {
  const focus: Record<Task, number> = { install: 0, inspect: 0, uninstall: 0, clean: 0 };
  const knownItems = new Map<string, Item>();
  const drafts: Record<Task, Map<string, Pick>> = {
    install: new Map(),
    inspect: new Map(),
    uninstall: new Map(),
    clean: new Map(),
  };
  const problems = new Map<string, string>();
  let task: Task = 'inspect';
  let pending: { task: Task; remaining?: string; plan?: Plan; removeData?: boolean } | undefined;
  let removeClaudeData = false;
  const selected = () => drafts[task];
  const dataPending = () => task === 'uninstall' && pending?.task === task && pending.removeData === true;
  const dataVisible = () =>
    task === 'uninstall' &&
    ([...selected().keys()].some(id => knownItems.get(id)?.kind === 'claude' || kindOf(id) === 'claude') ||
      dataPending());
  const hasSelection = () => selected().size > 0 || dataPending();
  const reconcile = () => {
    if (task === 'uninstall' && !dataVisible()) removeClaudeData = false;
  };
  const changeSelection = (edit: () => void) => {
    const before = [...selected()];
    const dataBefore = removeClaudeData;
    edit();
    if (!isDeepStrictEqual(before, [...selected()]) || dataBefore !== removeClaudeData) {
      pending = undefined;
      problems.delete(CLAUDE_DATA_ID);
    }
    reconcile();
  };
  const select = (id: string, pick?: Pick) => {
    changeSelection(() => {
      if (pick) selected().set(id, pick);
      else selected().delete(id);
      problems.delete(id);
    });
  };
  while (!signal?.aborted) {
    const selectedTask =
      TASK_ORDER[await terminal.choose(HOME_TITLE, [...TASK_ORDER.map(task => TASKS[task].name), '退出'])];
    if (selectedTask === undefined || signal?.aborted) return;
    task = selectedTask;
    reconcile();
    let returnToMenu = false;
    let view: Inspection | null = null;
    problems.clear();
    while (!returnToMenu && !signal?.aborted) {
      if (view === null) {
        view = await terminal.wait(
          `${TASKS[task].name} · 检查环境`,
          reading => ccw.inspect(task === 'clean' ? 'data' : 'contents', reading),
          signal,
        );
        if (view === null || signal?.aborted) break;
        for (const item of view.items) knownItems.set(item.id, item);
      }
      const ordered = contentOrder(task === 'inspect' ? inspectedItems(view.items) : view.items);
      if (task === 'inspect') {
        const choices = [...contentRows(ordered), '刷新检查', BACK_TO_HOME];
        const index = await terminal.choose(
          `检查套件${USER_SCOPE_SUFFIX}${view.problems.length ? `\n${PROBLEM_MARK}${UNCONFIRMED}` : ''}`,
          view.problems.length ? [...choices, '查看详情'] : choices,
          focus.inspect,
          ordered.length + 1,
        );
        focus.inspect = index;
        if (view.problems.length && index === choices.length) {
          await terminal.choose(`检查详情\n${view.problems.map(describeInspectionProblem).join('\n')}`, ['返回']);
          continue;
        }
        if (index === ordered.length) {
          view = null;
          continue;
        }
        const item = ordered[index];
        if (item === undefined) break;
        const installTarget = item.kind === 'skill' || item.kind === 'command' ? undefined : item;
        const routes = [
          ...(installTarget && availableActions(installTarget, 'install').length
            ? [{ label: '进入安装', task: 'install' as const, item: installTarget, maintenance: undefined }]
            : []),
          // 识别与操作取并集：识别到 update 动作的对象在此提供更新入口
          ...(item.actions.includes('update')
            ? [{ label: '进入更新', task: 'install' as const, item, maintenance: 'update' as const }]
            : []),
          ...(availableActions(item, 'uninstall').length
            ? [{ label: '进入卸载', task: 'uninstall' as const, item, maintenance: undefined }]
            : []),
        ];
        const route =
          routes[
            await chooseWithDetails(
              terminal,
              describeItem(item),
              [...routes.map(route => route.label), '返回'],
              describeItem(item, true),
              routes.length,
            )
          ];
        if (!route) continue;
        task = route.task;
        reconcile();
        const target = route.item;
        const priorFields = selected().get(target.id)?.fields;
        const selection =
          target.kind === 'settings' && task === 'install'
            ? await editSettings(target, 'connection', terminal, selected().get(target.id))
            : {
                id: target.id,
                ...(route.maintenance
                  ? {
                      maintenance: route.maintenance,
                      // 保留既有草稿字段（如"备份并替换"的放行同意），不因重进路由而丢失
                      ...(priorFields ? { fields: priorFields } : {}),
                    }
                  : {}),
                ...(task === 'uninstall' && !target.actions.includes('uninstall') ? DETACH_REMOVAL : {}),
              };
        if (selection && (target.kind === 'settings' || route.maintenance !== undefined || !selected().has(target.id)))
          select(target.id, selection);
        continue;
      }
      const taskAction = task;
      // 已选更新的成员在安装页保留一行：可见、可取消；未选时仍由套件入口代表
      const items = ordered.filter(
        item =>
          availableActions(item, task).length > 0 ||
          (task === 'install' && selected().get(item.id)?.maintenance !== undefined),
      );
      const remaining = pending?.task === task ? pending : undefined;
      const missing = new Set([...selected().keys()].filter(id => !remaining && !items.some(item => item.id === id)));
      if (remaining)
        for (const id of selected().keys()) {
          const item = knownItems.get(id);
          if (item && !items.some(value => value.id === id)) items.push(item);
        }
      for (const id of missing) {
        const item = knownItems.get(id);
        if (item) items.push(item);
        problems.set(id, 'selected-item-unavailable');
      }
      const entries = contentEntries(items, task === 'install');
      const notices: string[] = [];
      if (task === 'uninstall') {
        notices.push('默认保留用户配置与数据');
        if (!items.length && !hasSelection()) notices.push('无可卸载项');
      }
      if (task === 'clean') {
        notices.push('保留程序、配置与凭据');
        if (!items.length) notices.push('无可清理数据');
      }
      if (problems.size) notices.push(PROBLEM_MARK + failureLabel(task));
      if (view.problems.length) notices.push(`${PROBLEM_MARK}${UNCONFIRMED}`);
      const title = [TASKS[task].name + USER_SCOPE_SUFFIX, ...notices].join('\n');
      const page = (): SelectionPage => {
        const labels = entryRows(entries, selected());
        const showData = dataVisible();
        const dataProblem = problems.get(CLAUDE_DATA_ID);
        const rows: Array<SelectionPage['rows'][number]> = entries.map((entry, index) => {
          const problem = problems.get(entry.item.id);
          const editable = task === 'install' && entry.editor !== undefined;
          const maintenance = task === 'install' ? selected().get(entry.item.id)?.maintenance : undefined;
          const removal =
            task === 'uninstall' && entry.item.actions.includes('uninstall')
              ? selected().get(entry.item.id)?.removal === 'detach'
                ? '仅解除接入'
                : '卸载程序'
              : '';
          return {
            ...labels[index],
            label: labels[index]?.label ?? '',
            detail: [
              problem ? failureLabel(taskAction) : labels[index]?.detail,
              ...(maintenance ? [`已选${ACTION_NAMES[maintenance]}`] : []),
              removal,
            ]
              .filter(Boolean)
              .join(' · '),
            checked: entrySelected(entry, selected()),
            enter: problem
              ? 'open'
              : editable
                ? 'edit'
                : task === 'install' || availableActions(entry.item, task).length === 1
                  ? 'toggle'
                  : 'open',
          };
        });
        if (showData) {
          rows.push({
            label: `删除 ${knownTitle(CLAUDE_DATA_ID)}（不可恢复）`,
            ...(dataProblem ? { detail: failureLabel(taskAction) } : {}),
            group: GROUPS.data,
            checked: removeClaudeData,
            enter: dataProblem ? 'open' : 'toggle',
          });
        }
        const selectedCount = selected().size + Number(showData && removeClaudeData);
        const dataDescription = showData
          ? '\n删除范围：配置、登录状态、会话、Skills 和目录内工具\n删除位置：.claude / .claude.json（以预览路径为准）'
          : '';
        return {
          title: title + dataDescription,
          submitLabel: task === 'install' ? `开始安装（${selectedCount} 项）` : `预览 ${selectedCount} 项变更`,
          rows,
        };
      };
      const response = await terminal.select(
        page(),
        event => {
          changeSelection(() => {
            if (event.kind === 'toggle' && event.index === entries.length && dataVisible()) {
              removeClaudeData = !removeClaudeData;
              return;
            }
            const targets =
              event.kind === 'all'
                ? entries.filter(
                    entry =>
                      entry.editor === undefined &&
                      !missing.has(entry.item.id) &&
                      // 更新勾选是显式意图，全选不得静默降级为普通安装
                      selected().get(entry.item.id)?.maintenance === undefined,
                  )
                : entries.filter((_entry, index) => index === event.index);
            const shouldSelect = event.kind === 'all' && targets.some(entry => !entrySelected(entry, selected()));
            for (const entry of targets) {
              const prior = selected().get(entry.item.id);
              if (event.kind === 'all' ? !shouldSelect : entrySelected(entry, selected())) {
                const fields = { ...prior?.fields };
                if (entry.editor) for (const field of SETTINGS_FIELDS[entry.editor]) delete fields[field];
                if (entry.editor && Object.keys(fields).length)
                  selected().set(entry.item.id, { ...prior, id: entry.item.id, fields });
                else selected().delete(entry.item.id);
              } else if (!prior && entry.editor === undefined && !missing.has(entry.item.id)) {
                selected().set(entry.item.id, {
                  id: entry.item.id,
                  ...(task === 'uninstall' && !entry.item.actions.includes('uninstall') ? DETACH_REMOVAL : {}),
                });
              }
              if (!missing.has(entry.item.id) || !selected().has(entry.item.id)) problems.delete(entry.item.id);
            }
          });
          return page();
        },
        focus[task],
      );
      focus[task] = response.index;
      if (response.kind === 'cancel') {
        returnToMenu = true;
        continue;
      }
      if (response.kind === 'refresh') {
        view = null;
        problems.clear();
        continue;
      }
      if (response.kind === 'open') {
        const entry = entries[response.index];
        if (entry === undefined) {
          const dataProblem = problems.get(CLAUDE_DATA_ID);
          if (response.index === entries.length && dataVisible() && dataProblem) {
            const choice = await chooseWithDetails(
              terminal,
              `${knownTitle(CLAUDE_DATA_ID)}\n${failureLabel(task)}`,
              ['取消选择', '返回'],
              `${knownTitle(CLAUDE_DATA_ID)}\n${describeDiagnostic({ code: dataProblem })}`,
            );
            if (choice === 0)
              changeSelection(() => {
                removeClaudeData = false;
                problems.delete(CLAUDE_DATA_ID);
              });
          }
          continue;
        }
        const item = entry.item;
        const problem = problems.get(item.id);
        const brief = problem ? `${contentName(item)}\n${failureLabel(task)}` : describeItem(item);
        const details = [
          describeItem(item, true),
          ...(problem && problem !== item.problem ? [describeDiagnostic({ code: problem })] : []),
          ...view.problems.map(describeInspectionProblem),
        ].join('\n');
        if (task === 'install' && problems.get(item.id) === 'local-edits-preserved') {
          const choice = await chooseWithDetails(terminal, brief, ['备份并替换', '取消选择', '返回'], details, 2);
          const prior = selected().get(item.id);
          if (choice === 0 && prior)
            select(item.id, { ...prior, fields: { ...prior.fields, replace: REPLACE_CONSENT } });
          if (choice === 1) select(item.id);
          continue;
        }
        if (entry.editor !== undefined) {
          if (problem) {
            const choice = await chooseWithDetails(terminal, brief, ['编辑配置', '取消选择', '返回'], details);
            if (choice === 1) select(item.id);
            if (choice !== 0) continue;
          }
          const selection = await editSettings(item, entry.editor, terminal, selected().get(item.id));
          if (selection) {
            select(item.id, selection);
          }
          continue;
        }
        const actions = task === 'install' ? [] : availableActions(item, task);
        const choice = await chooseWithDetails(
          terminal,
          brief,
          [...actions.map(action => ACTION_NAMES[action]), '取消选择', '返回'],
          details,
          actions.length + 1,
        );
        if (choice === actions.length) {
          select(item.id);
        }
        const action = actions[choice];
        if (action !== undefined) {
          select(item.id, {
            id: item.id,
            ...(action === 'detach' ? DETACH_REMOVAL : {}),
          });
        }
        continue;
      }
      if (!hasSelection()) continue;
      if ([...missing].some(id => selected().has(id))) {
        focus[task] = Math.max(
          0,
          entries.findIndex(entry => missing.has(entry.item.id) && selected().has(entry.item.id)),
        );
        continue;
      }
      const picks = [...selected().values()];
      // 套件整装保留已有成员、成员更新改写成员：同计划必然与冻结的目录摘要冲突，提交前阻断
      const suiteTargets = new Set(picks.filter(pick => kindOf(pick.id) === 'skill-set').map(pick => restOf(pick.id)));
      const overlappingUpdate = suiteTargets.size
        ? picks.find(pick => {
            if (pick.maintenance === undefined) return false;
            const suite = knownItems.get(pick.id)?.skillSet;
            return suite !== undefined && suiteTargets.has(suite);
          })
        : undefined;
      if (overlappingUpdate) {
        problems.set(overlappingUpdate.id, 'overlapping-selection');
        focus[task] = Math.max(
          0,
          entries.findIndex(entry => entry.item.id === overlappingUpdate.id),
        );
        continue;
      }
      const saved = pending?.task === task ? pending : undefined;
      const request: Request = saved?.remaining
        ? { resume: saved.remaining }
        : task === 'uninstall'
          ? { task, selected: picks, ...(removeClaudeData ? { removeData: true } : {}) }
          : { task, selected: picks };
      const preparationTask = task;
      const preparation = preparationTitle(task);
      let preparing: Promise<Plan> | undefined;
      const plan =
        saved?.plan ??
        (saved?.remaining
          ? await ccw.plan(request, signal)
          : await terminal.wait(
              preparation,
              (reading, update) => {
                preparing = ccw.plan(request, reading, event => update?.(describePreparation(event, preparationTask)));
                return preparing;
              },
              signal,
              preparation,
            ));
      if (plan === null) {
        await preparing?.catch(() => undefined);
        pending = undefined;
        continue;
      }
      if (signal?.aborted) return;
      pending = undefined;
      problems.clear();
      for (const item of plan.items) if (item.problem !== null) problems.set(item.id, item.problem);
      if (plan.problem === null && problems.size === 0)
        pending = { task, plan, ...(task === 'uninstall' && removeClaudeData ? { removeData: true } : {}) };
      if (plan.problem !== null) {
        await chooseWithDetails(terminal, failureLabel(task), ['返回'], describeDiagnostic({ code: plan.problem }));
        continue;
      }
      if (problems.size) {
        const problemIndex = entries.findIndex(entry => problems.has(entry.item.id));
        focus[task] = Math.max(
          0,
          problemIndex >= 0 ? problemIndex : removeClaudeData && problems.has(CLAUDE_DATA_ID) ? entries.length : 0,
        );
        continue;
      }
      if (task !== 'install') {
        const preview = plan.items
          .map(
            item =>
              `${planVerb(item)} ${contentName(item)}\n${item.problem ? `  ${PROBLEM_MARK}${reason(item.problem)}` : item.changes.map(change => `  · ${describeChange(change)}`).join('\n')}`,
          )
          .join('\n');
        const confirm = await terminal.choose(
          `变更预览\n${preview}`,
          [task === 'clean' ? '确认清理' : '确认卸载', '返回修改'],
          1,
        );
        if (confirm !== 0) continue;
      }
      const presentation = createRunPresentation(plan, taskAction);
      terminal.show(presentation.progress());
      const result = await ccw.apply(plan.id, signal, event => {
        terminal.show(presentation.progress(event));
      });
      view = null;
      for (const item of result.items) {
        if (item.state !== 'done' && item.isPending !== false) continue;
        if (item.id === CLAUDE_DATA_ID) removeClaudeData = false;
        else selected().delete(item.id);
      }
      const dataRemaining =
        removeClaudeData && result.items.some(item => item.id === CLAUDE_DATA_ID && item.isPending === true);
      pending = result.remaining
        ? { task, remaining: result.remaining, ...(dataRemaining ? { removeData: true } : {}) }
        : undefined;
      reconcile();
      const resultView = presentation.result(result);
      let resultFocus = 1;
      let detailFocus = 0;
      while (!signal?.aborted) {
        const next = await terminal.choose(
          resultView,
          [hasSelection() && result.remaining ? '重试未完成项' : '返回列表', BACK_TO_HOME, '查看详情'],
          resultFocus,
          1,
        );
        if (next !== 2) {
          if (next === 1) returnToMenu = true;
          break;
        }
        resultFocus = next;
        let item = result.items[0];
        if (result.items.length > 1) {
          detailFocus = await terminal.choose(
            '选择结果',
            [
              ...result.items.map(item => {
                const row = resultView.rows.find(candidate => candidate.id === item.id);
                return {
                  label: row?.title ?? contentName(item),
                  detail: row?.status ?? '',
                };
              }),
              '返回',
            ],
            Math.min(detailFocus, result.items.length - 1),
          );
          item = result.items[detailFocus];
        }
        if (item) await terminal.choose(presentation.details(result, item.id), ['返回']);
        else if (!result.items.length) await terminal.choose('结果详情\n本次没有条目记录', ['返回']);
      }
    }
  }
}
