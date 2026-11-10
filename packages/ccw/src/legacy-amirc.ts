import { json, MCP_SERVERS_KEY, object, readMcpServers } from './model.js';
import type { Context, OperationDefinition, OperationHandler, Prepared } from './model.js';
import { extensionDigest, extensionPrepared } from './skill-files.js';

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
export async function prepareLegacyAmircDetach(ctx: Context): Promise<Prepared> {
  const before = await readMcpServers(ctx);
  const allow = allowedTools(await json(ctx.machine, ctx.settingsFile));
  const selected = OWNED_RULES.filter(rule => allow.includes(rule));
  if (before.amirc === undefined && !selected.length) throw new Error('no-connection');
  const itemId = 'mcp:amirc';
  const operations: OperationDefinition[] = [];
  if (before.amirc !== undefined)
    operations.push({
      id: `${itemId}/registration-remove`,
      itemId,
      handler: 'mcp.registration',
      dependsOn: [],
      writes: [ctx.stateFile],
      payload: {
        file: ctx.stateFile,
        name: 'amirc',
        before: extensionDigest(before.amirc),
        after: extensionDigest(undefined),
        target: null,
        credentialMode: 'none',
        headers: null,
      },
      changes: [{ code: 'mcp-remove-registration', detail: 'amirc' }, { code: 'mcp-keep-runtime' }],
    });
  operations.push(
    ...selected.map(rule => ({
      id: `${itemId}/permission/${rule}`,
      itemId,
      handler: 'amirc.permission-remove',
      dependsOn: [],
      writes: [ctx.settingsFile],
      payload: { file: ctx.settingsFile, rule },
      changes: [{ code: 'amirc-permissions-remove' }],
    })),
  );
  return extensionPrepared(operations);
}
export function legacyAmircHandlers(ctx: Context): Readonly<Record<string, OperationHandler>> {
  return {
    'amirc.permission-remove': {
      async assess(definition) {
        const { file, rule } = definition.payload;
        if (file !== ctx.settingsFile || typeof rule !== 'string' || !OWNED_RULES.includes(rule))
          return { state: 'blocked', problem: 'target-changed' };
        if (!allowedTools(await json(ctx.machine, ctx.settingsFile)).includes(rule))
          return {
            state: 'complete',
            evidence: { absent: true },
            effects: [{ state: 'done', code: 'amirc-permissions-removed' }],
          };
        return { state: 'ready' };
      },
      async execute(definition) {
        const rule = String(definition.payload.rule);
        await ctx.effects.editJson(ctx.settingsFile, settings => {
          settings.permissions = {
            ...object(settings.permissions),
            allow: allowedTools(settings).filter(value => value !== rule),
          };
        });
        const receipt = { kind: 'returned' as const, failure: null };
        try {
          return {
            receipt,
            evidence: { absent: !allowedTools(await json(ctx.machine, ctx.settingsFile)).includes(rule) },
          };
        } catch {
          return { receipt };
        }
      },
    },
  };
}
