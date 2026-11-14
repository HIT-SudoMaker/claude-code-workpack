import path from 'node:path';
import { knownTitle, PLUGIN_SPECS, PLUGIN_MARKETPLACE } from './management-catalog.js';
import { isObject, errorCode } from './machine.js';
import { json, object, restOf, commandReceipt, unchanged } from './model.js';
import type { Change, Context, Domain, Prepared, Selection, ClaudeCommand } from './model.js';
import { jsonFingerprint, frozenJsonWork } from './frozen-json.js';
import { step } from './work.js';
const names = Object.keys(PLUGIN_SPECS);
/**
 * 管理已知 Claude 插件的用户级安装和启用状态
 *
 * @remarks 安装使用绑定的 Claude 命令，拒绝同名市场来源冲突，不管理访问令牌
 * 完成须确认文件和启用声明；更新还须命令成功退出
 * 停用只写设置并保留文件，不依赖 Claude 命令
 */
export function createPluginsDomain(ctx: Context): Domain {
  return {
    async inspect() {
      const items = [];
      for (const name of names) {
        const facts: Change[] = [];
        const item = {
          id: 'plugin:' + name,
          title: knownTitle('plugin:' + name, name),
          kind: 'plugin' as const,
          location: ctx.settingsFile,
          canInstall: true,
          canUninstall: false,
          facts,
        };
        try {
          item.canUninstall = (await readEnabled(ctx, name)) === true;
          facts.push({ code: item.canUninstall ? 'declared-enabled' : 'declared-disabled' });
          const current = await observeInstallation(ctx, name);
          facts.unshift({ code: current.ready ? 'plugin-installed' : 'plugin-not-installed' });
          items.push(item);
        } catch (error) {
          items.push({ ...item, problem: errorCode(error) });
        }
      }
      return { items, problems: [] };
    },
    async prepare(selection, claude) {
      const name = restOf(selection.id);
      if (!name || !names.includes(name)) throw new Error('unknown-selection');
      return preparePlugin(ctx, name, selection, selection.action === 'detach' ? undefined : await claude?.());
    },
  };
}
async function preparePlugin(
  ctx: Context,
  name: string,
  selection: Selection,
  claude?: ClaudeCommand,
): Promise<Prepared> {
  const detach = selection.action === 'detach';
  if (detach) {
    const enabled = await readEnabled(ctx, name);
    if (enabled !== true) throw new Error('no-connection');
    return frozenJsonWork(ctx, {
      file: ctx.settingsFile,
      fields: [{ path: ['enabledPlugins', name], before: jsonFingerprint(enabled), value: false }],
      changes: [{ code: 'plugin-disable', detail: name }, { code: 'keep-plugin-files' }],
      effects: [{ state: 'done', code: 'plugin-disabled' }],
    });
  }
  const before = await observe(ctx, name);
  if (!claude) throw new Error('claude-not-installed');
  const hadMarket = await marketplace(ctx);
  const expected = jsonFingerprint(before);
  const verb = before.ready ? 'update' : 'install';
  const install = step(
    [{ code: before.ready ? 'plugin-update' : 'plugin-install', detail: name }, { code: 'new-session-required' }],
    async fact => {
      if (!fact.dispatched) await claude.verify();
      await marketplace(ctx);
      const current = await observe(ctx, name);
      // 更新既有插件还需命令正常返回，避免未发生更新时把原有文件误判为本次成功
      if (fact.dispatched)
        return current.ready &&
          current.enabled === true &&
          (!before.ready || (fact.receipt?.kind === 'returned' && !fact.receipt.failure))
          ? {
              state: 'complete',
              effects: [{ state: 'done', code: 'plugin-ready', detail: name }],
            }
          : { state: 'blocked', problem: fact.receipt?.failure ?? 'plugin-not-ready' };
      unchanged(jsonFingerprint(current), expected);
      return { state: 'ready' };
    },
    async () => {
      unchanged(jsonFingerprint(await observe(ctx, name)), expected);
      if (!(await marketplace(ctx))) {
        if (hadMarket) throw new Error('marketplace-source-conflict');
        const added = await claude.execute([
          'plugin',
          'marketplace',
          'add',
          PLUGIN_MARKETPLACE.repository,
          '--scope',
          'user',
        ]);
        const receipt = commandReceipt(added, 'marketplace-add-failed');
        if (receipt.failure) return { receipt };
        if (!(await marketplace(ctx))) throw new Error('marketplace-source-conflict');
      }
      const result = await claude.execute(['plugin', verb, name, '--scope', 'user']);
      if (before.enabled !== true && verb === 'update' && result.code === 0 && !result.failed) {
        const enabled = await claude.execute(['plugin', 'enable', name, '--scope', 'user']);
        return { receipt: commandReceipt(enabled, 'plugin-command-failed') };
      }
      return { receipt: commandReceipt(result, 'plugin-command-failed') };
    },
  );
  return { ...install, action: verb };
}
async function observe(ctx: Context, name: string) {
  return { enabled: await readEnabled(ctx, name), ...(await observeInstallation(ctx, name)) };
}
async function readEnabled(ctx: Context, name: string) {
  return object((await json(ctx.machine, ctx.settingsFile)).enabledPlugins)[name];
}
async function observeInstallation(ctx: Context, name: string) {
  const value = object((await json(ctx.machine, path.join(ctx.claudeRoot, 'plugins/installed_plugins.json'))).plugins)[
    name
  ];
  if (value !== undefined && !Array.isArray(value)) throw new Error('invalid-plugin-record');
  if ((value ?? []).some((record: unknown) => !isObject(record) || typeof record.scope !== 'string'))
    throw new Error('invalid-plugin-record');
  const records = (value ?? []).filter((record: unknown) => isObject(record) && record.scope === 'user');
  const files = [];
  for (const record of records) {
    if (!isObject(record) || typeof record.installPath !== 'string') throw new Error('invalid-plugin-record');
    files.push(await ctx.machine.treeStamp(record.installPath));
  }
  return { records, files, ready: records.length > 0 && files.every(stamp => stamp !== null) };
}
async function marketplace(ctx: Context) {
  const value = (await json(ctx.machine, path.join(ctx.claudeRoot, 'plugins/known_marketplaces.json')))[
    PLUGIN_MARKETPLACE.market
  ];
  if (value === undefined) return false;
  const source = object(object(value).source);
  const repo =
    typeof source.repo === 'string'
      ? source.repo
      : typeof source.url === 'string'
        ? source.url.replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '')
        : '';
  if (!PLUGIN_MARKETPLACE.acceptedRepositories.some(accepted => accepted === repo))
    throw new Error('marketplace-source-conflict');
  return true;
}
