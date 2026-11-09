import path from 'node:path';

import { json } from './model.js';
import type { Context, Plan, RunResult } from './model.js';

/** CCW 自有存储（~/.ccw）的文件与目录名单一出处：写入侧（各域）与读取侧（诊断收集）都经此取路径 */
export const sourcesFile = (ctx: Context) => path.join(ctx.storage, 'sources.json');
export const lastRunFile = (ctx: Context) => path.join(ctx.storage, 'last-run.json');
export const replacedDirectory = (ctx: Context) => path.join(ctx.storage, 'replaced');
export const disabledDirectory = (ctx: Context) => path.join(ctx.storage, 'disabled');
export const logsDirectory = (ctx: Context) => path.join(ctx.storage, 'logs');
/** 安装类临时产物（install-claude-*、install-uv-*）在存储根下的共用名称前缀 */
export const INSTALL_SCRATCH_PREFIX = 'install-';
export const installScratch = (ctx: Context, name: string) =>
  path.join(ctx.storage, `${INSTALL_SCRATCH_PREFIX}${name}`);

/** apply 后尽力落盘最近执行摘要：写入失败静默吞掉，不抛给调用方、不影响执行结果 */
export async function writeLastRun(ctx: Context, plan: Plan, result: RunResult, remaining: string | undefined) {
  try {
    await ctx.machine.editJson(lastRunFile(ctx), values => {
      values.schema = 1;
      values.planId = plan.id;
      values.finishedAt = new Date().toISOString();
      values.state = result.state;
      values.items = plan.items.map((item, index) => ({
        id: item.id,
        title: item.title,
        action: item.action,
        state: result.items[index]?.state ?? null,
        effects: (result.items[index]?.effects ?? []).map(effect => ({
          state: effect.state,
          code: effect.code,
          ...(effect.detail ? { detail: effect.detail } : {}),
        })),
      }));
      if (remaining !== undefined) values.remaining = remaining;
      else delete values.remaining;
    });
  } catch {
    return;
  }
}

/** 读取最近执行记录：文件缺失得空对象（无历史），损坏或不可读抛错由调用方保留未知 */
export function readLastRun(ctx: Context): Promise<Record<string, unknown>> {
  return json(ctx.machine, lastRunFile(ctx));
}
