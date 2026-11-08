import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { knownTitle } from './titles.js';
import { mcpSpecs } from './management-catalog.js';
import { errorCode, isObject } from './machine.js';
import { cancelled, editFields, json, object, removeFields, restOf, success, unchanged } from './model.js';
import type { Context, Describe, Domain, Item, Prepared, Selection } from './model.js';
import { hasLegacyAmircPermissions, prepareLegacyAmircDetach } from './legacy-amirc.js';

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
      /(?:^|[\\/])serena(?:\.exe)?$/.test(registration.command) &&
      Array.isArray(registration.args) &&
      registration.args[0] === mcpSpecs.serena.registration.args[0]
      ? knownTitle('mcp:serena')
      : name;
  return name;
}
/** 创建 MCP 域渠道：检查数组归一为聚合，余段即注册名；裸函数仍供跨域调用 */
export function createMcpDomain(ctx: Context): Domain {
  return {
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
    registrations = object((await json(ctx.machine, ctx.stateFile)).mcpServers);
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
  /** 目录外产品的完整注册对象，由所属领域提供（如 officecli 的连接形状） */
  readonly registration?: () => Record<string, unknown>;
  /** 程序卸载后重挂接入：先清旧注册再写新注册 */
  readonly hasDetached?: boolean;
  /** 证据读取后补全计划标题 */
  readonly describe?: Describe;
}

export async function prepareMcp(
  ctx: Context,
  name: string,
  selection: Selection,
  options: PrepareMcpOptions = {},
): Promise<Prepared> {
  const { registration: customRegistration, hasDetached = false, describe } = options;
  if (name === 'amirc' && selection.action === 'detach') return prepareLegacyAmircDetach(ctx);
  if (name === 'amirc') throw new Error('action-unavailable');
  const before = object((await json(ctx.machine, ctx.stateFile)).mcpServers);
  describe?.(confirmedMcpTitle(name, before[name]));
  const action = selection.action;
  if (
    !['install', 'connect', 'update', 'reinstall', 'detach'].includes(action) ||
    (action === 'update' && name !== 'serena')
  )
    throw new Error('action-unavailable');
  if (action === 'detach' && before[name] === undefined) throw new Error('no-connection');
  if (action === 'detach')
    return removeFields(
      ctx,
      ctx.stateFile,
      { [name]: before[name] },
      [{ code: 'mcp-remove-registration', detail: name }, { code: 'mcp-keep-runtime' }, { code: 'mcp-auth-unchanged' }],
      { state: 'done', code: 'registration-removed', detail: name },
      'mcpServers',
    );
  if (!/^[\w.:-]+$/.test(name)) throw new Error('invalid-mcp-name');
  if (!Object.hasOwn(mcpSpecs, name) && customRegistration === undefined) throw new Error('not-in-update-catalog');
  const value = isObject(before[name]) ? before[name] : {};
  if (action === 'install' && validRegistration(before[name]) && Object.keys(selection.fields ?? {}).length === 0) {
    return {
      changes: [{ code: 'registration-kept', detail: name }],
      async run(report) {
        unchanged(object((await json(ctx.machine, ctx.stateFile)).mcpServers)[name], value);
        report({ state: 'kept', code: 'registration-kept', detail: name });
      },
      async verify() {
        unchanged(object((await json(ctx.machine, ctx.stateFile)).mcpServers)[name], value);
      },
    };
  }
  if (hasDetached) before[name] = undefined;
  if (
    name === 'serena' &&
    action === 'update' &&
    (typeof value.command !== 'string' || !/(^|[\\/])serena(?:\.exe)?$/.test(value.command))
  )
    throw new Error('channel-change-required');
  let registration: Record<string, unknown>;
  let targetVersion: string | undefined;
  if (name === 'context7')
    registration = {
      ...mcpSpecs.context7.registration,
      ...(selection.fields?.secret
        ? { headers: { Authorization: `Bearer ${selection.fields.secret}` } }
        : value.headers !== undefined
          ? { headers: value.headers }
          : {}),
    };
  else if (customRegistration !== undefined) registration = customRegistration();
  else {
    const release: unknown = JSON.parse(await ctx.machine.fetchText(mcpSpecs.serena.release.metadataUrl));
    if (
      !isObject(release) ||
      !isObject(release.info) ||
      typeof release.info.version !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(release.info.version)
    )
      throw new Error('invalid-release');
    targetVersion = release.info.version;
    registration = {
      command: 'serena',
      args: [...mcpSpecs.serena.registration.args],
    };
  }
  let isRemoved = false;
  let isToolReady = false;
  let isInitialized = false;
  let isRegistrationSaved = false;
  let toolStamp: string | null = null;
  return {
    get changes() {
      if (isRegistrationSaved) return [{ code: 'mcp-registration-confirm', detail: name }];
      return [
        {
          code: action === 'update' ? 'mcp-program-update' : 'mcp-register',
          detail: `${name}${targetVersion ? ` · ${targetVersion}` : ''}`,
        },
        ...(before[name] !== undefined && action !== 'update' ? [{ code: 'replace-existing-registration' }] : []),
        ...(name === 'serena' && !isToolReady ? [{ code: 'uv-python-dependency' }] : []),
        ...(name === 'serena' && !isInitialized && action !== 'update' ? [{ code: 'serena-initialize' }] : []),
        ...(action === 'reinstall' && !isRemoved ? [{ code: 'disconnect-before-reinstall' }] : []),
      ];
    },
    async run(report, signal) {
      unchanged(object((await json(ctx.machine, ctx.stateFile)).mcpServers)[name], before[name]);
      cancelled(signal);
      if (action === 'reinstall' && !isRemoved)
        await editFields(ctx, ctx.stateFile, before, { [name]: undefined }, 'mcpServers', () => {
          before[name] = undefined;
          isRemoved = true;
          report({ state: 'done', code: 'registration-removed' });
        });
      if (name === 'serena') {
        if (isToolReady && (await ctx.machine.treeStamp(String(registration.command))) !== toolStamp)
          throw new Error('program-changed');
        if (!isToolReady) {
          let uv = (await ctx.machine.locate('uv'))[0];
          const localUv = path.join(ctx.home, '.local/bin', ctx.platform === 'win32' ? 'uv.exe' : 'uv');
          if (uv === undefined && (await ctx.machine.treeStamp(localUv)) !== null) uv = localUv;
          if (uv === undefined) {
            const file = path.join(
              ctx.storage,
              `install-uv-${randomUUID()}.${ctx.platform === 'win32' ? 'ps1' : 'sh'}`,
            );
            await ctx.machine.initialize(
              file,
              await ctx.machine.fetchText(`https://astral.sh/uv/install.${ctx.platform === 'win32' ? 'ps1' : 'sh'}`),
            );
            try {
              success(
                await ctx.machine.execute(
                  ctx.platform === 'win32' ? 'powershell.exe' : 'sh',
                  ctx.platform === 'win32' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file] : [file],
                  { env: { UV_NO_MODIFY_PATH: '1', UV_INSTALL_DIR: path.join(ctx.home, '.local/bin') } },
                ),
              );
            } finally {
              const stamp = await ctx.machine.treeStamp(file);
              if (stamp !== null) await ctx.machine.removeTree(file, stamp);
            }
            uv = localUv;
            report({ state: 'done', code: 'uv-installed' });
          }
          cancelled(signal);
          const serenaIn = (text: string) =>
            text
              .split('\n')
              .some(
                line =>
                  line.trim().split(/\s+/).slice(0, 2).join(' ') ===
                  `${mcpSpecs.serena.release.package} v${targetVersion}`,
              );
          const currentTools = await ctx.machine.execute(uv, ['tool', 'list']);
          const isAlreadyInstalled = !currentTools.failed && currentTools.code === 0 && serenaIn(currentTools.stdout);
          if (!isAlreadyInstalled || action === 'reinstall')
            success(
              await ctx.machine.execute(uv, [
                'tool',
                'install',
                '--python',
                mcpSpecs.serena.release.python,
                '--upgrade',
                ...(action === 'reinstall' ? ['--reinstall'] : []),
                `${mcpSpecs.serena.release.package}==${targetVersion}`,
              ]),
              'serena-install-failed',
            );
          const installed = success(await ctx.machine.execute(uv, ['tool', 'list']));
          if (!serenaIn(installed)) throw new Error('binary-version-mismatch');
          const bin = success(await ctx.machine.execute(uv, ['tool', 'dir', '--bin'])).trim();
          if (!path.isAbsolute(bin) || /[\r\n]/.test(bin)) throw new Error('invalid-tool-directory');
          registration.command = path.join(bin, ctx.platform === 'win32' ? 'serena.exe' : 'serena');
          if ((await ctx.machine.treeStamp(String(registration.command))) === null)
            throw new Error('program-not-ready');
          toolStamp = await ctx.machine.treeStamp(String(registration.command));
          isToolReady = true;
          report({ state: 'done', code: 'serena-installed' });
        }
        cancelled(signal);
        if (action !== 'update' && !isInitialized) {
          success(await ctx.machine.execute(String(registration.command), ['init']), 'serena-initialization-failed');
          isInitialized = true;
          report({ state: 'done', code: 'serena-initialized' });
        }
      }
      cancelled(signal);
      if (action !== 'update') {
        if (!isRegistrationSaved)
          await editFields(ctx, ctx.stateFile, before, { [name]: registration }, 'mcpServers', () => {
            isRegistrationSaved = true;
            before[name] = registration;
            report({ state: 'done', code: 'registration-saved', detail: name });
          });
        else unchanged(object((await json(ctx.machine, ctx.stateFile)).mcpServers)[name], registration);
      }
    },
  };
}
