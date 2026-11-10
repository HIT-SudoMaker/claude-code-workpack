import path from 'node:path';

import type { Ccw } from './ccw.js';
import { dataSizeDetailOf, isEmptyDataSize } from './cleanup.js';
import { errorCode, isObject } from './machine.js';
import { context, json } from './model.js';
import type { CcwOptions, Context } from './model.js';
import { BRAND, describeInspection, platformSummary, PROBLEM_MARK, UNCONFIRMED } from './render.js';
import {
  INSTALL_SCRATCH_PREFIX,
  disabledDirectory,
  logsDirectory,
  readLastRun,
  replacedDirectory,
  sourcesFile,
} from './storage.js';
import { knownTitle } from './titles.js';

export interface CollectResult {
  readonly file: string;
  readonly summary: string;
}

/** 路径折叠：配置根 → <claude>，主目录 → ~；先长后短，且仅折叠后继为分隔符或结尾的完整前缀 */
export function foldText(ctx: Context, text: string): string {
  let folded = text;
  for (const directory of [ctx.claudeRoot, ctx.home]) {
    const token = directory === ctx.claudeRoot ? '<claude>' : '~';
    for (const separator of ['\\', '/']) {
      const prefix = directory.replaceAll('\\', separator).replaceAll('/', separator);
      if (prefix)
        folded = folded.replace(
          new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\\\/]|$)`, 'g'),
          token,
        );
    }
  }
  return folded;
}

/** 凭据打码：常见令牌形态只保留前缀提示 */
export function redactText(text: string): string {
  return text
    .replace(/(Authorization:\s*\S+\s+)\S+/gi, '$1<redacted>')
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1…<redacted>')
    .replace(/\b(ghp_[A-Za-z0-9]{4})[A-Za-z0-9]+/g, '$1…<redacted>')
    .replace(/\b(sk-[A-Za-z0-9]{4})[A-Za-z0-9]{8,}\b/g, '$1…<redacted>');
}

async function directoryCount(ctx: Context, directory: string): Promise<number | null> {
  try {
    return (await ctx.machine.entries(directory)).length;
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 0 : null;
  }
}

/** 收集诊断日志：只读本地事实，生成一个脱敏报告文件；不上传、不做网络请求 */
export async function collectLogs(ccw: Ccw, options: CcwOptions): Promise<CollectResult> {
  const ctx = context(options);
  // 展示层兜底词：读取未知不用空串或「无」代替
  const UNKNOWN = '未知';
  // 两路检查顺序执行（各 5 秒预算）
  const view = await ccw.inspect('contents');
  const data = await ccw.inspect('data');
  const problems = [
    ...view.problems.map(problem => problem.code),
    ...view.items.flatMap(item => (item.problem ? [item.problem] : [])),
  ];
  const sources = await json(ctx.machine, sourcesFile(ctx)).catch(() => null);
  // 记录不可读时保留未知（不以"无历史"代替查无）：读取对缺失文件返回空对象，抛错即为损坏或不可读
  let lastRun: Record<string, unknown> = {};
  let lastRunReadable = true;
  try {
    lastRun = await readLastRun(ctx);
  } catch {
    lastRunReadable = false;
  }
  const runItems = Array.isArray(lastRun.items)
    ? lastRun.items.filter(isObject).map(entry => ({
        title: typeof entry.title === 'string' ? entry.title : typeof entry.id === 'string' ? entry.id : UNKNOWN,
        state: typeof entry.state === 'string' ? entry.state : UNKNOWN,
      }))
    : [];
  const runAt = typeof lastRun.finishedAt === 'string' ? lastRun.finishedAt : undefined;
  const runState = typeof lastRun.state === 'string' ? lastRun.state : undefined;
  const replaced = await directoryCount(ctx, replacedDirectory(ctx));
  const disabled = await directoryCount(ctx, disabledDirectory(ctx));
  const storageEntries = await ctx.machine.entries(ctx.storage).catch(() => null);
  const installLeftovers =
    storageEntries?.filter(entry => entry.name.startsWith(INSTALL_SCRATCH_PREFIX)).length ?? null;
  const customConfigRoot = ctx.claudeRoot !== path.join(ctx.home, '.claude');
  const stamp = new Date();
  const environment = [
    `生成时间：${stamp.toISOString()}`,
    `版本：CCW ${BRAND.versionNumber}`,
    `环境：${platformSummary(ctx.platform, ctx.arch ?? process.arch)}${ctx.libc ? ` · ${ctx.libc}` : ''} · Node ${process.version}`,
    `配置根：${customConfigRoot ? '自定义（CLAUDE_CONFIG_DIR）' : '默认'} · 状态文件与存储见下方折叠路径`,
  ];
  const dataLines = data.items.map(item => {
    const size = dataSizeDetailOf(item);
    return `- ${knownTitle(item.id)}：${size ?? '无数据'}${item.problem ? ` · ${UNCONFIRMED}（${item.problem}）` : ''}`;
  });
  const report = [
    '# CCW 诊断报告',
    '',
    ...environment,
    `存储位置：${path.join(ctx.storage, '')}（来源记录 ${
      sources === null ? '不可读' : `${Object.keys(sources).length} 条`
    }，替换备份 ${replaced ?? UNKNOWN} 份，停用备份 ${disabled ?? UNKNOWN} 份，安装残留 ${installLeftovers ?? UNKNOWN} 项）`,
    '',
    '## 检查结果（完整明细）',
    '',
    describeInspection(view, true) || '（无条目）',
    '',
    '## 最近一次执行',
    '',
    ...(lastRunReadable
      ? runItems.length || runState !== undefined
        ? [
            `时间：${runAt ?? UNKNOWN} · 状态：${runState ?? UNKNOWN}`,
            ...runItems.map(entry => `- ${entry.title}：${entry.state}`),
          ]
        : ['（无执行历史）']
      : ['（最近执行状态未知：记录不可读）']),
    '',
    '## 运行数据体量',
    '',
    ...(dataLines.length ? dataLines : ['（无数据）']),
    ...data.problems.map(problem => `- ${PROBLEM_MARK}${problem.code}${problem.detail ? `：${problem.detail}` : ''}`),
    '',
    '## 隐私声明',
    '',
    '- 本报告只在本地生成；CCW 不会自动上传任何内容，是否提供给他人由你决定',
    '- 报告中的主目录与配置根路径已折叠，常见凭据形态已打码',
    '- 检查过程会读取 settings.json 与 .claude.json 以派生状态；报告只收录派生事实码，不收录原文与凭据值',
    '- 未读取任何日志文件的内容，仅统计存在性与体量',
    '',
  ].join('\n');
  const directory = logsDirectory(ctx);
  const base = `ccw-collect-${stamp.toISOString().replace(/[-:]/g, '').replace('T', '').slice(0, 14)}`;
  const text = redactText(foldText(ctx, report));
  let file = path.join(directory, `${base}.md`);
  let attempt = 0;
  while (!(await ctx.effects.initialize(file, text))) {
    if (++attempt >= 100) throw new Error('report-name-conflict');
    file = path.join(directory, `${base}-${attempt}.md`);
  }
  const summary = [
    'CCW 诊断摘要',
    `版本：CCW ${BRAND.versionNumber} · ${platformSummary(ctx.platform, ctx.arch ?? process.arch)} · Node ${process.version}`,
    `检查：${view.items.length} 项，${problems.length} 个问题${problems.length ? `（${[...new Set(problems)].join('、')}）` : ''}`,
    ...(lastRunReadable && runState !== undefined ? [`最近执行：${runState}`] : []),
    ...(data.items.length
      ? [
          `数据：${data.items
            .map(item => {
              const size = dataSizeDetailOf(item);
              return size !== undefined && !isEmptyDataSize(size) ? `${knownTitle(item.id)} ${size}` : '';
            })
            .filter(Boolean)
            .join(' · ')}`,
        ]
      : []),
    `完整报告：${file}`,
    '报障时请把上面的完整报告文件一并附上',
  ].join('\n');
  return { file, summary };
}
