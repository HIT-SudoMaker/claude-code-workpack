import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { knownTitle } from './titles.js';
import { ENABLED_PLUGINS_KEY } from './settings.js';
import { marketplaceSources, pluginSpecs } from './management-catalog.js';
import { errorCode, isGitRevision, isObject, treeFilesStamp } from './machine.js';
import { json, object, restOf, success, unchanged } from './model.js';
import type {
  Context,
  Describe,
  Domain,
  Inspection,
  Item,
  Prepared,
  Selection,
  Json,
  JsonObject,
  OperationDefinition,
  OperationHandler,
} from './model.js';
import { claudeCommand } from './programs.js';
import {
  extensionDigest,
  extensionString,
  extensionNullableString,
  extensionObject,
  extensionObjects,
  extensionPrepared,
} from './skill-files.js';
import { replacedDirectory } from './storage.js';

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
    handlers: pluginHandlers(ctx),
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

interface PluginPatch {
  readonly path: readonly string[];
  readonly before: string;
  readonly value: Json;
}
function pluginPatches(value: unknown): readonly PluginPatch[] {
  return extensionObjects(value).map(patch => {
    if (
      !Array.isArray(patch.path) ||
      !patch.path.every((part): part is string => typeof part === 'string') ||
      !Object.hasOwn(patch, 'value')
    )
      throw new Error('operation-record-invalid');
    return { path: patch.path, before: extensionString(patch.before), value: patch.value ?? null };
  });
}
function at(document: Record<string, unknown>, parts: readonly string[]): unknown {
  let value: unknown = document;
  for (const part of parts) value = object(value)[part];
  return value;
}
function patchOperation(
  itemId: string,
  suffix: string,
  file: string,
  document: Record<string, unknown>,
  values: readonly { path: readonly string[]; value: Json }[],
  dependsOn: readonly string[],
  changes: OperationDefinition['changes'],
): OperationDefinition {
  return {
    id: `${itemId}/${suffix}`,
    itemId,
    handler: 'plugin.fields',
    payload: { file, patches: values.map(value => ({ ...value, before: extensionDigest(at(document, value.path)) })) },
    dependsOn,
    writes: [file],
    changes,
  };
}

async function preparePlugin(ctx: Context, name: string, selection: Selection, describe?: Describe): Promise<Prepared> {
  if (!/^[\w.-]+@[\w.-]+$/.test(name)) throw new Error('invalid-plugin-id');
  const action = selection.action;
  if (!['install', 'connect', 'update', 'reinstall', 'detach'].includes(action)) throw new Error('action-unavailable');
  const itemId = selection.id;
  const marketplaceFile = path.join(ctx.claudeRoot, 'plugins/known_marketplaces.json');
  let markets: Record<string, unknown> | null = null;
  try {
    markets = await json(ctx.machine, marketplaceFile);
  } catch (error) {
    if (action !== 'detach' || errorCode(error) === 'cancelled') throw error;
  }
  const settings = await json(ctx.machine, ctx.settingsFile);
  const enabled = object(settings[ENABLED_PLUGINS_KEY])[name];
  const records = userPluginRecords((await pluginRecords(ctx))[name]);
  const beforeSnapshot = await pluginSnapshot(ctx, name);
  describe?.(pluginTitle(name, markets, records.length > 0 || enabled !== undefined));
  if (action === 'detach') {
    if (enabled !== true && (enabled !== undefined || !records.length)) throw new Error('no-connection');
    const disable = patchOperation(
      itemId,
      'disable',
      ctx.settingsFile,
      settings,
      [{ path: [ENABLED_PLUGINS_KEY, name], value: false }],
      [],
      [{ code: 'plugin-disable', detail: name }, { code: 'keep-plugin-files' }],
    );
    return extensionPrepared([
      {
        ...disable,
        payload: {
          ...disable.payload,
          ...(enabled !== true ? { pluginName: name, records: extensionDigest(records) } : {}),
        },
      },
    ]);
  }
  const source = pluginSource(name, markets ?? {});
  const declared = source === null ? declaredMarketSource(name, markets ?? {}) : null;
  if (source === null && declared === null) throw new Error('marketplace-source-conflict');
  const canReuse =
    (action === 'install' || action === 'connect') &&
    records.length > 0 &&
    (await Promise.all(records.map(record => pluginFilePresent(ctx, record)))).every(Boolean);
  if (action === 'connect' && !canReuse) throw new Error('plugin-not-ready');
  const operations: OperationDefinition[] = [];
  let dependencies: readonly string[] = [];
  if (action === 'reinstall') {
    const help = await claudeCommand(ctx, ['plugin', 'uninstall', '--help']);
    if (help.failed || help.code !== 0 || !help.stdout.includes('--keep-data'))
      throw new Error('plugin-keep-data-unconfirmed');
  }
  let frozen: JsonObject | null = null;
  if (!canReuse) {
    if (source === null) throw new Error('plugin-target-unpinned');
    const repository = `https://github.com/${source.repository}`;
    const declaredRef = object(object(markets?.[source.marketName]).source).ref;
    let revision: unknown;
    if (declaredRef === undefined)
      revision = success(await ctx.machine.execute('git', ['ls-remote', repository, 'HEAD'])).split(/\s+/)[0];
    else if (typeof declaredRef === 'string' && isGitRevision(declaredRef)) revision = declaredRef;
    else if (typeof declaredRef === 'string' && declaredRef.trim()) {
      const commit: unknown = JSON.parse(
        await ctx.machine.fetchText(
          `https://api.github.com/repos/${source.repository}/commits/${encodeURIComponent(declaredRef)}`,
        ),
      );
      revision = isObject(commit) ? commit.sha : undefined;
    }
    if (typeof revision !== 'string' || !isGitRevision(revision)) throw new Error('source-unavailable');
    const files = await ctx.machine.source(repository, revision, '.');
    const catalogFile = files.find(file => file.path === '.claude-plugin/marketplace.json');
    if (!catalogFile) throw new Error('invalid-marketplace');
    const catalog: unknown = JSON.parse(Buffer.from(catalogFile.data).toString('utf8'));
    if (!isObject(catalog) || catalog.name !== source.marketName || !Array.isArray(catalog.plugins))
      throw new Error('invalid-marketplace');
    const entry: unknown = catalog.plugins.find(
      (value: unknown) => isObject(value) && value.name === name.split('@')[0],
    );
    if (
      !isObject(entry) ||
      typeof entry.source !== 'string' ||
      !/^\.\/(?:[\w.-]+\/)*[\w.-]+$/.test(entry.source) ||
      entry.source
        .split('/')
        .slice(1)
        .some(part => part === '.' || part === '..')
    )
      throw new Error('plugin-target-unpinned');
    const folder = entry.source.slice(2);
    const pluginFiles = files
      .filter(file => file.path.startsWith(`${folder}/`))
      .map(file => ({ ...file, path: file.path.slice(folder.length + 1) }));
    if (!pluginFiles.length) throw new Error('plugin-payload-missing');
    const directory = path.join(ctx.claudeRoot, 'plugins/marketplaces', source.marketName);
    const market = object(markets?.[source.marketName]);
    if (market.installLocation !== undefined && market.installLocation !== directory)
      throw new Error('marketplace-location-conflict');
    const snapshot = [
      ...files.filter(file => file.path !== '.gcs-sha'),
      { path: '.gcs-sha', data: Buffer.from(revision) },
    ];
    const before = await ctx.machine.treeStamp(directory);
    const stage: OperationDefinition = {
      id: `${itemId}/marketplace-files`,
      itemId,
      handler: 'plugin.marketplace-files',
      dependsOn: [],
      writes: [directory],
      payload: {
        repository,
        revision,
        directory,
        before,
        destination: before === null ? null : path.join(replacedDirectory(ctx), `${randomUUID()}-${source.marketName}`),
        stamp: treeFilesStamp(snapshot),
      },
      changes: [{ code: `plugin-${action}`, detail: `${name} · ${revision.slice(0, 12)}` }],
    };
    const marketWrite = patchOperation(
      itemId,
      'marketplace-source',
      marketplaceFile,
      markets ?? {},
      [
        { path: [source.marketName, 'source', 'source'], value: 'github' },
        { path: [source.marketName, 'source', 'repo'], value: source.repository },
        { path: [source.marketName, 'source', 'ref'], value: revision },
        { path: [source.marketName, 'installLocation'], value: directory },
      ],
      [stage.id],
      [],
    );
    const extra = object(object(settings.extraKnownMarketplaces)[source.marketName]);
    const extraSource = object(extra.source);
    if (extra.source !== undefined && extraSource.repo !== source.repository)
      throw new Error('marketplace-source-conflict');
    const settingWrite = patchOperation(
      itemId,
      'marketplace-settings',
      ctx.settingsFile,
      settings,
      [
        { path: ['extraKnownMarketplaces', source.marketName, 'source', 'source'], value: 'github' },
        { path: ['extraKnownMarketplaces', source.marketName, 'source', 'repo'], value: source.repository },
        { path: ['extraKnownMarketplaces', source.marketName, 'source', 'ref'], value: revision },
      ],
      [marketWrite.id],
      [],
    );
    operations.push(stage, marketWrite, settingWrite);
    dependencies = [settingWrite.id];
    frozen = {
      directory,
      revision,
      marketplaceStamp: treeFilesStamp(snapshot),
      stamp: treeFilesStamp(pluginFiles),
      repository: source.repository,
      marketName: source.marketName,
    };
  }
  if (action === 'reinstall') {
    const remove: OperationDefinition = {
      id: `${itemId}/remove`,
      itemId,
      handler: 'plugin.command',
      dependsOn: dependencies,
      writes: [ctx.claudeRoot],
      payload: {
        name,
        verb: 'uninstall',
        keepData: true,
        beforeRecords: extensionDigest(records),
        beforeFiles: extensionDigest(beforeSnapshot.files),
        sourceIdentity: extensionDigest(source ?? declared),
        beforeEnabled: extensionDigest(enabled),
        source: frozen,
        successor: `${itemId}/command`,
      },
      changes: [{ code: 'plugin-keep-data' }, { code: 'plugin-credentials-removed' }],
    };
    operations.push(remove);
    dependencies = [remove.id];
  }
  const command: OperationDefinition = {
    id: `${itemId}/command`,
    itemId,
    handler: 'plugin.command',
    dependsOn: dependencies,
    writes: [ctx.claudeRoot],
    payload: {
      name,
      verb: canReuse ? 'enable' : action === 'update' ? 'update' : 'install',
      keepData: false,
      beforeRecords: extensionDigest(action === 'reinstall' ? [] : records),
      beforeFiles: extensionDigest(action === 'reinstall' ? [] : beforeSnapshot.files),
      sourceIdentity: extensionDigest(source ?? declared),
      beforeEnabled: extensionDigest(enabled),
      source: frozen,
      afterRemoval: action === 'reinstall' ? `${itemId}/remove` : null,
      reuse: canReuse,
    },
    changes: [{ code: canReuse ? 'plugin-reuse' : 'plugin-confirm', detail: name }, { code: 'new-session-required' }],
  };
  operations.push(command);
  if (name.startsWith('github@') && selection.fields?.secret) {
    const credential: OperationDefinition = {
      id: `${itemId}/credential`,
      itemId,
      handler: 'plugin.credential',
      dependsOn: [command.id],
      writes: [ctx.settingsFile],
      payload: {
        before: extensionDigest(object(settings.env).GITHUB_PERSONAL_ACCESS_TOKEN),
        after: extensionDigest(selection.fields.secret),
      },
      requiresInput: ['secret'],
      changes: [{ code: 'github-credential-configure' }],
    };
    operations.push(credential);
    return { ...extensionPrepared(operations), inputs: { [credential.id]: { secret: selection.fields.secret } } };
  }
  return extensionPrepared(operations);
}

async function pluginSnapshot(ctx: Context, name: string) {
  const records = userPluginRecords((await pluginRecords(ctx))[name]);
  const enabled = object((await json(ctx.machine, ctx.settingsFile))[ENABLED_PLUGINS_KEY])[name];
  const files = await Promise.all(
    records.map(async record => ({
      installPath: typeof record.installPath === 'string' ? record.installPath : null,
      version: typeof record.version === 'string' ? record.version : null,
      revision: typeof record.gitCommitSha === 'string' ? record.gitCommitSha : null,
      stamp: typeof record.installPath === 'string' ? await ctx.machine.treeStamp(record.installPath) : null,
    })),
  );
  return {
    records: extensionDigest(records),
    enabled: extensionDigest(enabled),
    enabledValue: enabled === true,
    files,
  };
}

function pluginHandlers(ctx: Context): Readonly<Record<string, OperationHandler>> {
  const capture = (name: string) => pluginSnapshot(ctx, name);
  const sourceIdentity = async (p: JsonObject) => {
    const markets = await json(ctx.machine, path.join(ctx.claudeRoot, 'plugins/known_marketplaces.json'));
    const name = extensionString(p.name);
    unchanged(extensionDigest(pluginSource(name, markets) ?? declaredMarketSource(name, markets)), p.sourceIdentity);
  };
  const sourceReady = async (source: JsonObject) => {
    const market = object(
      (await json(ctx.machine, path.join(ctx.claudeRoot, 'plugins/known_marketplaces.json')))[
        extensionString(source.marketName)
      ],
    );
    const known = object(market.source);
    const extra = object(
      object(
        object((await json(ctx.machine, ctx.settingsFile)).extraKnownMarketplaces)[extensionString(source.marketName)],
      ).source,
    );
    unchanged(known.repo, source.repository);
    unchanged(known.ref, source.revision);
    unchanged(extra.repo, source.repository);
    unchanged(extra.ref, source.revision);
    unchanged(
      (await ctx.machine.read(path.join(extensionString(source.directory), '.gcs-sha')))?.trim(),
      source.revision,
    );
    unchanged(await ctx.machine.treeStamp(extensionString(source.directory)), source.marketplaceStamp);
  };
  return {
    'plugin.fields': {
      async assess(definition, fact) {
        const patches = pluginPatches(definition.payload.patches);
        const current = await json(ctx.machine, extensionString(definition.payload.file));
        if (definition.payload.pluginName !== undefined)
          unchanged(
            extensionDigest(
              userPluginRecords((await pluginRecords(ctx))[extensionString(definition.payload.pluginName)]),
            ),
            definition.payload.records,
          );
        if (patches.every(patch => extensionDigest(at(current, patch.path)) === extensionDigest(patch.value)))
          return {
            state: 'complete',
            evidence: { matched: true },
            effects: definition.id.endsWith('/disable') ? [{ state: 'done', code: 'plugin-disabled' }] : [],
          };
        if (
          fact.status === 'confirmed' ||
          patches.some(patch => extensionDigest(at(current, patch.path)) !== patch.before)
        )
          return { state: 'unknown', problem: 'target-changed' };
        return { state: 'ready' };
      },
      async execute(definition) {
        const patches = pluginPatches(definition.payload.patches);
        if (definition.payload.pluginName !== undefined)
          unchanged(
            extensionDigest(
              userPluginRecords((await pluginRecords(ctx))[extensionString(definition.payload.pluginName)]),
            ),
            definition.payload.records,
          );
        await ctx.effects.editJson(extensionString(definition.payload.file), document => {
          for (const patch of patches) {
            unchanged(extensionDigest(at(document, patch.path)), patch.before);
            let parent = document;
            for (const part of patch.path.slice(0, -1)) {
              const child = object(parent[part]);
              parent[part] = child;
              parent = child;
            }
            parent[patch.path.at(-1)!] = patch.value;
          }
        });
        return { receipt: { kind: 'returned', failure: null }, evidence: { matched: true } };
      },
    },
    'plugin.marketplace-files': {
      async assess(definition, fact) {
        const p = definition.payload;
        const stamp = await ctx.machine.treeStamp(extensionString(p.directory));
        if (stamp === p.stamp) return { state: 'complete', evidence: { stamp } };
        if (fact.status === 'confirmed' || stamp !== p.before) return { state: 'unknown', problem: 'target-changed' };
        return { state: 'ready' };
      },
      async execute(definition) {
        const p = definition.payload;
        const fetched = await ctx.machine.source(extensionString(p.repository), extensionString(p.revision), '.');
        const files = [
          ...fetched.filter(file => file.path !== '.gcs-sha'),
          { path: '.gcs-sha', data: Buffer.from(extensionString(p.revision)) },
        ];
        unchanged(treeFilesStamp(files), p.stamp);
        await ctx.effects.replaceTree(
          extensionString(p.directory),
          files,
          extensionNullableString(p.before),
          p.destination === null ? undefined : extensionString(p.destination),
        );
        return {
          receipt: { kind: 'returned', failure: null },
          evidence: { stamp: await ctx.machine.treeStamp(extensionString(p.directory)) },
        };
      },
    },
    'plugin.command': {
      async assess(definition, fact, facts) {
        const p = definition.payload;
        await sourceIdentity(p);
        const current = await capture(extensionString(p.name));
        if (p.source) await sourceReady(extensionObject(p.source));
        if (p.verb === 'uninstall') {
          const successor = facts[extensionString(p.successor)];
          if (successor?.status === 'confirmed' && fact.receipt?.kind === 'returned' && !fact.receipt.failure)
            return {
              state: 'complete',
              evidence: fact.evidence ?? {},
              effects: [{ state: 'done', code: 'plugin-removed' }],
            };
          if (current.files.length === 0 && !current.enabledValue)
            return { state: 'complete', evidence: current, effects: [{ state: 'done', code: 'plugin-removed' }] };
        } else {
          const reusedFilesMatch =
            current.records === p.beforeRecords && extensionDigest(current.files) === p.beforeFiles;
          const valid =
            current.files.length > 0 &&
            current.files.every(
              file =>
                file.stamp !== null &&
                (p.reuse
                  ? reusedFilesMatch
                  : file.revision === extensionObject(p.source).revision &&
                    file.stamp === extensionObject(p.source).stamp),
            ) &&
            current.enabledValue;
          if (valid && (p.reuse || (fact.receipt?.kind === 'returned' && !fact.receipt.failure))) {
            if (fact.evidence?.records && current.records !== fact.evidence.records)
              return { state: 'unknown', problem: 'program-changed' };
            return {
              state: 'complete',
              evidence: current,
              effects: [{ state: 'done', code: 'plugin-ready', detail: extensionString(p.name) }],
            };
          }
        }
        if (fact.status === 'confirmed') return { state: 'unknown', problem: 'plugin-not-ready' };
        if (fact.attemptId && fact.receipt?.kind !== 'returned')
          return { state: 'unknown', problem: 'program-installation-unconfirmed' };
        if (fact.receipt?.kind === 'returned' && !fact.receipt.failure)
          return { state: 'unknown', problem: 'plugin-not-ready' };
        const removed = p.afterRemoval ? facts[extensionString(p.afterRemoval)] : undefined;
        unchanged(current.records, p.beforeRecords);
        unchanged(extensionDigest(current.files), p.beforeFiles);
        unchanged(current.enabled, removed?.evidence?.enabled ?? p.beforeEnabled);
        return { state: 'ready', dispatch: { records: current.records, enabled: current.enabled } };
      },
      async execute(definition) {
        const p = definition.payload;
        await sourceIdentity(p);
        if (p.source) await sourceReady(extensionObject(p.source));
        const result = await claudeCommand(ctx, [
          'plugin',
          extensionString(p.verb),
          extensionString(p.name),
          '--scope',
          'user',
          ...(p.keepData ? ['--keep-data'] : []),
        ]);
        const receipt = {
          kind: 'returned' as const,
          failure: result.failed || result.code !== 0 ? 'plugin-command-failed' : null,
        };
        try {
          return { receipt, evidence: await capture(extensionString(p.name)) };
        } catch {
          return { receipt };
        }
      },
    },
    'plugin.credential': {
      async assess(definition, fact) {
        const current = extensionDigest(
          object((await json(ctx.machine, ctx.settingsFile)).env).GITHUB_PERSONAL_ACCESS_TOKEN,
        );
        if (current === definition.payload.after)
          return {
            state: 'complete',
            evidence: { matched: true },
            effects: [{ state: 'done', code: 'github-credential-saved' }],
          };
        if (fact.status === 'confirmed' || current !== definition.payload.before)
          return { state: 'unknown', problem: 'target-changed' };
        return { state: 'ready' };
      },
      async execute(definition, _fact, inputs) {
        unchanged(extensionDigest(inputs.secret), definition.payload.after);
        await ctx.effects.editJson(ctx.settingsFile, document => {
          const env = object(document.env);
          unchanged(extensionDigest(env.GITHUB_PERSONAL_ACCESS_TOKEN), definition.payload.before);
          env.GITHUB_PERSONAL_ACCESS_TOKEN = inputs.secret;
          document.env = env;
        });
        return { receipt: { kind: 'returned', failure: null }, evidence: { matched: true } };
      },
    },
  };
}
