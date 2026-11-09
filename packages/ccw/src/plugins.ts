import path from 'node:path';

import { knownTitle } from './titles.js';
import { ENABLED_PLUGINS_KEY } from './claude-config.js';
import { marketplaceSources, pluginSpecs } from './management-catalog.js';
import { errorCode, isObject } from './machine.js';
import { cancelled, editFields, json, object, restOf, success, unchanged } from './model.js';
import type { Context, Describe, Domain, Inspection, Item, Prepared, Selection } from './model.js';
import { claudeCommand } from './programs.js';

function pluginSource(name: string, markets: Record<string, unknown>) {
  const spec = Object.entries(pluginSpecs).find(([id]) => id === name)?.[1];
  if (spec === undefined) return null;
  const expected = marketplaceSources[spec.source];
  const [bare, marketName] = name.split('@');
  if (!bare || marketName !== expected.market) return null;
  const market = markets[marketName];
  if (market === undefined) return { repository: expected.repository, marketName };
  if (!isObject(market) || !isObject(market.source)) return null;
  const source =
    typeof market.source.repo === 'string'
      ? market.source.repo
      : typeof market.source.url === 'string'
        ? market.source.url.replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '')
        : '';
  return expected.acceptedRepositories.some(repository => repository === source)
    ? { repository: expected.repository, marketName }
    : null;
}

/** 插件名的市场段：name@market 形态 */
function marketOf(name: string) {
  return name.split('@')[1];
}

/** 非目录插件的既存市场：用户自选来源只验市场记录在场，不做仓库白名单比对；
 *  目录内插件一律返回 null，保持来源冲突防护 */
function declaredMarketSource(name: string, markets: Record<string, unknown>) {
  if (Object.hasOwn(pluginSpecs, name)) return null;
  const marketName = marketOf(name);
  return marketName !== undefined && isObject(markets[marketName]) ? { marketName } : null;
}

/** 解析插件标题：未安装方案入口用官方名；实际对象须市场记录在场且来源匹配，证据不足保留原始键名 */
function pluginTitle(name: string, markets: Record<string, unknown> | null, isInstalled: boolean): string {
  if (!isInstalled) return knownTitle(`plugin:${name}`, name);
  if (markets === null) return name;
  const marketName = marketOf(name);
  return marketName !== undefined && markets[marketName] !== undefined && pluginSource(name, markets) !== null
    ? knownTitle(`plugin:${name}`, name)
    : name;
}

async function pluginRecords(ctx: Context) {
  const document = await json(ctx.machine, path.join(ctx.claudeRoot, 'plugins/installed_plugins.json'));
  return object(document.plugins);
}

function userPluginRecords(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('invalid-plugin-record');
  const entries: Record<string, unknown>[] = [];
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.scope !== 'string') throw new Error('invalid-plugin-record');
    if (entry.scope === 'user') entries.push(entry);
  }
  return entries;
}

/** 只回答安装记录的载荷是否存在，不决定复用资格或错误处理 */
async function pluginFilePresent(ctx: Context, record: Record<string, unknown>): Promise<boolean> {
  return typeof record.installPath === 'string' && (await ctx.machine.realpath(record.installPath)) !== null;
}

/** 创建插件域渠道：余段即插件名 */
export function createPluginsDomain(ctx: Context): Domain {
  return {
    inspect: () => inspectPlugins(ctx),
    prepare(selection, describe) {
      const name = restOf(selection.id);
      if (name === undefined) throw new Error('unknown-selection');
      return preparePlugin(ctx, name, selection, describe);
    },
  };
}

async function inspectPlugins(ctx: Context): Promise<Inspection> {
  const problems: string[] = [];
  let enabled: Record<string, unknown> = {};
  let records: Record<string, unknown> = {};
  let markets: Record<string, unknown> = {};
  let settingsProblem: string | undefined;
  let recordsProblem: string | undefined;
  let marketsProblem: string | undefined;
  try {
    enabled = object((await json(ctx.machine, ctx.settingsFile))[ENABLED_PLUGINS_KEY]);
  } catch (error) {
    settingsProblem = errorCode(error);
    problems.push(settingsProblem);
  }
  try {
    records = await pluginRecords(ctx);
  } catch (error) {
    recordsProblem = errorCode(error);
    problems.push(recordsProblem);
  }
  try {
    markets = await json(ctx.machine, path.join(ctx.claudeRoot, 'plugins/known_marketplaces.json'));
  } catch (error) {
    marketsProblem = errorCode(error);
    problems.push(marketsProblem);
  }
  const names = new Set([
    ...Object.entries(pluginSpecs)
      .filter(([, spec]) => spec.exposure === 'offer')
      .map(([name]) => name),
    ...Object.keys(enabled),
    ...Object.keys(records),
  ]);
  const items: Item[] = [];
  for (const name of names) {
    try {
      const installed = userPluginRecords(records[name]);
      const source = pluginSource(name, markets);
      const isOffered = source !== null;
      if (!isOffered && installed.length === 0 && enabled[name] === undefined) continue;
      const isInstalled = installed.length > 0;
      const hasFilesPresent =
        isInstalled && (await Promise.all(installed.map(record => pluginFilePresent(ctx, record)))).every(Boolean);
      const problem = settingsProblem ?? recordsProblem ?? marketsProblem;
      items.push({
        id: `plugin:${name}`,
        title: pluginTitle(name, marketsProblem ? null : markets, isInstalled || enabled[name] !== undefined),
        kind: 'plugin',
        canInstall: isOffered && !problem,
        ...(problem ? { problem } : {}),
        facts: [
          ...(recordsProblem ? [] : [{ code: isInstalled ? 'plugin-installed' : 'plugin-not-installed' }]),
          ...(isInstalled ? [{ code: hasFilesPresent ? 'plugin-files-present' : 'plugin-files-missing' }] : []),
          ...(settingsProblem
            ? []
            : [
                {
                  code:
                    enabled[name] === true
                      ? 'declared-enabled'
                      : enabled[name] === false
                        ? 'declared-disabled'
                        : 'not-declared',
                },
              ]),
        ],
        actions: [
          ...(isOffered && !problem
            ? hasFilesPresent
              ? (['update', 'reinstall', 'connect'] as const)
              : (['install'] as const)
            : []),
          // 非目录插件停用后不是死对象：文件在场时提供恢复启用入口（经安装页复用启用通道）
          ...(!isOffered && !problem && enabled[name] === false && hasFilesPresent ? (['connect'] as const) : []),
          ...(!settingsProblem && (enabled[name] === true || (enabled[name] === undefined && isInstalled))
            ? (['detach'] as const)
            : []),
        ],
      });
    } catch (error) {
      items.push({
        id: `plugin:${name}`,
        title: name,
        kind: 'plugin',
        facts: [],
        actions: enabled[name] === true ? ['detach'] : [],
        problem: errorCode(error),
      });
    }
  }
  return { items, problems: problems.map(code => ({ code, detail: 'plugins' })) };
}

async function preparePlugin(ctx: Context, name: string, selection: Selection, describe?: Describe): Promise<Prepared> {
  if (!/^[\w.-]+@[\w.-]+$/.test(name)) throw new Error('invalid-plugin-id');
  const action = selection.action;
  if (!['install', 'connect', 'update', 'reinstall', 'detach'].includes(action)) throw new Error('action-unavailable');
  const marketplaceFile = path.join(ctx.claudeRoot, 'plugins/known_marketplaces.json');
  let markets: Record<string, unknown> | null = null;
  let source: ReturnType<typeof pluginSource> = null;
  let declared: ReturnType<typeof declaredMarketSource> = null;
  try {
    markets = await json(ctx.machine, marketplaceFile);
    source = pluginSource(name, markets);
    declared = source === null ? declaredMarketSource(name, markets) : null;
  } catch (error) {
    // 解除声明不依赖市场文件可读；取消仍由准备作用域向外传播
    if (action !== 'detach' || errorCode(error) === 'cancelled') throw error;
  }
  const settings = await json(ctx.machine, ctx.settingsFile);
  const before = object(settings[ENABLED_PLUGINS_KEY]);
  const recordsNow = async () => userPluginRecords((await pluginRecords(ctx))[name]);
  const enabledNow = async () => object((await json(ctx.machine, ctx.settingsFile))[ENABLED_PLUGINS_KEY]);
  if (action === 'detach') {
    const installed = before[name] === true ? null : await recordsNow();
    if (before[name] !== true && (before[name] !== undefined || !installed?.length)) throw new Error('no-connection');
    describe?.(pluginTitle(name, markets, before[name] !== undefined || (installed?.length ?? 0) > 0));
    return {
      writes: [ctx.settingsFile],
      changes: [{ code: 'plugin-disable', detail: name }, { code: 'keep-plugin-files' }],
      async run(report) {
        if (installed !== null) unchanged(await recordsNow(), installed);
        await editFields(ctx, ctx.settingsFile, before, { [name]: false }, ENABLED_PLUGINS_KEY);
        report({ state: 'done', code: 'plugin-disabled', detail: name });
      },
    };
  }
  if (source === null && declared === null) throw new Error('marketplace-source-conflict');
  const records = await recordsNow();
  describe?.(pluginTitle(name, markets, records.length > 0 || before[name] !== undefined));
  const canReuse =
    action === 'install' &&
    records.length > 0 &&
    (await Promise.all(records.map(record => pluginFilePresent(ctx, record)))).every(Boolean);
  const help = action === 'reinstall' ? await claudeCommand(ctx, ['plugin', 'uninstall', '--help']) : null;
  // 探测失败保持未知：不以「不支持保留」代替；重装一律阻断（官方卸载可能删除插件数据）
  if (help !== null && (help.failed || help.code !== 0)) throw new Error('plugin-keep-data-unconfirmed');
  const shouldKeepData = help !== null && help.stdout.includes('--keep-data');
  let isRemoved = false;
  let isCommandDone = false;
  let hasCommandSnapshot = false;
  let isCredentialSaved = false;
  let expectedRecords = records;
  let expectedEnabled = before[name];
  const validateSource = async () => {
    const marketsNow = await json(ctx.machine, marketplaceFile);
    if (source !== null) {
      const current = pluginSource(name, marketsNow);
      if (current === null || current.marketName !== source.marketName || current.repository !== source.repository)
        throw new Error('marketplace-source-conflict');
      return;
    }
    const current = declaredMarketSource(name, marketsNow);
    if (current === null || declared === null || current.marketName !== declared.marketName)
      throw new Error('marketplace-source-conflict');
  };
  return {
    get changes() {
      return [
        { code: isCommandDone ? 'plugin-confirm' : canReuse ? 'plugin-reuse' : `plugin-${action}`, detail: name },
        ...(!isCredentialSaved && selection.fields?.secret && name.startsWith('github@')
          ? [{ code: 'github-credential-configure' }]
          : []),
        ...(action === 'reinstall' && !isRemoved
          ? [
              {
                code: shouldKeepData ? 'plugin-keep-data' : 'plugin-delete-own-data',
              },
              { code: 'plugin-credentials-removed' },
            ]
          : [{ code: 'new-session-required' }]),
      ];
    },
    async run(report, signal) {
      cancelled(signal);
      if (isCommandDone && !hasCommandSnapshot) throw new Error('program-installation-unconfirmed');
      await validateSource();
      unchanged((await enabledNow())[name], expectedEnabled);
      unchanged(await recordsNow(), expectedRecords);
      if (action === 'reinstall' && !isRemoved) {
        success(
          await claudeCommand(ctx, [
            'plugin',
            'uninstall',
            name,
            '--scope',
            'user',
            ...(shouldKeepData ? ['--keep-data'] : []),
          ]),
          'plugin-command-failed',
        );
        if ((await recordsNow()).length > 0 || (await enabledNow())[name] === true) throw new Error('plugin-remains');
        expectedRecords = await recordsNow();
        expectedEnabled = (await enabledNow())[name];
        isRemoved = true;
        report({ state: 'done', code: 'plugin-removed' });
        cancelled(signal);
      }
      if (!isCommandDone && (action === 'install' || action === 'reinstall')) {
        await validateSource();
        const markets = await json(ctx.machine, marketplaceFile);
        if (source !== null && markets[source.marketName] === undefined)
          success(
            await claudeCommand(ctx, ['plugin', 'marketplace', 'add', source.repository]),
            'marketplace-command-failed',
          );
      }
      const verb = action === 'connect' || canReuse ? 'enable' : action === 'update' ? 'update' : 'install';
      await validateSource();
      if (!isCommandDone) {
        success(await claudeCommand(ctx, ['plugin', verb, name, '--scope', 'user']), 'plugin-command-failed');
        isCommandDone = true;
        report({ state: 'done', code: 'plugin-command-completed' });
        try {
          expectedRecords = await recordsNow();
          expectedEnabled = (await enabledNow())[name];
          hasCommandSnapshot = true;
        } catch (error) {
          throw new Error('program-installation-unconfirmed', { cause: error });
        }
      }
      if (name.startsWith('github@') && selection.fields?.secret) {
        if (!isCredentialSaved)
          await editFields(
            ctx,
            ctx.settingsFile,
            object(settings.env),
            { GITHUB_PERSONAL_ACCESS_TOKEN: selection.fields.secret },
            'env',
            () => {
              isCredentialSaved = true;
              report({ state: 'done', code: 'github-credential-saved' });
            },
          );
        else
          unchanged(
            object((await json(ctx.machine, ctx.settingsFile)).env).GITHUB_PERSONAL_ACCESS_TOKEN,
            selection.fields.secret,
          );
      }
      const after = await recordsNow();
      if (after.length === 0) throw new Error('plugin-not-ready');
      for (const record of after) if (!(await pluginFilePresent(ctx, record))) throw new Error('plugin-not-ready');
      if (action !== 'update' && (await enabledNow())[name] !== true) throw new Error('plugin-not-enabled');
      report({ state: 'done', code: 'plugin-ready' });
    },
  };
}
