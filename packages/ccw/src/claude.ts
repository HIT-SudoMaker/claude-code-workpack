import { inspectSettings, prepareSettings } from './settings.js';
import { knownTitle } from './management-catalog.js';
import type { Context, Domain, Inspection, Prepared, Selection } from './model.js';
import path from 'node:path';
import { errorCode, isObject } from './machine.js';
import { claudeRunning } from './claude-program.js';
import { isExactVersion, NPM_OFFICIAL, resolveNpmView } from './npm-registry.js';
import type { NpmResolution } from './npm-registry.js';
import {
  CLAUDE_PACKAGE,
  CLAUDE_NPM_ARGS,
  claudeNpmBinary,
  bindClaudeCommand,
  claudePrograms,
} from './claude-program.js';
import { freezeNpmScope } from './program-channels.js';
import type { ClaudeProgram } from './claude-program.js';
import { npmProgram } from './program-operations.js';
import { step, sequence } from './work.js';
import { prepareDataCleanup } from './cleanup.js';

const STABLE_METADATA_TIMEOUT_MS = 5_000;

/**
 * 管理 Claude 程序、默认设置、模型配置和官方登录
 *
 * @remarks 仅管理 npm 渠道，安装与更新使用当次 stable 并补齐默认设置
 * 卸载要求 Claude 已停止；外部安装只展示
 */
export function createClaudeDomain(ctx: Context): Domain {
  return {
    async inspect() {
      const checks = [
        ['claude', () => inspectClaudePrograms(ctx)],
        ['settings', async () => ({ items: [await inspectSettings(ctx)], problems: [] })],
      ] as const;
      const results = await Promise.all(
        checks.map(async ([name, read]): Promise<Inspection> => {
          try {
            return await read();
          } catch (error) {
            return { items: [], problems: [{ code: errorCode(error), detail: name }] };
          }
        }),
      );
      return { items: results.flatMap(result => result.items), problems: results.flatMap(result => result.problems) };
    },
    async prepare(selection, claude) {
      if (selection.id.startsWith('data:')) return prepareDataCleanup(ctx, selection);
      if (selection.id === 'settings') {
        const login =
          selection.action === 'configure' && selection.fields?.mode === 'official' && selection.fields.login === 'yes';
        return prepareSettings(ctx, selection, login ? await claude?.() : undefined);
      }
      if (selection.id.split(':')[0] !== 'claude') throw new Error('unknown-selection');
      return prepareClaudeProgram(ctx, selection);
    },
  };
}
async function inspectClaudePrograms(ctx: Context): Promise<Inspection> {
  const found = await claudePrograms(ctx);
  return {
    items: found.items.length
      ? found.items
      : [
          {
            id: 'claude',
            title: knownTitle('claude'),
            kind: 'claude',
            location: ctx.settingsFile,
            canInstall: true,
            facts: [{ code: found.problems.length ? 'inspection-incomplete' : 'not-installed' }],
          },
        ],
    problems: found.problems.map(code => ({ code, detail: 'claude' })),
  };
}
async function prepareClaudeProgram(ctx: Context, selection: Selection): Promise<Prepared> {
  const { id, action } = selection;
  const kind = 'claude';
  const found = await claudePrograms(ctx);
  const program =
    found.values.get(id) ?? (id === kind && found.values.size === 1 ? [...found.values.values()][0] : undefined);
  if (id !== kind && program === undefined) throw new Error('program-changed');
  if (id === kind && !program && found.values.size > 1) throw new Error('channel-not-supported');
  if (found.problems.length && !(action === 'uninstall' && program && program.channel !== 'npm'))
    throw new Error('installation-state-unconfirmed');
  if (action === 'detach') throw new Error('action-unavailable');
  const programStamp = program ? await ctx.machine.treeStamp(program.binary) : null;
  if (action === 'install' && program && !program.isMissing && programStamp === null)
    throw new Error('program-changed');
  const operation = await prepareClaudeInstallation(ctx, action, program);
  if (action !== 'install') return operation;
  const defaults = await prepareSettings(ctx, { id: 'settings', action: 'configure' });
  return {
    ...sequence([operation, defaults]),
    action: operation.action ?? 'install',
    ...(operation.claude ? { claude: operation.claude } : {}),
  };
}

async function prepareClaudeInstallation(
  ctx: Context,
  action: Selection['action'],
  program?: ClaudeProgram,
): Promise<Prepared> {
  if (program && program.channel !== 'npm') throw new Error('channel-not-supported');
  if (!['install', 'update', 'uninstall'].includes(action)) throw new Error('action-unavailable');
  const scope = await freezeNpmScope(ctx);
  const beforeVersion = program?.version ?? null;
  const binary = program?.binary ?? path.join(scope.npmRoot, CLAUDE_PACKAGE, 'cli.js');
  const beforeStamp = await ctx.machine.fingerprint(binary);
  if (action === 'uninstall' && !program) throw new Error('program-not-installed');
  const release = action === 'uninstall' ? null : await stableClaudeVersion(ctx);
  if (action === 'uninstall') await assertClaudeStopped(ctx);
  const changeCode =
    action === 'uninstall' ? 'program-uninstall' : beforeVersion ? 'program-update' : 'program-install';
  const job = npmProgram(
    ctx,
    {
      name: CLAUDE_PACKAGE,
      readBinary: () => claudeNpmBinary(ctx, scope.npmRoot),
      binary,
      beforeVersion,
      beforeStamp,
      version: release?.value ?? null,
      registry: release?.registry ?? null,
      scope,
      args: CLAUDE_NPM_ARGS,
      ...(action === 'uninstall' ? { assertReady: () => assertClaudeStopped(ctx) } : {}),
    },
    [{ code: changeCode, detail: release?.value ?? binary }, { code: 'keep-user-data' }],
  );
  const operation = release
    ? sequence([
        job,
        step([], async () => {
          const target = job.binary();
          const result = await ctx.machine.execute(
            target.endsWith('.js') ? process.execPath : target,
            target.endsWith('.js') ? [target, '--version'] : ['--version'],
          );
          if (result.failed || result.code !== 0 || result.stdout.trim().split(/\s/)[0] !== release.value)
            throw new Error('binary-version-mismatch');
          return {
            state: 'complete',
            effects: [{ state: 'done', code: 'program-ready' }],
          };
        }),
      ])
    : job;
  return {
    ...operation,
    action: action === 'uninstall' ? 'uninstall' : beforeVersion ? 'update' : 'install',
    ...(release
      ? {
          claude: bindClaudeCommand(
            ctx,
            () => job.binary(),
            async () => {
              await operation.verify();
              if (!operation.result().complete) throw new Error('dependency-not-ready');
            },
          ),
        }
      : {}),
  };
}

async function stableClaudeVersion(ctx: Context): Promise<NpmResolution<string>> {
  const release = await resolveNpmView(ctx.machine, `${CLAUDE_PACKAGE}@stable`, 'version', exactVersion);
  if (release !== null) return release;
  // npm 查询未得到有效版本时才读取官方稳定版元数据，返回值仍绑定官方来源
  try {
    const metadata: unknown = JSON.parse(
      await ctx.machine.fetchText(`${NPM_OFFICIAL}/@anthropic-ai%2Fclaude-code/stable`, {
        timeoutMs: STABLE_METADATA_TIMEOUT_MS,
      }),
    );
    if (!isObject(metadata)) throw new Error('invalid-release');
    const version = exactVersion(metadata.version);
    if (version === null) throw new Error('invalid-release');
    return { value: version, registry: NPM_OFFICIAL };
  } catch {
    throw new Error('stable-release-unavailable');
  }
}
function exactVersion(value: unknown) {
  return isExactVersion(value) ? value : null;
}

/** 卸载前后核对 Claude 进程，通用 npm 执行器不识别具体包名 */
async function assertClaudeStopped(ctx: Context) {
  const running = await claudeRunning(ctx.machine);
  if (running !== false) throw new Error(running ? 'claude-running' : 'process-state-unconfirmed');
}
