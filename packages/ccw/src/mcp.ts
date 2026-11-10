import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { knownTitle } from './titles.js';
import { mcpSpecs, officeIntegration } from './management-catalog.js';
import { errorCode, isObject } from './machine.js';
import { MCP_SERVERS_KEY, readMcpServers, restOf, success, unchanged, userBinary, userBinDirectory } from './model.js';
import { isExactVersion } from './npm-registry.js';
import type {
  Context,
  Describe,
  Domain,
  Item,
  Prepared,
  Selection,
  OperationDefinition,
  OperationHandler,
  JsonObject,
} from './model.js';
import { hasLegacyAmircPermissions, prepareLegacyAmircDetach, legacyAmircHandlers } from './legacy-amirc.js';
import { extensionDigest, extensionPrepared } from './skill-files.js';
import { installScratch } from './storage.js';

const MCP_PROTOCOLS: Readonly<Record<string, readonly string[]>> = {
  http: ['http:', 'https:'],
  'streamable-http': ['http:', 'https:'],
  sse: ['http:', 'https:'],
  ws: ['ws:', 'wss:'],
};
function validRegistration(value: unknown) {
  if (!isObject(value)) return false;
  if (value.type === undefined || value.type === 'stdio')
    return (
      typeof value.command === 'string' &&
      Boolean(value.command.trim()) &&
      (value.args === undefined || (Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string')))
    );
  const protocols = typeof value.type === 'string' ? MCP_PROTOCOLS[value.type] : undefined;
  if (protocols === undefined || typeof value.url !== 'string') return false;
  try {
    return protocols.includes(new URL(value.url).protocol);
  } catch {
    return false;
  }
}

/** Serena 命令形状判定：注册身份确认与更新渠道守卫共用同一谓词 */
const isSerenaCommand = (command: string): boolean => /(?:^|[\\/])serena(?:\.exe)?$/.test(command);

/** 以本地形状证据判定注册身份：与 CCW 写入模板一致才算确认，证据不足保留原始键名；
 *  不联网、不启动程序 */
function confirmedMcpTitle(name: string, registration: unknown): string {
  if (registration === undefined) return knownTitle(`mcp:${name}`, name);
  if (!Object.hasOwn(mcpSpecs, name) || !isObject(registration) || !validRegistration(registration)) return name;
  if (name === 'context7')
    return (registration.type === 'http' || registration.type === 'streamable-http') &&
      registration.url === mcpSpecs.context7.registration.url
      ? knownTitle('mcp:context7')
      : name;
  if (name === 'serena')
    return (registration.type === undefined || registration.type === 'stdio') &&
      typeof registration.command === 'string' &&
      isSerenaCommand(registration.command) &&
      Array.isArray(registration.args) &&
      registration.args[0] === mcpSpecs.serena.registration.args[0]
      ? knownTitle('mcp:serena')
      : name;
  return name;
}
/** 创建 MCP 域渠道：检查数组归一为聚合，余段即注册名；裸函数仍供跨域调用 */
export function createMcpDomain(ctx: Context): Domain {
  return {
    handlers: { ...mcpHandlers(ctx), ...legacyAmircHandlers(ctx) },
    async inspect() {
      return { items: await inspectMcp(ctx), problems: [] };
    },
    prepare(selection, describe) {
      const name = restOf(selection.id);
      if (name === undefined) throw new Error('unknown-selection');
      return prepareMcp(ctx, name, selection, describe ? { describe } : {});
    },
  };
}

/** 区分退役 AMIRC 许可的存在、缺失与读取未知 */
type LegacyAmircPermissionEvidence =
  { readonly kind: 'present' } | { readonly kind: 'absent' } | { readonly kind: 'unknown'; readonly problem: string };

/**
 * 判定退役 AMIRC 许可证据
 *
 * @returns 读取失败时返回 unknown，不以 absent 代替
 */
async function readLegacyAmircPermissionEvidence(ctx: Context): Promise<LegacyAmircPermissionEvidence> {
  try {
    return (await hasLegacyAmircPermissions(ctx)) ? { kind: 'present' } : { kind: 'absent' };
  } catch (error) {
    return { kind: 'unknown', problem: errorCode(error) };
  }
}

async function inspectMcp(ctx: Context): Promise<Item[]> {
  // 注册文件不可读时方案入口降级可见（带问题、无资格），与插件族同形，不整族消失
  let registrations: Record<string, unknown> = {};
  let readProblem: string | undefined;
  try {
    registrations = await readMcpServers(ctx);
  } catch (error) {
    readProblem = errorCode(error);
  }
  const result: Item[] = [];
  const legacyAmircPermissionEvidence = await readLegacyAmircPermissionEvidence(ctx);
  for (const name of new Set([
    ...Object.keys(mcpSpecs),
    ...Object.keys(registrations),
    ...(legacyAmircPermissionEvidence.kind !== 'absent' ? ['amirc'] : []),
  ])) {
    const isRegistered = registrations[name] !== undefined;
    const isOffered = Object.hasOwn(mcpSpecs, name);
    const hasAmircPermissions = name === 'amirc' && legacyAmircPermissionEvidence.kind === 'present';
    let problem: string | undefined =
      name === 'amirc' && legacyAmircPermissionEvidence.kind === 'unknown'
        ? legacyAmircPermissionEvidence.problem
        : undefined;
    if (isRegistered && !validRegistration(registrations[name])) problem = 'invalid-mcp-registration';
    const itemProblem = problem ?? readProblem;
    // 许可证据未知时 AMIRC 不因注册在档获得解除资格，其余条目不受此证据影响
    const canDetach =
      readProblem === undefined &&
      (name !== 'amirc' || legacyAmircPermissionEvidence.kind !== 'unknown') &&
      (isRegistered || hasAmircPermissions);
    result.push({
      id: `mcp:${name}`,
      title: confirmedMcpTitle(name, registrations[name]),
      kind: 'mcp',
      canInstall: isOffered && readProblem === undefined,
      location: ctx.stateFile,
      facts: [
        ...(readProblem === undefined ? [{ code: isRegistered ? 'registration-exists' : 'not-registered' }] : []),
        ...(hasAmircPermissions ? [{ code: 'amirc-permissions-present' }] : []),
      ],
      ...(itemProblem !== undefined ? { problem: itemProblem } : {}),
      actions: [
        ...(isOffered && readProblem === undefined
          ? isRegistered
            ? ['connect' as const, ...(name === 'serena' ? ['update' as const] : []), 'reinstall' as const]
            : ['install' as const]
          : []),
        ...(canDetach ? ['detach' as const] : []),
      ],
    });
  }
  return result;
}

interface PrepareMcpOptions {
  readonly registration?: () => Record<string, unknown>;
  readonly hasDetached?: boolean;
  readonly describe?: Describe;
}

export async function prepareMcp(
  ctx: Context,
  name: string,
  selection: Selection,
  options: PrepareMcpOptions = {},
): Promise<Prepared> {
  if (name === 'amirc' && selection.action === 'detach') return prepareLegacyAmircDetach(ctx);
  if (name === 'amirc') throw new Error('action-unavailable');
  const before = await readMcpServers(ctx);
  options.describe?.(confirmedMcpTitle(name, before[name]));
  const action = selection.action;
  if (
    !['install', 'connect', 'update', 'reinstall', 'detach'].includes(action) ||
    (action === 'update' && name !== 'serena')
  )
    throw new Error('action-unavailable');
  const itemId = selection.id;
  if (action === 'detach') {
    if (before[name] === undefined) throw new Error('no-connection');
    return extensionPrepared([
      registrationOperation(ctx, itemId, name, extensionDigest(before[name]), null, [], 'remove'),
    ]);
  }
  if (!/^[\w.:-]+$/.test(name)) throw new Error('invalid-mcp-name');
  if (!Object.hasOwn(mcpSpecs, name) && options.registration === undefined) throw new Error('not-in-update-catalog');
  if (action === 'install' && validRegistration(before[name]) && Object.keys(selection.fields ?? {}).length === 0)
    return extensionPrepared([
      {
        id: `${itemId}/keep`,
        itemId,
        handler: 'mcp.keep',
        payload: { name, expected: extensionDigest(before[name]) },
        dependsOn: [],
        writes: [],
        changes: [{ code: 'registration-kept', detail: name }],
      },
    ]);
  const value = isObject(before[name]) ? before[name] : {};
  if (
    name === 'serena' &&
    action === 'update' &&
    (typeof value.command !== 'string' || !isSerenaCommand(value.command))
  )
    throw new Error('channel-change-required');
  const operations: OperationDefinition[] = [];
  let dependencies: readonly string[] = [];
  let expected = extensionDigest(options.hasDetached ? undefined : before[name]);
  if (action === 'reinstall' && !options.hasDetached && before[name] !== undefined) {
    const remove = registrationOperation(ctx, itemId, name, expected, null, [], 'remove');
    operations.push(remove);
    expected = extensionDigest(undefined);
    dependencies = [remove.id];
  }
  let target: Record<string, unknown>;
  let credentialMode: 'input' | 'preserve' | 'none' = 'none';
  if (name === 'context7') {
    target = { ...mcpSpecs.context7.registration };
    credentialMode = selection.fields?.secret ? 'input' : value.headers !== undefined ? 'preserve' : 'none';
  } else if (options.registration) {
    target = options.registration();
    if (target.headers !== undefined || target.env !== undefined && (name !== 'officecli' || extensionDigest(target.env) !== extensionDigest(officeIntegration.mcp.env)))
      throw new Error('registration-credential-unsupported');
  } else {
    const release: unknown = JSON.parse(await ctx.machine.fetchText(mcpSpecs.serena.release.metadataUrl));
    if (!isObject(release) || !isObject(release.info) || !isExactVersion(release.info.version))
      throw new Error('invalid-release');
    let uv = (await ctx.machine.locate('uv'))[0];
    const local = userBinary(ctx, 'uv');
    if (uv === undefined && (await ctx.machine.treeStamp(local)) !== null) uv = local;
    let uvDependency: string | null = null;
    if (uv === undefined) {
      const extension = ctx.platform === 'win32' ? 'ps1' : 'sh';
      const script = await ctx.machine.fetchText(`https://astral.sh/uv/install.${extension}`);
      const version = /(?:\$app_version\s*=\s*['"]|APP_VERSION=['"])(\d+\.\d+\.\d+)['"]/.exec(script)?.[1];
      if (!version) throw new Error('uv-target-unpinned');
      const file = installScratch(ctx, `uv-${randomUUID()}.${extension}`);
      const stage: OperationDefinition = {
        id: `${itemId}/uv-script`,
        itemId,
        handler: 'mcp.uv-script',
        dependsOn: dependencies,
        writes: [file],
        payload: { file, script, digest: extensionDigest(script) },
        changes: [{ code: 'uv-python-dependency' }],
      };
      const install: OperationDefinition = {
        id: `${itemId}/uv-install`,
        itemId,
        handler: 'mcp.uv-install',
        dependsOn: [stage.id],
        writes: [local],
        payload: { file, scriptDigest: extensionDigest(script), uv: local, version },
        changes: [],
      };
      const clean: OperationDefinition = {
        id: `${itemId}/uv-script-remove`,
        itemId,
        handler: 'mcp.uv-script-remove',
        dependsOn: [install.id],
        writes: [file],
        payload: { file, digest: extensionDigest(script) },
        changes: [],
      };
      operations.push(stage, install, clean);
      dependencies = [install.id];
      uvDependency = install.id;
      uv = local;
    }
    const uvStamp = uvDependency ? null : await ctx.machine.treeStamp(uv);
    if (uvDependency === null && uvStamp === null) throw new Error('program-not-ready');
    const bin = uvDependency
      ? userBinDirectory(ctx)
      : success(await ctx.machine.execute(uv, ['tool', 'dir', '--bin'])).trim();
    if (!path.isAbsolute(bin) || /[\r\n]/.test(bin)) throw new Error('invalid-tool-directory');
    const command = path.join(bin, ctx.platform === 'win32' ? 'serena.exe' : 'serena');
    const runtime: OperationDefinition = {
      id: `${itemId}/runtime`,
      itemId,
      handler: 'mcp.serena-runtime',
      dependsOn: dependencies,
      writes: [command],
      payload: {
        uv,
        uvStamp,
        uvDependency,
        bin,
        command,
        version: release.info.version,
        beforeStamp: await ctx.machine.treeStamp(command),
        reinstall: action === 'reinstall',
      },
      changes: [
        {
          code: action === 'update' ? 'mcp-program-update' : 'uv-python-dependency',
          detail: `serena · ${release.info.version}`,
        },
      ],
    };
    operations.push(runtime);
    dependencies = [runtime.id];
    if (action !== 'update') {
      const init: OperationDefinition = {
        id: `${itemId}/initialize`,
        itemId,
        handler: 'mcp.serena-initialize',
        dependsOn: dependencies,
        writes: [path.join(ctx.home, '.serena')],
        payload: { command, runtime: runtime.id },
        changes: [{ code: 'serena-initialize' }],
      };
      operations.push(init);
      dependencies = [init.id];
    }
    target = { command, args: [...mcpSpecs.serena.registration.args] };
  }
  if (action !== 'update') {
    const completeTarget = {
      ...target,
      ...(credentialMode === 'input'
        ? { headers: { Authorization: `Bearer ${selection.fields!.secret}` } }
        : credentialMode === 'preserve'
          ? { headers: value.headers }
          : {}),
    };
    const write = registrationOperation(ctx, itemId, name, expected, target as JsonObject, dependencies, 'save');
    operations.push({
      ...write,
      payload: {
        ...write.payload,
        after: extensionDigest(completeTarget),
        credentialMode,
        headers: credentialMode === 'preserve' ? extensionDigest(value.headers) : null,
      },
      ...(credentialMode === 'input' ? { requiresInput: ['secret'] } : {}),
    });
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index]!;
      if (operation.handler === 'mcp.registration' && operation.payload.target === null)
        operations[index] = { ...operation, payload: { ...operation.payload, supersededBy: write.id } };
    }
  }
  const result = extensionPrepared(operations);
  return credentialMode === 'input'
    ? { ...result, inputs: { [`${itemId}/registration-save`]: { secret: selection.fields!.secret! } } }
    : result;
}

function registrationOperation(
  ctx: Context,
  itemId: string,
  name: string,
  before: string,
  target: JsonObject | null,
  dependsOn: readonly string[],
  verb: 'remove' | 'save',
): OperationDefinition {
  return {
    id: `${itemId}/registration-${verb}`,
    itemId,
    handler: 'mcp.registration',
    payload: {
      file: ctx.stateFile,
      name,
      before,
      after: extensionDigest(target === null ? undefined : target),
      target,
      credentialMode: 'none',
      headers: null,
    },
    dependsOn,
    writes: [ctx.stateFile],
    changes:
      verb === 'remove'
        ? [
            { code: 'mcp-remove-registration', detail: name },
            { code: 'mcp-keep-runtime' },
            { code: 'mcp-auth-unchanged' },
          ]
        : [{ code: 'mcp-register', detail: name }],
  };
}

export function mcpHandlers(ctx: Context): Readonly<Record<string, OperationHandler>> {
  const toolPresent = async (p: JsonObject, facts: Readonly<Record<string, import('./model.js').OperationFact>>) => {
    unchanged(
      await ctx.machine.treeStamp(String(p.uv)),
      p.uvDependency ? facts[String(p.uvDependency)]?.evidence?.stamp : p.uvStamp,
    );
    const text = success(
      await ctx.machine.execute(String(p.uv), ['tool', 'list'], { env: { UV_TOOL_BIN_DIR: String(p.bin) } }),
    );
    return (
      text
        .split('\n')
        .some(
          line => line.trim().split(/\s+/).slice(0, 2).join(' ') === `${mcpSpecs.serena.release.package} v${p.version}`,
        ) && (await ctx.machine.treeStamp(String(p.command))) !== null
    );
  };
  return {
    'mcp.uv-script': {
      async assess(definition, _fact, facts) {
        const p = definition.payload;
        if (facts[definition.id.replace('/uv-script', '/uv-script-remove')]?.status === 'confirmed')
          return { state: 'complete', evidence: { cleaned: true } };
        const text = await ctx.machine.read(String(p.file));
        if (extensionDigest(text) === p.digest) return { state: 'complete', evidence: { digest: p.digest! } };
        return text === null ? { state: 'ready' } : { state: 'unknown', problem: 'target-changed' };
      },
      async execute(definition) {
        await ctx.effects.initialize(String(definition.payload.file), String(definition.payload.script));
        return {
          receipt: { kind: 'returned', failure: null },
          evidence: { digest: extensionDigest(await ctx.machine.read(String(definition.payload.file))) },
        };
      },
    },
    'mcp.uv-install': {
      async assess(definition, fact, facts) {
        const p = definition.payload;
        const stamp = await ctx.machine.treeStamp(String(p.uv));
        if (stamp !== null && fact.receipt?.kind === 'returned' && !fact.receipt.failure) {
          if (fact.evidence?.stamp !== undefined && stamp !== fact.evidence.stamp)
            return { state: 'unknown', problem: 'program-changed' };
          const version = success(await ctx.machine.execute(String(p.uv), ['--version']))
            .trim()
            .split(/\s+/)[1];
          return version === p.version
            ? { state: 'complete', evidence: { stamp }, effects: [{ state: 'done', code: 'uv-installed' }] }
            : { state: 'unknown', problem: 'binary-version-mismatch' };
        }
        if (fact.attemptId || stamp !== null) return { state: 'unknown', problem: 'program-installation-unconfirmed' };
        unchanged(extensionDigest(await ctx.machine.read(String(p.file))), p.scriptDigest);
        return { state: 'ready' };
      },
      async execute(definition) {
        const p = definition.payload;
        unchanged(extensionDigest(await ctx.machine.read(String(p.file))), p.scriptDigest);
        const result = await ctx.effects.execute(
          ctx.platform === 'win32' ? 'powershell.exe' : 'sh',
          ctx.platform === 'win32'
            ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', String(p.file)]
            : [String(p.file)],
          {
            env: {
              UV_DOWNLOAD_URL: `https://github.com/astral-sh/uv/releases/download/${p.version}`,
              UV_NO_MODIFY_PATH: '1',
              UV_INSTALL_DIR: userBinDirectory(ctx),
              UV_UNMANAGED_INSTALL: userBinDirectory(ctx),
            },
          },
        );
        const receipt = {
          kind: 'returned' as const,
          failure: result.failed || result.code !== 0 ? 'uv-install-failed' : null,
        };
        try {
          return { receipt, evidence: { stamp: await ctx.machine.treeStamp(String(p.uv)) } };
        } catch {
          return { receipt };
        }
      },
    },
    'mcp.uv-script-remove': {
      async assess(definition) {
        const text = await ctx.machine.read(String(definition.payload.file));
        if (text === null) return { state: 'complete', evidence: { absent: true } };
        unchanged(extensionDigest(text), definition.payload.digest);
        return { state: 'ready', dispatch: { stamp: await ctx.machine.treeStamp(String(definition.payload.file)) } };
      },
      async execute(definition, fact) {
        await ctx.effects.removeTree(String(definition.payload.file), String(fact.dispatch!.stamp));
        return {
          receipt: { kind: 'returned', failure: null },
          evidence: { absent: (await ctx.machine.read(String(definition.payload.file))) === null },
        };
      },
    },
    'mcp.keep': {
      async assess(definition) {
        unchanged(
          extensionDigest((await readMcpServers(ctx))[String(definition.payload.name)]),
          definition.payload.expected,
        );
        return {
          state: 'complete',
          evidence: { matched: true },
          effects: [{ state: 'kept', code: 'registration-kept', detail: String(definition.payload.name) }],
        };
      },
      async execute() {
        throw new Error('operation-unavailable');
      },
    },
    'mcp.registration': {
      async assess(definition, fact, facts) {
        const p = definition.payload;
        if (p.file !== ctx.stateFile) return { state: 'blocked', problem: 'target-changed' };
        const current = (await readMcpServers(ctx))[String(p.name)];
        const target = extensionDigest(current);
        const successor = typeof p.supersededBy === 'string' ? facts[p.supersededBy] : undefined;
        if (p.target === null && successor?.status === 'confirmed' && successor.evidence?.target === target)
          return {
            state: 'complete',
            evidence: { superseded: true },
            effects: [{ state: 'done', code: 'registration-removed', detail: String(p.name) }],
          };
        if (target === p.after)
          return {
            state: 'complete',
            evidence: { matched: true, target },
            effects: [
              {
                state: 'done',
                code: p.target === null ? 'registration-removed' : 'registration-saved',
                detail: String(p.name),
              },
            ],
          };
        if (fact.status === 'confirmed' || extensionDigest(current) !== p.before)
          return { state: 'unknown', problem: 'target-changed' };
        return { state: 'ready', dispatch: { before: String(p.before) } };
      },
      async execute(definition, _fact, inputs) {
        const p = definition.payload;
        await ctx.effects.editJson(ctx.stateFile, document => {
          const registrations: Record<string, unknown> = isObject(document[MCP_SERVERS_KEY])
            ? document[MCP_SERVERS_KEY]
            : {};
          unchanged(extensionDigest(registrations[String(p.name)]), p.before);
          if (p.target === null) delete registrations[String(p.name)];
          else {
            const target = { ...(p.target as JsonObject) };
            if (p.credentialMode === 'input') {
              if (!inputs.secret) throw new Error('credential-required');
              target.headers = { Authorization: `Bearer ${inputs.secret}` };
            } else if (p.credentialMode === 'preserve') {
              const existing = registrations[String(p.name)];
              const headers = isObject(existing) ? existing.headers : undefined;
              unchanged(extensionDigest(headers), p.headers);
              target.headers = headers as JsonObject;
            }
            unchanged(extensionDigest(target), p.after);
            registrations[String(p.name)] = target;
          }
          document[MCP_SERVERS_KEY] = registrations;
        });
        const receipt = { kind: 'returned' as const, failure: null };
        try {
          const target = extensionDigest((await readMcpServers(ctx))[String(p.name)]);
          return { receipt, evidence: { matched: target === p.after, target } };
        } catch {
          return { receipt };
        }
      },
    },
    'mcp.serena-runtime': {
      async assess(definition, fact, facts) {
        const p = definition.payload;
        if (p.uvDependency && facts[String(p.uvDependency)]?.status !== 'confirmed')
          return { state: 'blocked', problem: 'dependency-not-ready' };
        const present = await toolPresent(p, facts);
        if (
          present &&
          ((!p.reinstall && !fact.attemptId) || (fact.receipt?.kind === 'returned' && !fact.receipt.failure))
        ) {
          const stamp = await ctx.machine.treeStamp(String(p.command));
          if (fact.evidence?.stamp !== undefined && fact.evidence.stamp !== stamp)
            return { state: 'unknown', problem: 'program-changed' };
          return { state: 'complete', evidence: { stamp }, effects: [{ state: 'done', code: 'serena-installed' }] };
        }
        if (
          fact.status === 'confirmed' ||
          (fact.attemptId && (fact.receipt?.kind !== 'returned' || !fact.receipt.failure))
        )
          return { state: 'unknown', problem: 'program-installation-unconfirmed' };
        unchanged(await ctx.machine.treeStamp(String(p.command)), p.beforeStamp);
        return { state: 'ready', dispatch: { beforeStamp: p.beforeStamp! } };
      },
      async execute(definition) {
        const p = definition.payload;
        const result = await ctx.effects.execute(
          String(p.uv),
          [
            'tool',
            'install',
            '--python',
            mcpSpecs.serena.release.python,
            '--upgrade',
            ...(p.reinstall ? ['--reinstall'] : []),
            `${mcpSpecs.serena.release.package}==${p.version}`,
          ],
          { env: { UV_TOOL_BIN_DIR: String(p.bin) } },
        );
        const receipt = {
          kind: 'returned' as const,
          failure: result.failed || result.code !== 0 ? 'serena-install-failed' : null,
        };
        try {
          return { receipt, evidence: { stamp: await ctx.machine.treeStamp(String(p.command)) } };
        } catch {
          return { receipt };
        }
      },
    },
    'mcp.serena-initialize': {
      async assess(definition, fact, facts) {
        const runtime = facts[String(definition.payload.runtime)];
        unchanged(await ctx.machine.treeStamp(String(definition.payload.command)), runtime?.evidence?.stamp);
        if (fact.receipt?.kind === 'returned' && !fact.receipt.failure)
          return {
            state: 'complete',
            evidence: { initialized: true },
            effects: [{ state: 'done', code: 'serena-initialized' }],
          };
        if (fact.attemptId) return { state: 'unknown', problem: 'serena-initialization-unconfirmed' };
        return { state: 'ready' };
      },
      async execute(definition) {
        const result = await ctx.effects.execute(String(definition.payload.command), ['init']);
        return {
          receipt: {
            kind: 'returned',
            failure: result.failed || result.code !== 0 ? 'serena-initialization-failed' : null,
          },
          evidence: { initialized: !result.failed && result.code === 0 },
        };
      },
    },
  };
}
