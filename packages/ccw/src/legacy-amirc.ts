import {
  cancelled,
  json,
  MCP_SERVERS_KEY,
  object,
  readMcpServers,
  removeFields,
  sequence,
  unchanged,
} from './model.js';
import type { Context, Prepared } from './model.js';
const OWNED_RULES = ['mcp__amirc__organize_papers', 'mcp__amirc__search_papers', 'mcp__amirc__get_papers'];

function allowedTools(settings: Record<string, unknown>): string[] {
  const allow = object(settings.permissions).allow;
  if (allow === undefined) return [];
  if (!Array.isArray(allow) || !allow.every((rule): rule is string => typeof rule === 'string'))
    throw new Error('invalid-settings');
  return allow;
}

export async function hasLegacyAmircPermissions(ctx: Context): Promise<boolean> {
  return allowedTools(await json(ctx.machine, ctx.settingsFile)).some(rule => OWNED_RULES.includes(rule));
}

/** 退役迁移只解除明确选择的旧注册与精确允许规则，保留技能与用户材料 */
export async function prepareLegacyAmircDetach(ctx: Context): Promise<Prepared> {
  const before = await readMcpServers(ctx);
  const allowBefore = allowedTools(await json(ctx.machine, ctx.settingsFile));
  if (before.amirc === undefined && !allowBefore.some(rule => OWNED_RULES.includes(rule)))
    throw new Error('no-connection');

  let hasAttemptedWrite = false;
  let isWritten = false;
  let isComplete = false;
  const selected = OWNED_RULES.filter(rule => allowBefore.includes(rule));
  const verify = async () => {
    const current = allowedTools(await json(ctx.machine, ctx.settingsFile));
    if (current.some(rule => OWNED_RULES.includes(rule))) throw new Error('target-changed');
  };
  const permissions: Prepared = {
    writes: [ctx.settingsFile],
    get changes() {
      return [{ code: isWritten ? 'removal-confirm' : 'amirc-permissions-remove' }];
    },
    async run(report, signal) {
      cancelled(signal);
      const current = allowedTools(await json(ctx.machine, ctx.settingsFile));
      if (selected.length && !isWritten && (!hasAttemptedWrite || current.some(rule => OWNED_RULES.includes(rule)))) {
        await ctx.effects.editJson(ctx.settingsFile, settings => {
          const allow = allowedTools(settings);
          unchanged(
            OWNED_RULES.filter(rule => allow.includes(rule)),
            selected,
          );
          settings.permissions = {
            ...object(settings.permissions),
            allow: allow.filter(rule => !selected.includes(rule)),
          };
          hasAttemptedWrite = true;
        });
        isWritten = true;
      }
      await verify();
      isComplete = true;
      report({ state: 'done', code: 'amirc-permissions-removed' });
    },
    remaining: () => (isComplete ? undefined : permissions),
    verify,
  };
  return sequence([
    removeFields(
      ctx,
      ctx.stateFile,
      { amirc: before.amirc },
      [{ code: 'mcp-remove-registration', detail: 'amirc' }, { code: 'mcp-keep-runtime' }],
      { state: 'done', code: 'registration-removed', detail: 'amirc' },
      MCP_SERVERS_KEY,
    ),
    permissions,
  ]);
}
