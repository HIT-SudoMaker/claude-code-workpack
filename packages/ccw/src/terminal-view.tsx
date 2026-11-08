import os from 'node:os';

import { Box, Text, render, useAnimation, useApp, useInput, usePaste, useWindowSize } from 'ink';
import type { Instance, Key, SuspendTerminal, WindowSize } from 'ink';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

import { BRAND, HOME_TITLE, safeText } from './render.js';
import type { MenuRow } from './render.js';
import type { RunDetail, RunRow, RunTone, RunView } from './run-presentation.js';
import type { FormField, FormProblem, SelectionChange, SelectionPage, Terminal } from './terminal.js';

const ACCENT = '#D97757';
type SelectionResult = Awaited<ReturnType<Terminal['select']>>;
interface InputEvent {
  readonly input: string;
  readonly key: Key;
}

function isExit({ input, key }: InputEvent) {
  return key.ctrl && input === 'c';
}

function HomeHeader({ size }: { readonly size: WindowSize }) {
  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const system = `${platform} (${os.arch()})`;
  return (
    <Box flexDirection="column">
      <Text color={ACCENT}>{'═'.repeat(Math.min(62, size.columns))}</Text>
      {size.rows >= 28 && <Text> </Text>}
      {size.rows >= 20 && size.columns >= 30 ? (
        BRAND.logo.map((line, index) => <Text key={index} color={ACCENT} bold>{`  ${line}`}</Text>)
      ) : (
        <Text color={ACCENT} bold>
          {' '}
          CCW
        </Text>
      )}
      {size.rows >= 28 && <Text> </Text>}
      <Text bold wrap="truncate-end">
        {' '}
        {BRAND.title} <Text dimColor>{BRAND.version}</Text>
      </Text>
      <Text dimColor> {BRAND.credit}</Text>
      {size.rows >= 24 ? (
        <>
          <Text color={ACCENT}>{'─'.repeat(Math.min(62, size.columns))}</Text>
          <Text bold> 当前环境状态</Text>
          <Text> 1. 系统 {system}</Text>
          <Text> 2. Node {process.version}</Text>
          <Text wrap="truncate-end"> 3. 主目录 {safeText(os.homedir())}</Text>
        </>
      ) : (
        <>
          <Text dimColor>{`  ${system} · Node ${process.version}`}</Text>
          <Text dimColor wrap="truncate-end">
            {' '}
            {safeText(os.homedir())}
          </Text>
        </>
      )}
      <Text color={ACCENT}>{'═'.repeat(Math.min(62, size.columns))}</Text>
      <Text bold>请选择：</Text>
    </Box>
  );
}

interface FrameProps {
  readonly title: string;
  readonly footer: string;
  readonly page?: number;
  readonly children: (height: number, width: number) => ReactNode;
}

function Frame({ title, footer, page = 0, children }: FrameProps) {
  const terminalSize = useWindowSize();
  const size = { columns: Math.max(8, terminalSize.columns - 1), rows: Math.max(10, terminalSize.rows) };
  const [name = '', ...body] = safeText(title).split('\n');
  const details = useMemo(
    () => wrapAnsi(body.join('\n'), size.columns, { hard: true, trim: false }).split('\n').filter(Boolean),
    [title, size.columns],
  );
  const detailHeight = Math.min(Math.max(3, Math.floor(size.rows / 3) - 1), details.length);
  const offset = Math.min(page * Math.max(1, detailHeight), Math.max(0, details.length - detailHeight));
  const hasPages = details.length > detailHeight;
  const isHome = title === HOME_TITLE;
  const headerHeight = isHome
    ? 5 + (size.rows >= 28 ? 2 : 0) + (size.rows >= 20 && size.columns >= 30 ? 6 : 1) + (size.rows >= 24 ? 5 : 2)
    : 3 + detailHeight + (hasPages ? 1 : 0);
  const height = Math.max(1, size.rows - headerHeight - 4);
  return (
    <Box flexDirection="column" width={size.columns} height={size.rows - 1}>
      {isHome ? (
        <HomeHeader size={size} />
      ) : (
        <>
          <Box borderStyle="double" borderColor={ACCENT} width={Math.min(62, size.columns)} paddingX={1} flexShrink={0}>
            <Text bold color={ACCENT} wrap="truncate-end">
              CCW · {name}
            </Text>
          </Box>
          {details.slice(offset, offset + detailHeight).map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
          {hasPages && (
            <Text dimColor>
              PgUp/PgDn · {offset + 1}–{offset + detailHeight}/{details.length}
            </Text>
          )}
        </>
      )}
      <Box flexDirection="column" height={height} marginTop={1} flexShrink={0}>
        {children(height, size.columns)}
      </Box>
      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {footer}
        </Text>
      </Box>
    </Box>
  );
}

interface MenuState {
  readonly index: number;
  readonly page: number;
  readonly selection?: SelectionPage;
  readonly result?: SelectionResult;
}
interface MenuProps {
  readonly title: string;
  readonly choices: readonly (string | MenuRow)[];
  readonly focus: number;
  readonly selection?: SelectionPage;
  readonly change?: (event: SelectionChange) => SelectionPage;
  readonly interrupt: () => void;
  readonly done: (result: SelectionResult) => void;
}

function Menu({ title, choices, focus, selection, change, interrupt, done }: MenuProps) {
  const initialCount = selection ? selection.rows.length + 2 : choices.length;
  const live = useRef<MenuState>({
    index: Math.max(0, Math.min(focus, initialCount - 1)),
    page: 0,
    ...(selection ? { selection } : {}),
  });
  const [state, setState] = useState(live.current);
  useInput((input, key) => {
    const prior = live.current;
    if (prior.result) return;
    const event = { input, key };
    let next = prior;
    const current = prior.selection;
    const row = current?.rows[prior.index];
    const count = current ? current.rows.length + 2 : choices.length;
    const toggle = () => (change ? { ...prior, selection: change({ kind: 'toggle', index: prior.index }) } : prior);
    if (isExit(event)) interrupt();
    if (key.escape || isExit(event)) next = { ...prior, result: { kind: 'cancel', index: prior.index } };
    else if (key.upArrow || key.downArrow)
      next = { ...prior, index: (prior.index + count + (key.upArrow ? -1 : 1)) % count };
    else if (key.pageDown || key.pageUp) next = { ...prior, page: Math.max(0, prior.page + (key.pageUp ? -1 : 1)) };
    else if (key.return)
      next =
        row?.enter === 'toggle'
          ? toggle()
          : {
              ...prior,
              result: {
                kind: !current || row ? 'open' : prior.index === current.rows.length ? 'submit' : 'cancel',
                index: prior.index,
              },
            };
    else if (current && input.toLowerCase() === 'r')
      next = { ...prior, result: { kind: 'refresh', index: prior.index } };
    else if (current && change && input.toLowerCase() === 'a') next = { ...prior, selection: change({ kind: 'all' }) };
    else if (row && input === ' ') next = toggle();
    if (next.selection && !next.result) next = { ...next, index: Math.min(next.index, next.selection.rows.length + 1) };
    live.current = next;
    setState(next);
  });
  useEffect(() => {
    if (state.result) done(state.result);
  }, [state.result, done]);
  const rows = useMemo(() => {
    const result: { label: string; detail: string; index: number | null; labelWidth: number }[] = [];
    const labels =
      state.selection?.rows ?? choices.map(choice => (typeof choice === 'string' ? { label: choice } : choice));
    const labelWidth = Math.max(0, ...labels.filter(row => row.detail).map(row => stringWidth(row.label)));
    let previous: string | undefined;
    for (const [index, choice] of labels.entries()) {
      const group = choice.group;
      if (group && group !== previous) result.push({ label: group, detail: '', index: null, labelWidth: 0 });
      previous = group;
      result.push({
        label: choice.label,
        detail: choice.detail ?? '',
        index,
        labelWidth: choice.detail ? labelWidth : 0,
      });
    }
    if (state.selection)
      result.push(
        { label: state.selection.submitLabel, detail: '', index: labels.length, labelWidth: 0 },
        { label: '返回主菜单', detail: '', index: labels.length + 1, labelWidth: 0 },
      );
    return result;
  }, [choices, state.selection]);
  const currentRow = state.selection?.rows[state.index];
  const enter =
    currentRow?.enter === 'toggle'
      ? '勾选'
      : currentRow?.enter === 'edit'
        ? '编辑'
        : currentRow
          ? '详情'
          : state.index === state.selection?.rows.length
            ? '提交'
            : '返回';
  const footer = state.selection
    ? `空格勾选 · A 全选普通项 · R 刷新 · Enter ${enter} · Esc 返回`
    : '↑↓ 移动 · Enter 选择 · Esc 返回';
  return (
    <Frame title={state.selection?.title ?? title} page={state.page} footer={footer}>
      {(height, width) => {
        const activeRow = Math.max(
          0,
          rows.findIndex(row => row.index === state.index),
        );
        const start = Math.max(0, Math.min(activeRow - Math.floor(height / 2), rows.length - height));
        return rows.slice(start, start + height).map((row, position) => {
          if (row.index === null) {
            const label = `  ── ${safeText(row.label)} `;
            return (
              <Text key={`heading-${start + position}`} color={ACCENT} dimColor wrap="truncate-end">
                {label}
                {'─'.repeat(Math.max(0, Math.min(62, width) - stringWidth(label)))}
              </Text>
            );
          }
          const active = row.index === state.index;
          const selectedRow = state.selection?.rows[row.index];
          const prefix = `${active ? '›' : ' '} ${selectedRow ? (selectedRow.checked ? '[x] ' : '[ ] ') : ''}`;
          return (
            <Box key={row.index} flexShrink={0}>
              <Text {...(active ? { color: ACCENT } : {})} bold={active}>
                {prefix}
              </Text>
              <Box
                width={
                  row.detail ? Math.min(row.labelWidth + 2, Math.max(10, width - 24)) : width - stringWidth(prefix)
                }
                flexShrink={0}
              >
                <Text {...(active ? { color: ACCENT } : {})} bold={active} wrap="truncate-end">
                  {safeText(row.label).replaceAll('\n', ' ')}
                </Text>
              </Box>
              {row.detail && (
                <Text {...(active ? { color: ACCENT } : {})} dimColor={!active} wrap="truncate-end">
                  {safeText(row.detail)}
                </Text>
              )}
            </Box>
          );
        });
      }}
    </Frame>
  );
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const characters = (text: string) => Array.from(segmenter.segment(text), part => part.segment);
interface EditState {
  readonly text: readonly string[];
  readonly cursor: number;
}
type EditEvent = InputEvent | { readonly paste: string };

function editText(prior: EditState, event: EditEvent): EditState {
  if ('key' in event) {
    const { key, input } = event;
    if (key.ctrl && input === 'u') return { text: [], cursor: 0 };
    if (key.leftArrow || key.rightArrow)
      return { ...prior, cursor: Math.max(0, Math.min(prior.text.length, prior.cursor + (key.leftArrow ? -1 : 1))) };
    if (key.home || key.end) return { ...prior, cursor: key.home ? 0 : prior.text.length };
    if (key.backspace && prior.cursor > 0)
      return { text: prior.text.filter((_part, index) => index !== prior.cursor - 1), cursor: prior.cursor - 1 };
    if (key.delete) return { ...prior, text: prior.text.filter((_part, index) => index !== prior.cursor) };
    if (key.ctrl || key.meta || key.tab) return prior;
  }
  const added = characters(safeText('paste' in event ? event.paste : event.input).replaceAll('\n', ' '));
  if (!added.length) return prior;
  return {
    text: [...prior.text.slice(0, prior.cursor), ...added, ...prior.text.slice(prior.cursor)],
    cursor: prior.cursor + added.length,
  };
}

function InlineForm({
  title,
  fields,
  validate,
  interrupt,
  done,
}: {
  readonly title: string;
  readonly fields: readonly FormField[];
  readonly validate: (values: Readonly<Record<string, string>>) => FormProblem;
  readonly interrupt: () => void;
  readonly done: (values: Record<string, string> | null) => void;
}) {
  const live = useRef<{
    index: number;
    edits: readonly EditState[];
    problem: FormProblem;
    details: boolean;
    page: number;
    finished: boolean;
  }>({
    index: 0,
    edits: fields.map(field => ({ text: characters(field.value), cursor: characters(field.value).length })),
    problem: null,
    details: false,
    page: 0,
    finished: false,
  });
  const [state, setState] = useState(live.current);
  const dispatch = (event: EditEvent) => {
    const prior = live.current;
    if (prior.finished) return;
    if (prior.details) {
      let next = prior;
      if ('key' in event && (event.key.escape || event.key.return)) next = { ...prior, details: false };
      else if ('key' in event && (event.key.pageUp || event.key.pageDown))
        next = { ...prior, page: Math.max(0, prior.page + (event.key.pageUp ? -1 : 1)) };
      else if ('key' in event && isExit(event)) {
        live.current = { ...prior, finished: true };
        interrupt();
        done(null);
        return;
      }
      live.current = next;
      setState(next);
      return;
    }
    let next = prior;
    if ('key' in event && (event.key.escape || isExit(event))) {
      live.current = { ...prior, finished: true };
      if (isExit(event)) interrupt();
      done(null);
      return;
    }
    if (
      'key' in event &&
      (event.key.upArrow || event.key.downArrow || event.key.tab || (event.key.return && prior.index < fields.length))
    ) {
      const direction = event.key.upArrow || (event.key.tab && event.key.shift) ? -1 : 1;
      const count = fields.length + 2 + Number(Boolean(prior.problem?.detail));
      next = { ...prior, index: (prior.index + count + direction) % count };
    } else if ('key' in event && event.key.return) {
      if (prior.index === fields.length + 2 && prior.problem?.detail) {
        live.current = { ...prior, details: true, page: 0 };
        setState(live.current);
        return;
      }
      if (prior.index === fields.length + 1) {
        live.current = { ...prior, finished: true };
        done(null);
        return;
      }
      const values = Object.fromEntries(
        fields.map((field, index) => [field.key, prior.edits[index]?.text.join('') ?? '']),
      );
      const problem = validate(values);
      if (!problem) {
        live.current = { ...prior, finished: true };
        done(values);
        return;
      }
      next = {
        ...prior,
        problem,
        index: Math.max(
          0,
          fields.findIndex(field => field.key === problem.field),
        ),
      };
    } else if (prior.index < fields.length) {
      next = {
        ...prior,
        problem: null,
        edits: prior.edits.map((edit, index) => (index === prior.index ? editText(edit, event) : edit)),
      };
    }
    live.current = next;
    setState(next);
  };
  useInput((input, key) => dispatch({ input, key }));
  usePaste(paste => dispatch({ paste }));
  if (state.details)
    return (
      <Frame
        title={`填写说明\n${state.problem?.detail ?? ''}`}
        page={state.page}
        footer="PgUp/PgDn 翻页 · Enter/Esc 返回"
      >
        {() => <Text color={ACCENT}>› 返回编辑</Text>}
      </Frame>
    );
  return (
    <Frame
      title={`${title}${state.problem ? `\n! ${state.problem.message}` : ''}`}
      footer={state.index < fields.length ? '输入/粘贴 · ↑↓/Tab 切换 · Esc 取消' : '↑↓ 选择 · Enter 确认 · Esc 取消'}
    >
      {(height, width) => {
        const labels = [
          ...fields.map(field => field.label),
          '保存配置',
          '返回',
          ...(state.problem?.detail ? ['查看详情'] : []),
        ];
        const start = Math.max(0, Math.min(state.index - Math.floor(height / 2), labels.length - height));
        return labels.slice(start, start + height).map((label, offset) => {
          const index = start + offset;
          const active = index === state.index;
          const field = fields[index];
          const edit = state.edits[index];
          const value = field && edit ? (field.secret ? '•'.repeat(edit.text.length) : edit.text.join('')) : '';
          let display = value || field?.placeholder || '';
          if (active && edit) {
            const before = field?.secret ? '•'.repeat(edit.cursor) : edit.text.slice(0, edit.cursor).join('');
            const after = field?.secret
              ? '•'.repeat(edit.text.length - edit.cursor)
              : edit.text.slice(edit.cursor).join('');
            display = `${
              wrapAnsi(before, Math.max(1, width - 20), { hard: true, trim: false })
                .split('\n')
                .at(-1) ?? ''
            }▏${after || (!value ? (field?.placeholder ?? '') : '')}`;
          }
          return (
            <Text key={label} {...(active ? { color: ACCENT } : {})} wrap="truncate-end">
              {active ? '› ' : '  '}
              {label.padEnd(15)}
              {safeText(display)}
            </Text>
          );
        });
      }}
    </Frame>
  );
}

function Waiting({
  title,
  message = '检查环境',
  cancel,
  interrupt,
}: {
  readonly title: string;
  readonly message?: string;
  readonly cancel: () => void;
  readonly interrupt: () => void;
}) {
  const { frame } = useAnimation({ interval: 120 });
  useInput((input, key) => {
    if (key.escape || isExit({ input, key })) {
      cancel();
      if (isExit({ input, key })) interrupt();
    }
  });
  return (
    <Frame title={title} footer="Esc 取消 · Ctrl+C 退出">
      {() => (
        <Text color={ACCENT}>
          {['⠋', '⠙', '⠹', '⠸'][frame % 4]} {safeText(message)}
        </Text>
      )}
    </Frame>
  );
}

function toneColor(tone: RunTone) {
  if (tone === 'accent') return ACCENT;
  if (tone === 'success') return 'green';
  if (tone === 'danger') return 'red';
  if (tone === 'warning') return 'yellow';
  return undefined;
}

function StatusRow({ row, text }: { readonly row: RunRow; readonly text?: string }) {
  const color = toneColor(row.tone);
  const name = safeText(row.title).replaceAll('\n', ' ');
  if (text !== undefined)
    return (
      <Text {...(color ? { color } : {})} dimColor={row.tone === 'muted'}>
        {text}
      </Text>
    );
  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <Text {...(color ? { color } : {})} dimColor={row.tone === 'muted'}>
          {row.symbol}
        </Text>
      </Box>
      <Box width={10} flexShrink={0}>
        <Text {...(color ? { color } : {})} dimColor={row.tone === 'muted'}>
          {row.status}
        </Text>
      </Box>
      <Text wrap="truncate-end">{name}</Text>
    </Box>
  );
}

function DetailRow({ detail, width }: { readonly detail: RunDetail; readonly width: number }) {
  const color = toneColor(detail.tone);
  const indent = width < 24 ? 2 : 12;
  return (
    <Box marginLeft={indent}>
      {detail.symbol && (
        <Box width={2} flexShrink={0}>
          <Text {...(color ? { color } : {})} dimColor={detail.tone === 'muted'}>
            {detail.symbol}
          </Text>
        </Box>
      )}
      <Text dimColor={detail.tone === 'muted'} wrap="truncate-end">
        {safeText(detail.text)}
      </Text>
    </Box>
  );
}

type RunLine =
  | { readonly kind: 'status'; readonly row: RunRow; readonly text?: string }
  | { readonly kind: 'detail'; readonly id: string; readonly detail: RunDetail };

function runLines(view: RunView, width: number): readonly RunLine[] {
  return view.rows.flatMap(row => {
    const status: RunLine[] =
      width < 24
        ? wrapAnsi(`${row.symbol} ${row.status}  ${safeText(row.title)}`, width, { hard: true, trim: false })
            .split('\n')
            .map(text => ({ kind: 'status', row, text }))
        : [{ kind: 'status', row }];
    return [
      ...status,
      ...row.details.flatMap(detail => {
        const { symbol, ...appearance } = detail;
        const indent = width < 24 ? 2 : 12;
        return wrapAnsi(safeText(detail.text), Math.max(1, width - indent - (symbol ? 2 : 0)), {
          hard: true,
          trim: false,
        })
          .split('\n')
          .map((text, index): RunLine => ({
            kind: 'detail',
            id: row.id,
            detail: { ...appearance, text, ...(symbol ? { symbol: index === 0 ? symbol : ' ' } : {}) },
          }));
      }),
    ];
  });
}

function RunScreen({
  view,
  choices = [],
  focus = 0,
  cancelIndex = choices.length - 1,
  interrupt,
  done,
}: {
  readonly view: RunView;
  readonly choices?: readonly (string | MenuRow)[];
  readonly focus?: number;
  readonly cancelIndex?: number;
  readonly interrupt: () => void;
  readonly done?: (index: number) => void;
}) {
  const [offset, setOffset] = useState<number | null>(null);
  const [action, setAction] = useState(Math.max(0, Math.min(focus, choices.length - 1)));
  const finished = useRef(false);
  const viewport = useRef({ offset: 0, height: 1, total: 1 });
  useInput((input, key) => {
    const exit = isExit({ input, key });
    if (exit) interrupt();
    if (choices.length && (key.escape || exit) && !finished.current) {
      finished.current = true;
      done?.(cancelIndex);
      return;
    }
    if (choices.length && (key.upArrow || key.downArrow))
      setAction(previous => (previous + choices.length + (key.upArrow ? -1 : 1)) % choices.length);
    if (choices.length && key.return && !finished.current) {
      finished.current = true;
      done?.(action);
      return;
    }
    if (key.pageUp) setOffset(previous => Math.max(0, (previous ?? viewport.current.offset) - viewport.current.height));
    if (key.pageDown)
      setOffset(previous =>
        Math.min(
          Math.max(0, viewport.current.total - viewport.current.height),
          (previous ?? viewport.current.offset) + viewport.current.height,
        ),
      );
    if (key.end) setOffset(null);
  });
  const footer = choices.length
    ? '↑↓ 选择 · Enter 确认 · PgUp/PgDn 翻页 · Esc 返回'
    : 'PgUp/PgDn 翻页 · End 跟随 · Ctrl+C 停止';
  return (
    <Frame title={view.title} footer={footer}>
      {(height, width) => {
        const lines = runLines(view, width);
        const actionHeight = choices.length ? choices.length + 1 : 0;
        const available = Math.max(1, height - 1 - actionHeight);
        const visible = Math.max(1, available - (lines.length > available ? 1 : 0));
        const current = Math.max(
          0,
          lines.findIndex(line => line.kind === 'status' && line.row.id === view.activeId),
        );
        const automatic = view.phase === 'result' ? 0 : Math.max(0, current - Math.floor(visible / 2));
        const start = Math.min(Math.max(0, lines.length - visible), offset ?? automatic);
        viewport.current = { offset: start, height: visible, total: lines.length };
        return (
          <Box flexDirection="column">
            <Text bold wrap="truncate-end">
              {safeText(view.summary)}
            </Text>
            {lines
              .slice(start, start + visible)
              .map((line, index) =>
                line.kind === 'status' ? (
                  <StatusRow
                    key={`${line.row.id}-status-${start + index}`}
                    row={line.row}
                    {...(line.text !== undefined ? { text: line.text } : {})}
                  />
                ) : (
                  <DetailRow key={`${line.id}-detail-${start + index}`} detail={line.detail} width={width} />
                ),
              )}
            {lines.length > visible && (
              <Text dimColor>
                {start + 1}–{Math.min(start + visible, lines.length)}/{lines.length}
              </Text>
            )}
            {choices.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                {choices.map((choice, index) => (
                  <Text key={index} {...(index === action ? { color: ACCENT } : {})} bold={index === action}>
                    {index === action ? '› ' : '  '}
                    {safeText(typeof choice === 'string' ? choice : `${choice.label} ${choice.detail ?? ''}`)}
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        );
      }}
    </Frame>
  );
}

function Host({
  children,
  ready,
}: {
  readonly children: ReactNode;
  readonly ready: (suspend: SuspendTerminal) => void;
}) {
  const { suspendTerminal } = useApp();
  useLayoutEffect(() => {
    ready(suspendTerminal);
  }, [ready, suspendTerminal]);
  return children;
}

async function pauseReading() {
  // Ink 使用 readable 模式，pause() 可能不发事件；通知 Node 停止底层读取后再交接
  process.stdin.pause();
  process.stdin.emit('pause');
  await new Promise<void>(resolve => process.nextTick(resolve));
}

/** 复用一个 Ink 实例切换页面，关闭时恢复终端；交接期间由外部命令使用终端 */
export function createTerminal(interrupt: () => void = () => {}): Terminal & { close(): Promise<void> } {
  let instance: Instance | undefined;
  let suspension: SuspendTerminal | undefined;
  let rejectPending: ((error: Error) => void) | undefined;
  let isSuspended = false;
  let progressView: RunView | undefined;
  let closed = false;
  let sequence = 0;
  const ready = (suspend: SuspendTerminal) => {
    suspension = suspend;
  };
  const display = (view: ReactNode) => {
    if (closed) throw new Error('terminal-closed');
    const tree = <Host ready={ready}>{view}</Host>;
    if (instance) instance.rerender(tree);
    else {
      instance = render(tree, {
        alternateScreen: true,
        incrementalRendering: true,
        maxFps: 30,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      void instance.waitUntilExit().then(
        () => {
          closed = true;
          rejectPending?.(new Error('terminal-closed'));
        },
        (error: unknown) => {
          closed = true;
          rejectPending?.(error instanceof Error ? error : new Error('terminal-failed', { cause: error }));
        },
      );
    }
  };
  const prompt = <T,>(view: (done: (result: T) => void) => ReactNode): Promise<T> => {
    if (rejectPending) return Promise.reject(new Error('terminal-prompt-in-progress'));
    return new Promise((resolve, reject) => {
      let settled = false;
      rejectPending = error => {
        if (!settled) {
          settled = true;
          rejectPending = undefined;
          reject(error);
        }
      };
      const done = (result: T) => {
        if (!settled) {
          settled = true;
          rejectPending = undefined;
          resolve(result);
        }
      };
      try {
        display(view(done));
      } catch (error) {
        rejectPending(error instanceof Error ? error : new Error('terminal-failed', { cause: error }));
      }
    });
  };
  return {
    choose(title, choices, focus = 0, cancelIndex = choices.length - 1) {
      return typeof title === 'string'
        ? prompt<number>(done => (
            <Menu
              key={++sequence}
              title={title}
              choices={choices}
              focus={focus}
              interrupt={interrupt}
              done={result => done(result.kind === 'cancel' ? cancelIndex : result.index)}
            />
          ))
        : prompt<number>(done => (
            <RunScreen
              key={++sequence}
              view={title}
              choices={choices}
              focus={focus}
              cancelIndex={cancelIndex}
              interrupt={interrupt}
              done={done}
            />
          ));
    },
    select(page, change, focus = 0) {
      return prompt<SelectionResult>(done => (
        <Menu
          key={++sequence}
          title={page.title}
          choices={[]}
          selection={page}
          change={change}
          focus={focus}
          interrupt={interrupt}
          done={done}
        />
      ));
    },
    form(title, fields, validate) {
      return prompt<Record<string, string> | null>(done => (
        <InlineForm
          key={++sequence}
          title={title}
          fields={fields}
          validate={validate}
          interrupt={interrupt}
          done={done}
        />
      ));
    },
    async wait<T>(
      title: string,
      work: (signal: AbortSignal, update?: (message: string) => void) => Promise<T>,
      signal?: AbortSignal,
      firstFrame?: string,
    ): Promise<T | null> {
      if (signal?.aborted) return null;
      const reading = new AbortController();
      let finish: (result: T | null) => void = () => {};
      const cancel = () => {
        reading.abort();
        finish(null);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      const key = ++sequence;
      const result = prompt<T | null>(done => {
        finish = done;
        return (
          <Waiting
            key={key}
            title={title}
            {...(firstFrame !== undefined ? { message: firstFrame } : {})}
            cancel={cancel}
            interrupt={interrupt}
          />
        );
      });
      const update = (message: string) => {
        if (!reading.signal.aborted)
          display(<Waiting key={key} title={title} message={message} cancel={cancel} interrupt={interrupt} />);
      };
      void Promise.resolve()
        .then(() => work(reading.signal, update))
        .then(finish, (error: unknown) => {
          if (!reading.signal.aborted)
            rejectPending?.(error instanceof Error ? error : new Error('inspection-failed', { cause: error }));
        });
      try {
        return await result;
      } finally {
        reading.abort();
        signal?.removeEventListener('abort', cancel);
      }
    },
    async handoff<T>(work: () => Promise<T>): Promise<T> {
      await instance?.waitUntilRenderFlush();
      if (!suspension) return work();
      await pauseReading();
      const ownership = await suspension();
      isSuspended = true;
      try {
        return await work();
      } finally {
        isSuspended = false;
        await ownership.resume();
        if (progressView !== undefined) display(<RunScreen view={progressView} interrupt={interrupt} />);
        // 快速任务可能在 readable 监听恢复前结束；重新启动读取但不消费输入
        process.stdin.read(0);
      }
    },
    show(view) {
      progressView = view;
      if (!isSuspended) display(<RunScreen view={view} interrupt={interrupt} />);
    },
    async close() {
      closed = true;
      rejectPending?.(new Error('terminal-closed'));
      await pauseReading();
      if (instance) {
        instance.unmount();
        await instance.waitUntilExit();
        instance.cleanup();
      }
    },
  };
}
