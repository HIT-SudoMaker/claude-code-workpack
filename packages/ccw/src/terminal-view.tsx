import os from 'node:os';
import { Box, Text, render, useInput, usePaste, useWindowSize, useApp } from 'ink';
import type { Instance, SuspendTerminal } from 'ink';
import { useState, useRef, useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import { BACK_TO_HOME, BRAND, safeText, statusLine } from './render.js';
import type { MenuRow, RunView } from './render.js';
import type { SelectionPage, SelectionChange, FormField, FormProblem, Terminal } from './terminal.js';

type SelectionResult = Awaited<ReturnType<Terminal['select']>>;

type MenuResult = { readonly kind: 'confirm' | 'cancel' | 'edit'; readonly index: number };

const ACCENT = '#D97757';
const BANNER_WIDTH = 62;
const MAX_RENDER_FPS = 30;
const LAYOUT = {
  minimumColumns: 8,
  minimumRows: 10,
  defaultContentRows: 8,
  menuPageOverheadRows: 10,
  labelMinimumColumns: 10,
  formDecorationColumns: 5,
  groupHeadingPaddingColumns: 3,
  headerRows: 3,
  footerRows: 3,
  sectionGapRows: 1,
  homeCreditRows: 18,
  homeExpandedRows: 24,
  homeLogoColumns: 32,
  homeFixedRows: 5,
  homeEnvironmentRows: 5,
} as const;

/**
 * 装配复用单个 Ink 实例的终端适配器，首次显示页面时才接管终端
 *
 * @param interrupt - 用户按 Ctrl+C 时调用的中断通知，不由适配器直接退出进程
 * @returns Terminal 实现及关闭方法；输入、取消与交接合同见 Terminal
 */
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
        maxFps: MAX_RENDER_FPS,
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
          rejectPending?.(asError(error, 'terminal-failed'));
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
        rejectPending(asError(error, 'terminal-failed'));
      }
    });
  };
  return {
    choose(title, choices, focus = 0, options) {
      return prompt<number>(done => (
        <Menu
          key={++sequence}
          title={title}
          choices={choices}
          focus={focus}
          home={options?.home ?? false}
          interrupt={interrupt}
          done={result => done(result.kind === 'cancel' ? choices.length - 1 : result.index)}
        />
      ));
    },
    select(page, change) {
      return prompt<SelectionResult>(done => (
        <Menu
          key={++sequence}
          title={page.title}
          choices={[]}
          selection={page}
          change={change}
          focus={page.focus ?? 0}
          interrupt={interrupt}
          done={result =>
            done(
              result.kind === 'edit'
                ? { kind: 'edit', index: result.index }
                : result.kind === 'cancel'
                  ? 'cancel'
                  : 'submit',
            )
          }
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
        return <Waiting key={key} title={title} cancel={cancel} interrupt={interrupt} />;
      });
      const update = (message: string) => {
        if (!reading.signal.aborted)
          display(<Waiting key={key} title={title} message={message} cancel={cancel} interrupt={interrupt} />);
      };
      void Promise.resolve()
        .then(() => work(reading.signal, update))
        .then(finish, (error: unknown) => {
          if (!reading.signal.aborted) rejectPending?.(asError(error, 'inspection-failed'));
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
        // 交互命令仅限执行屏活动期发起；恢复重放最近执行视图
        if (progressView !== undefined) display(<RunScreen view={progressView} interrupt={interrupt} />);
        // 快速任务可能在 readable 监听恢复前结束；重新启动读取但不消费输入
        process.stdin.read(0);
      }
    },
    show(view) {
      progressView = view;
      if (!isSuspended) display(<RunScreen view={view} interrupt={interrupt} />);
    },
    /** 终止待决输入并卸载界面；等待 Ink 退出和清理，失败时拒绝 Promise */
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

function Menu({
  title,
  choices,
  selection,
  change,
  focus,
  home = false,
  interrupt,
  done,
}: Readonly<{
  title: string;
  choices: readonly (string | MenuRow)[];
  selection?: SelectionPage;
  change?: (event: SelectionChange) => SelectionPage;
  focus: number;
  home?: boolean;
  interrupt: () => void;
  done: (result: MenuResult) => void;
}>) {
  const [page, setPage] = useState(selection);
  const rows = page ? [...page.rows, { label: page.submitLabel }, { label: BACK_TO_HOME }] : choices;
  const size = useWindowSize();
  const labelWidth = Math.max(0, ...rows.map(row => (typeof row === 'string' ? 0 : stringWidth(row.label))));
  const displayRows: { readonly row: MenuRow; readonly index: number | null }[] = [];
  let previousGroup: string | undefined;
  for (const [index, choice] of rows.entries()) {
    const row = typeof choice === 'string' ? { label: choice } : choice;
    if (row.group && row.group !== previousGroup) displayRows.push({ row: { label: '── ' + row.group }, index: null });
    displayRows.push({ row, index });
    previousGroup = row.group;
  }
  const [active, setActive] = useState(Math.max(0, Math.min(focus, rows.length - 1)));
  const activeRef = useRef(active);
  const move = (index: number) => {
    activeRef.current = index;
    setActive(index);
  };
  const [offset, setOffset] = useState(0);
  const toggle = (event: SelectionChange) => {
    if (change) setPage(change(event));
  };
  useInput((input, key) => {
    const index = activeRef.current;
    if (key.ctrl && input === 'c') {
      interrupt();
      done({ kind: 'cancel', index });
    } else if (key.escape) done({ kind: 'cancel', index });
    else if (key.pageDown || key.pageUp) {
      if (title.includes('\n')) setOffset(previous => Math.max(0, previous + (key.pageUp ? -1 : 1)));
      else
        move(
          Math.max(
            0,
            Math.min(
              rows.length - 1,
              index + (key.pageUp ? -1 : 1) * Math.max(1, size.rows - LAYOUT.menuPageOverheadRows),
            ),
          ),
        );
    } else if (key.home) move(0);
    else if (key.end) move(rows.length - 1);
    else if (key.upArrow) move((index + rows.length - 1) % rows.length);
    else if (key.downArrow) move((index + 1) % rows.length);
    else if (page && input.toLowerCase() === 'a') toggle({ kind: 'all' });
    else if (page && input === ' ' && index < page.rows.length) toggle({ kind: 'toggle', index });
    else if (key.return) {
      if (page && index === page.rows.length + 1) done({ kind: 'cancel', index });
      else if (page?.rows[index]?.editable) done({ kind: 'edit', index });
      else if (page && index < page.rows.length) toggle({ kind: 'toggle', index });
      else done({ kind: 'confirm', index });
    }
  });
  return (
    <Frame
      title={title}
      home={home}
      page={offset}
      reserveRows={Math.min(rows.length, LAYOUT.defaultContentRows) + 1}
      footer={page ? '↑↓ 移动 · 空格勾选 · A 全选 · Enter 编辑/确认 · Esc 返回' : '↑↓ 移动 · Enter 确认 · Esc 返回'}
    >
      {(height, width) => {
        const visible = Math.max(1, height - 1);
        const activeRow = displayRows.findIndex(row => row.index === active);
        const start = Math.max(0, Math.min(activeRow - Math.floor(visible / 2), displayRows.length - visible));
        return (
          <>
            {displayRows.slice(start, start + visible).map(({ row, index }, offset) => {
              if (index === null)
                return (
                  <Text key={'group-' + (start + offset)} color={ACCENT} dimColor wrap="truncate-end">
                    {'  ' + safeText(row.label) + ' '}
                    {'─'.repeat(
                      Math.max(
                        0,
                        Math.min(BANNER_WIDTH, width) - stringWidth(row.label) - LAYOUT.groupHeadingPaddingColumns,
                      ),
                    )}
                  </Text>
                );
              return (
                <Box key={index} flexShrink={0}>
                  <Text bold={index === active} {...(index === active ? { color: ACCENT } : {})}>
                    {index === active ? '› ' : '  '}
                    {page && index < page.rows.length ? (page.rows[index]?.checked ? '[x] ' : '[ ] ') : ''}
                  </Text>
                  <Box
                    width={
                      row.detail
                        ? Math.min(labelWidth + 2, Math.max(LAYOUT.labelMinimumColumns, Math.floor(width / 2)))
                        : undefined
                    }
                    flexShrink={row.detail ? 0 : 1}
                  >
                    <Text bold={index === active} wrap="truncate-end" {...(index === active ? { color: ACCENT } : {})}>
                      {safeText(row.label)}
                    </Text>
                  </Box>
                  {row.detail && (
                    <Text
                      dimColor={index !== active}
                      wrap="truncate-end"
                      {...(index === active ? { color: ACCENT } : {})}
                    >
                      {safeText(row.detail)}
                    </Text>
                  )}
                </Box>
              );
            })}
            {displayRows.length > visible && (
              <Text dimColor>
                {start + 1}–{Math.min(displayRows.length, start + visible)}/{displayRows.length}
              </Text>
            )}
          </>
        );
      }}
    </Frame>
  );
}

function InlineForm({
  title,
  fields,
  validate,
  interrupt,
  done,
}: Readonly<{
  title: string;
  fields: readonly FormField[];
  validate: (values: Readonly<Record<string, string>>) => FormProblem;
  interrupt: () => void;
  done: (result: Record<string, string> | null) => void;
}>) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map(field => [field.key, field.value])),
  );
  const valuesRef = useRef(values);
  const cursorRef = useRef(Array.from(fields[0]?.value ?? '').length);
  const [cursor, setCursor] = useState(cursorRef.current);
  const position = (next: number) => {
    cursorRef.current = next;
    setCursor(next);
  };
  const replace = (field: FormField, text: string, next: number) => {
    valuesRef.current = { ...valuesRef.current, [field.key]: text };
    setValues(valuesRef.current);
    position(next);
    setProblem(null);
  };
  const [active, setActive] = useState(0);
  const activeRef = useRef(active);
  const move = (index: number) => {
    activeRef.current = index;
    setActive(index);
    position(Array.from(valuesRef.current[fields[index]?.key ?? ''] ?? '').length);
  };
  const [problem, setProblem] = useState<FormProblem>(null);
  const size = useWindowSize();
  const append = (text: string) => {
    const field = fields[activeRef.current];
    if (field) {
      const characters = Array.from(valuesRef.current[field.key] ?? '');
      const inserted = Array.from(safeText(text).replace(/\r?\n/g, ' '));
      characters.splice(cursorRef.current, 0, ...inserted);
      replace(field, characters.join(''), cursorRef.current + inserted.length);
    }
  };
  usePaste(append);
  useInput((input, key) => {
    const index = activeRef.current;
    const field = fields[index];
    const characters = Array.from(valuesRef.current[field?.key ?? ''] ?? '');
    if (key.ctrl && input === 'c') {
      interrupt();
      done(null);
    } else if (key.escape) done(null);
    else if (key.upArrow) move(Math.max(0, index - 1));
    else if (key.tab && key.shift) move(Math.max(0, index - 1));
    else if (key.downArrow || key.tab) move(Math.min(fields.length + 1, index + 1));
    else if (field && key.leftArrow) position(Math.max(0, cursorRef.current - 1));
    else if (field && key.rightArrow) position(Math.min(characters.length, cursorRef.current + 1));
    else if (field && key.home) position(0);
    else if (field && key.end) position(characters.length);
    else if (field && key.ctrl && input === 'u') replace(field, '', 0);
    else if (key.return) {
      if (index === fields.length + 1) done(null);
      else if (index < fields.length - 1) move(index + 1);
      else {
        const error = validate(valuesRef.current);
        if (error) {
          setProblem(error);
          move(
            Math.max(
              0,
              fields.findIndex(field => field.key === error.field),
            ),
          );
        } else done(valuesRef.current);
      }
    } else if (key.backspace || key.delete) {
      if (field) {
        const next = Math.max(0, cursorRef.current - (key.backspace ? 1 : 0));
        if (!key.backspace || cursorRef.current > 0) characters.splice(next, 1);
        replace(field, characters.join(''), next);
      }
    } else if (!key.ctrl && !key.meta && input) append(input);
  });
  return (
    <Frame title={title} footer="Tab 切换 · ←→ 编辑 · Ctrl+U 清空 · Enter 继续 · Esc 取消">
      {height => {
        const visible = Math.max(1, height - 2 - (problem ? 1 : 0));
        const start = Math.max(0, Math.min(active - Math.floor(visible / 2), fields.length - visible));
        return (
          <>
            {fields.slice(start, start + visible).map((field, offset) => {
              const index = start + offset;
              const text = field.secret
                ? '•'.repeat(Array.from(values[field.key] ?? '').length)
                : (values[field.key] ?? '');
              const characters = Array.from(text);
              const caret = index === active ? cursor : characters.length;
              const available = Math.max(1, size.columns - stringWidth(field.label) - LAYOUT.formDecorationColumns);
              let from = caret;
              while (from > 0 && stringWidth(characters.slice(from - 1, caret).join('')) < available) from--;
              let to = caret;
              while (to < characters.length && stringWidth(characters.slice(from, to + 1).join('')) < available) to++;
              return (
                <Text key={field.key} wrap="truncate-end" {...(index === active ? { color: ACCENT } : {})}>
                  {index === active ? '› ' : '  '}
                  {field.label}：{safeText(characters.slice(from, caret).join(''))}
                  {index === active && <Text inverse>{characters[caret] ?? ' '}</Text>}
                  {safeText(characters.slice(caret + (index === active ? 1 : 0), to).join(''))}
                  {!values[field.key] && field.placeholder ? ' ' + field.placeholder : ''}
                </Text>
              );
            })}
            <Text {...(active === fields.length ? { color: ACCENT } : {})}>
              {active === fields.length ? '› ' : '  '}保存
            </Text>
            <Text {...(active === fields.length + 1 ? { color: ACCENT } : {})}>
              {active === fields.length + 1 ? '› ' : '  '}返回
            </Text>
            {problem && <Text color="red">{problem.message}</Text>}
          </>
        );
      }}
    </Frame>
  );
}

function Waiting({
  title,
  message,
  cancel,
  interrupt,
}: Readonly<{
  title: string;
  message?: string;
  cancel: () => void;
  interrupt: () => void;
}>) {
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      interrupt();
      cancel();
    } else if (key.escape) cancel();
  });
  return (
    <Frame title={title} footer="Esc 取消">
      {() => <Text>{message ?? '请稍候…'}</Text>}
    </Frame>
  );
}

function RunScreen({ view, interrupt }: Readonly<{ view: RunView; interrupt: () => void }>) {
  const [page, setPage] = useState(0);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') interrupt();
    else if (key.pageDown) setPage(previous => previous + 1);
    else if (key.pageUp) setPage(previous => Math.max(0, previous - 1));
  });
  return (
    <Frame title={view.title} footer="PgUp/PgDn 查看进度 · Ctrl+C 停止后续操作">
      {(height, width) => {
        const lines = wrapAnsi(view.rows.map(statusLine).join('\n'), width, { hard: true }).split('\n');
        const visible = Math.max(1, height - 2);
        const start = Math.min(page * visible, Math.max(0, lines.length - visible));
        return (
          <>
            <Text dimColor>{view.summary}</Text>
            <Text>{lines.slice(start, start + visible).join('\n')}</Text>
            {lines.length > visible && (
              <Text dimColor>
                {start + 1}–{Math.min(lines.length, start + visible)}/{lines.length}
              </Text>
            )}
          </>
        );
      }}
    </Frame>
  );
}

function homeLayout(width: number, height: number) {
  const showEnvironment = height >= LAYOUT.homeExpandedRows;
  const showCredit = height >= LAYOUT.homeCreditRows;
  const showLogo = showEnvironment && width >= LAYOUT.homeLogoColumns;
  return {
    showEnvironment,
    showCredit,
    showLogo,
    rows:
      LAYOUT.homeFixedRows +
      (showLogo ? BRAND.logo.length : 1) +
      (showCredit ? 1 : 0) +
      (showEnvironment ? LAYOUT.homeEnvironmentRows : showCredit ? 1 : 0),
  };
}

function HomeHeader({ width, height }: Readonly<{ width: number; height: number }>) {
  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const { showLogo, showCredit, showEnvironment } = homeLayout(width, height);
  return (
    <Box flexDirection="column">
      <Text color={ACCENT}>{'═'.repeat(Math.min(BANNER_WIDTH, width))}</Text>
      {showLogo ? (
        BRAND.logo.map((line, index) => (
          <Text key={index} color={ACCENT} bold>
            {'  ' + line}
          </Text>
        ))
      ) : (
        <Text bold color={ACCENT}>
          {' '}
          CCW
        </Text>
      )}
      <Text bold wrap="truncate-end">
        {' '}
        {BRAND.title} <Text dimColor>V{BRAND.versionNumber}</Text>
      </Text>
      {showCredit && <Text dimColor> {BRAND.credit}</Text>}
      {showEnvironment ? (
        <>
          <Text color={ACCENT}>{'─'.repeat(Math.min(BANNER_WIDTH, width))}</Text>
          <Text bold> 当前环境状态</Text>
          <Text>
            {' '}
            1. 系统 {platform} ({os.arch()})
          </Text>
          <Text> 2. Node {process.version}</Text>
          <Text wrap="truncate-end"> 3. 主目录 {safeText(os.homedir())}</Text>
        </>
      ) : (
        showCredit && (
          <Text dimColor wrap="truncate-end">
            {' '}
            {platform} ({os.arch()}) · Node {process.version}
          </Text>
        )
      )}
      <Text color={ACCENT}>{'═'.repeat(Math.min(BANNER_WIDTH, width))}</Text>
      <Text bold>请选择：</Text>
    </Box>
  );
}

function Frame({
  title,
  footer,
  page = 0,
  reserveRows = LAYOUT.defaultContentRows,
  home = false,
  children,
}: Readonly<{
  title: string;
  footer: string;
  page?: number;
  reserveRows?: number;
  home?: boolean;
  children: (height: number, width: number) => ReactNode;
}>) {
  const size = useWindowSize();
  const width = Math.max(LAYOUT.minimumColumns, size.columns - 1);
  const height = Math.max(LAYOUT.minimumRows, size.rows - 1);
  const [name = '', ...body] = safeText(title).split('\n');
  const lines = wrapAnsi(body.join('\n'), width, { hard: true }).split('\n').filter(Boolean);
  const detailHeight = Math.min(
    Math.max(1, height - reserveRows - LAYOUT.headerRows - LAYOUT.footerRows - LAYOUT.sectionGapRows),
    lines.length,
  );
  const start = Math.min(page * detailHeight, Math.max(0, lines.length - detailHeight));
  const hasPages = lines.length > detailHeight;
  const headerHeight = home ? homeLayout(width, height).rows : LAYOUT.headerRows + detailHeight + (hasPages ? 1 : 0);
  const contentHeight = Math.max(1, height - headerHeight - LAYOUT.footerRows);
  return (
    <Box flexDirection="column" width={width} height={height}>
      {home ? (
        <HomeHeader width={width} height={height} />
      ) : (
        <>
          <Box
            borderStyle="double"
            borderColor={ACCENT}
            paddingX={1}
            width={Math.min(BANNER_WIDTH, width)}
            flexShrink={0}
          >
            <Text bold color={ACCENT} wrap="truncate-end">
              CCW · {name}
            </Text>
          </Box>
          {lines.slice(start, start + detailHeight).map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
          {hasPages && (
            <Text dimColor>
              PgUp/PgDn 阅读 · {start + 1}–{Math.min(lines.length, start + detailHeight)}/{lines.length}
            </Text>
          )}
        </>
      )}
      <Box flexDirection="column" height={contentHeight} marginTop={1} flexShrink={0}>
        {children(contentHeight, width)}
      </Box>
      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {footer}
        </Text>
      </Box>
    </Box>
  );
}

async function pauseReading() {
  // Ink 使用 readable 模式，pause() 可能不发事件；通知 Node 停止底层读取后再交接
  process.stdin.pause();
  process.stdin.emit('pause');
  await new Promise<void>(resolve => process.nextTick(resolve));
}

function asError(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback);
}
