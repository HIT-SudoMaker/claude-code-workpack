import type { Ccw, Item, Pick, Request } from './ccw.js';
import { errorCode } from './machine.js';
import { apiConfigurationProblem } from './settings.js';
import {
  HOME_TITLE,
  BACK_TO_HOME,
  contentRow,
  contentOrder,
  describeInspection,
  describeChange,
  describePreparation,
  describeRun,
  describePlan,
  MODEL_FIELDS,
  DEFAULT_PREFERENCES,
  effectiveConnection,
  SETTINGS_EDITORS,
  SETTINGS_LANGUAGES,
  SETTINGS_STYLES,
  settingsRow,
  reason,
  createRunPresentation,
} from './render.js';
import type { MenuRow, RunView, SettingsEditor } from './render.js';

const HOME_ACTIONS = [
  { label: '安装配置', id: 'install' },
  { label: '检查状态', id: 'inspect' },
  { label: '移除程序', id: 'uninstall' },
  { label: '清理数据', id: 'clean' },
  { label: '退出程序', id: 'exit' },
] as const;

const TASK_TEXT = {
  install: { title: '安装配置', empty: '没有可配置项目', confirm: '确认安装' },
  uninstall: {
    title: '移除程序\n保留会话记录和个人文件，移除所选接入配置',
    empty: '没有可移除项目',
    confirm: '确认移除',
  },
  clean: {
    title: '清理数据\n删除所选数据，保留程序、配置与凭据',
    empty: '没有可清理数据',
    confirm: '确认清理',
  },
} as const;

interface SelectionEntry {
  readonly item: Item;
  readonly key: string;
  readonly editor?: SettingsEditor;
}

/** 多选页面的显示快照，勾选状态由调用方维护 */
export interface SelectionPage {
  readonly title: string;
  readonly rows: readonly (MenuRow & {
    readonly checked: boolean;
    readonly editable?: boolean;
  })[];
  readonly submitLabel: string;
  readonly focus?: number;
}

/** 切换单行或整页勾选状态的事件 */
export type SelectionChange = { readonly kind: 'toggle'; readonly index: number } | { readonly kind: 'all' };

/** 表单字段的初始值和显示属性；secret 只控制输入的遮蔽显示 */
export interface FormField {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly secret?: boolean;
  readonly placeholder?: string;
}

/** 表单校验结果；null 表示通过，field 用于定位未通过的字段 */
export type FormProblem = { readonly message: string; readonly field: string } | null;

/**
 * 交互终端的页面、输入与外部命令交接能力
 *
 * @remarks 等待输入的方法须依次调用，不能并行打开页面；等待期间终端关闭、渲染失败或重复等待输入会拒绝 Promise
 */
export interface Terminal {
  /**
   * 显示等待页并运行可取消任务
   *
   * @param work - 接收页面专用取消信号和可选进度更新函数；离开页面后忽略迟到结果
   * @param signal - 外部取消信号，已取消时不启动任务
   * @returns 任务结果；Esc 或信号取消返回 null
   * @throws Error - 未取消时任务失败会拒绝 Promise
   * @remarks 不限制任务的读写能力；取消只发出停止信号，不等待任务结束或回滚已有效果
   */
  wait<T>(
    title: string,
    work: (signal: AbortSignal, update?: (message: string) => void) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | null>;
  /**
   * 显示菜单并等待确认或返回
   *
   * @param choices - 至少包含一个选项
   * @param defaultIndex - 初始焦点，省略时为首项
   * @param options - 显式选择首页布局，不从标题文案推断
   * @returns 确认项的索引，取消时返回最后一项
   */
  choose(
    title: string,
    choices: readonly (string | MenuRow)[],
    defaultIndex?: number,
    options?: { readonly home?: boolean },
  ): Promise<number>;
  /**
   * 原地编辑整页字段，校验失败时保留输入并定位字段
   *
   * @param validate - 提交时校验当前字段，返回 null 才交付结果
   * @returns 通过校验的字段值；取消返回 null，不交付草稿
   * @remarks secret 字段在屏幕上遮蔽，返回值仍含原文，调用方须避免将其写入公开结果或日志
   */
  form(
    title: string,
    fields: readonly FormField[],
    validate: (values: Readonly<Record<string, string>>) => FormProblem,
  ): Promise<Record<string, string> | null>;
  /**
   * 暂停已启动的界面并释放终端输入，供外部交互命令使用
   *
   * @returns work 的结果；work 失败时恢复界面后继续拒绝 Promise
   * @remarks 仅在执行屏活动且无待决输入时调用；交接期间用 show 缓存进度
   * work 结束后恢复界面；恢复失败也会拒绝 Promise，不回滚命令效果
   */
  handoff<T>(work: () => Promise<T>): Promise<T>;
  /**
   * 显示多选页面，将勾选变化同步交给调用方更新
   *
   * @param change - 更新调用方草稿并同步返回新页面
   * @returns 提交、取消或请求编辑的行索引；勾选状态由调用方通过 change 维护
   * @remarks 默认焦点为首项；page.focus 可恢复编辑前所在行
   */
  select(
    page: SelectionPage,
    change: (event: SelectionChange) => SelectionPage,
  ): Promise<'submit' | 'cancel' | { readonly kind: 'edit'; readonly index: number }>;
  /** 无待决输入时更新执行视图；终端交接期间保存视图，恢复后重放 */
  show(view: RunView): void;
}

/**
 * 驱动主菜单、配置草稿、变更预览和确认后的执行
 *
 * @param signal - 传递给检查、计划准备与执行；取消不会唤醒正在等待输入的菜单或表单
 * @param details - 在检查、预览、执行结果和操作失败说明中附带原因码
 * @remarks 只有用户确认预览后才调用 apply；取消不回滚已执行变更，终端由调用方关闭
 * @throws Error - 未在操作页处理的终端或检查失败会拒绝 Promise
 */
export async function runTerminal(ccw: Ccw, terminal: Terminal, signal?: AbortSignal, details = false) {
  while (!signal?.aborted) {
    const choice = await terminal.choose(
      HOME_TITLE,
      HOME_ACTIONS.map(action => action.label),
      0,
      {
        home: true,
      },
    );
    const action = HOME_ACTIONS[choice]?.id;
    if (action === undefined || action === 'exit' || signal?.aborted) return;
    const inspection = await terminal.wait(
      '检查状态',
      reading => ccw.inspect(reading, action === 'clean' ? 'data' : 'contents'),
      signal,
    );
    if (!inspection || signal?.aborted) continue;
    if (action === 'inspect') {
      await terminal.choose('检查状态\n' + describeInspection(inspection, details), [BACK_TO_HOME]);
      continue;
    }
    const task: Request['task'] = action;
    const text = TASK_TEXT[task];
    const items = contentOrder(inspection.items).filter(item =>
      task === 'install'
        ? item.canInstall === true
        : task === 'clean'
          ? item.canClean === true
          : !item.skillSet && item.canUninstall === true,
    );
    const unavailable = {
      items: inspection.items.filter(item => item.problem && !items.includes(item)),
      problems: inspection.problems,
    };
    const inspectionNotice =
      unavailable.items.length || unavailable.problems.length
        ? '\n以下项目检查未完成或暂不可操作\n' + describeInspection(unavailable, details)
        : '';
    if (!items.length) {
      await terminal.choose(inspectionNotice || text.empty, [BACK_TO_HOME]);
      continue;
    }
    const entries = items.flatMap<SelectionEntry>(item =>
      task === 'install' && item.kind === 'settings'
        ? SETTINGS_EDITORS.map(editor => ({ item, editor, key: item.id + '/' + editor }))
        : [{ item, key: item.id }],
    );
    const selected = new Map<string, Pick>();
    const drafts = new Map<string, Pick>();
    const remember = (key: string, pick: Pick) => {
      drafts.set(key, pick);
      selected.set(key, pick);
    };
    let focus = 0;
    let finished = false;
    while (!finished && !signal?.aborted) {
      const page = (): SelectionPage => ({
        title: text.title + inspectionNotice,
        submitLabel: '查看变更 · ' + selected.size + ' 项',
        focus,
        rows: entries.map(entry => {
          const draft = drafts.get(entry.key);
          const row = entry.editor ? settingsRow(entry.item, entry.editor, draft?.fields) : contentRow(entry.item);
          return {
            ...row,
            checked: selected.has(entry.key),
            editable: entry.editor !== undefined,
          };
        }),
      });
      const response = await terminal.select(page(), event => {
        const targets = (event.kind === 'all' ? entries : [entries[event.index]]).filter(entry => entry !== undefined);
        const selectAll = event.kind === 'all' && targets.some(entry => !selected.has(entry.key));
        for (const entry of targets) {
          if (event.kind === 'all' ? selectAll : !selected.has(entry.key))
            selected.set(entry.key, drafts.get(entry.key) ?? { id: entry.item.id });
          else selected.delete(entry.key);
        }
        return page();
      });
      if (response === 'cancel') break;
      if (typeof response === 'object') {
        focus = response.index;
        const entry = entries[response.index];
        if (entry?.editor) {
          const pick = await configure(entry.item, entry.editor, terminal, drafts.get(entry.key));
          if (pick) remember(entry.key, pick);
        }
        continue;
      }
      if (!selected.size) continue;
      if (task === 'install') {
        let cancelled = false;
        for (const entry of entries.filter(entry => selected.has(entry.key))) {
          const { item, key, editor } = entry;
          if (editor && !selected.get(key)?.fields) {
            const pick = savedSelection(item, editor) ?? (await configure(item, editor, terminal, drafts.get(key)));
            if (!pick) {
              cancelled = true;
              break;
            }
            remember(key, pick);
          }
        }
        if (cancelled) continue;
      }
      try {
        const plan = await terminal.wait(
          '准备变更',
          (reading, update) =>
            ccw.plan({ task, selected: mergeSelections(selected.values()) }, reading, event =>
              update?.(describePreparation(event)),
            ),
          signal,
        );
        if (!plan) continue;
        const blocked = !!plan.problem || plan.items.every(item => item.problem !== null);
        const confirm = await terminal.choose(
          '变更预览\n' + describePlan(plan, details),
          blocked ? ['返回修改'] : [text.confirm, '返回修改'],
          blocked ? 0 : 1,
        );
        if (blocked || confirm !== 0) continue;
        const presentation = createRunPresentation(plan, task, details);
        terminal.show(presentation.progress());
        const result = await ccw.apply(plan.id, signal, event => terminal.show(presentation.progress(event)));
        await terminal.choose(describeRun(presentation.result(result)), [BACK_TO_HOME]);
        finished = true;
      } catch (error) {
        if (signal?.aborted) return;
        await terminal.choose('操作失败：' + describeChange({ code: errorCode(error) }, details), ['返回修改']);
      }
    }
  }
}

function savedSelection(item: Item, editor: SettingsEditor): Pick | undefined {
  const values = item.values ?? {};
  if (item.problem) return;
  if (editor !== 'connection')
    return { id: item.id, fields: { [editor]: values[editor] ?? DEFAULT_PREFERENCES[editor] } };
  if (
    values.mode === 'official' ||
    (effectiveConnection(values, item.facts) === 'api' &&
      apiConfigurationProblem(values.baseUrl, item.hasCredential === true) === null)
  )
    return { id: item.id, fields: {} };
}

async function configure(item: Item, editor: SettingsEditor, terminal: Terminal, prior?: Pick): Promise<Pick | null> {
  const values = { ...item.values, ...prior?.fields };
  if (editor !== 'connection') {
    const choices = editor === 'language' ? SETTINGS_LANGUAGES : SETTINGS_STYLES;
    const current = values[editor] ?? DEFAULT_PREFERENCES[editor];
    const index = await terminal.choose(
      editor === 'language' ? '默认语言' : '输出风格',
      [...choices.map(choice => choice.label), '返回'],
      Math.max(
        0,
        choices.findIndex(choice => choice.value === current),
      ),
    );
    const choice = choices[index];
    return choice ? { id: item.id, fields: { [editor]: choice.value } } : null;
  }
  const mode = await terminal.choose(
    '模型配置',
    ['官方登录', '第三方 API', '返回'],
    effectiveConnection(values, item.facts) === 'api' ? 1 : 0,
  );
  if (mode === 2) return null;
  if (mode === 0)
    return {
      id: item.id,
      fields: {
        mode: 'official',
        login: 'yes',
      },
    };
  const kept = item.hasCredential === true;
  const fields = await terminal.form(
    '第三方 API',
    [
      { key: 'baseUrl', label: 'Base URL', value: values.baseUrl ?? '' },
      {
        key: 'secret',
        label: 'API Key',
        value: prior?.fields?.secret ?? '',
        secret: true,
        placeholder: kept ? '留空保留现有凭据' : '必填',
      },
      ...MODEL_FIELDS.map(field => ({
        key: field.key,
        label: field.label,
        value: values[field.key] ?? '',
        placeholder: '选填',
      })),
    ],
    value => {
      const problem = apiConfigurationProblem(value.baseUrl, !!value.secret?.trim() || kept);
      return problem
        ? { message: reason(problem), field: problem === 'credential-required' ? 'secret' : 'baseUrl' }
        : null;
    },
  );
  return fields
    ? {
        id: item.id,
        fields: {
          ...fields,
          mode: 'api',
          auth: fields.secret?.trim() ? 'key' : (values.auth ?? 'key'),
        },
      }
    : null;
}

function mergeSelections(selections: Iterable<Pick>): Pick[] {
  const merged = new Map<string, Pick>();
  for (const selection of selections) {
    const prior = merged.get(selection.id);
    merged.set(selection.id, {
      id: selection.id,
      ...(prior?.fields || selection.fields ? { fields: { ...prior?.fields, ...selection.fields } } : {}),
    });
  }
  return [...merged.values()];
}
