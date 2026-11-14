import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownTitle } from './management-catalog.js';
import { errorCode, isObject, succeeded } from './machine.js';
import { json, unchanged } from './model.js';
import type { Context, Domain, Prepared, Selection } from './model.js';
import { freezeNpmScope, npmVersion, samePath } from './program-channels.js';
import { NPM_ENABLE_SCRIPTS, isExactVersion, resolveNpmView, compareVersions } from './npm-registry.js';
import { npmProgram } from './program-operations.js';
import { step, sequence } from './work.js';
import { frozenJsonWork, jsonFingerprint } from './frozen-json.js';
const PACKAGE = '@cometix/ccline';
const ASSET = fileURLToPath(new URL('../assets/ccline/config.toml', import.meta.url));
/**
 * 管理 CCometixLine 程序、外观和状态栏连接
 *
 * @remarks 仅管理默认目录的 npm 2.x 安装，拒绝降级和覆盖外部状态栏配置
 * 卸载移除自有连接，保留外观、外部程序和其他用户数据
 */
export function createCcline(ctx: Context): Domain {
  const directory = path.join(ctx.home, '.claude', 'ccline');
  const binary = path.join(directory, ctx.platform === 'win32' ? 'ccline.exe' : 'ccline');
  const config = path.join(directory, 'config.toml');
  const connected = (value: unknown) =>
    isObject(value) &&
    value.type === 'command' &&
    typeof value.command === 'string' &&
    ['ccline', 'ccline.exe', binary].includes(value.command);
  const inspect = async () => {
    const settings = await json(ctx.machine, ctx.settingsFile);
    const version = await npmVersion(ctx, PACKAGE);
    const stamp = await ctx.machine.fingerprint(binary);
    return { statusLine: settings.statusLine, version, stamp };
  };
  return {
    async inspect() {
      try {
        const state = await inspect();
        return {
          items: [
            {
              id: 'ccline',
              title: knownTitle('ccline'),
              kind: 'ccline',
              location: config,
              canInstall: state.version !== null || state.stamp === null,
              canUninstall: state.version !== null,
              facts: [
                {
                  code:
                    state.stamp !== null
                      ? 'program-exists'
                      : state.version !== null
                        ? 'program-missing'
                        : 'not-installed',
                },
                ...(state.version ? [{ code: 'program-version', detail: state.version }] : []),
                { code: connected(state.statusLine) ? 'connected' : 'not-connected' },
                ...(state.stamp !== null && state.version === null ? [{ code: 'external-program-preserved' }] : []),
              ],
            },
          ],
          problems: [],
        };
      } catch (error) {
        return {
          items: [
            {
              id: 'ccline',
              title: knownTitle('ccline'),
              kind: 'ccline',
              location: config,
              canInstall: true,
              facts: [],
              problem: errorCode(error),
            },
          ],
          problems: [],
        };
      }
    },
    async prepare(selection: Selection): Promise<Prepared> {
      if (selection.id !== 'ccline') throw new Error('unknown-selection');
      if (!samePath(ctx, ctx.cclineRoot, directory)) throw new Error('external-program-preserved');
      const before = await inspect();
      const uninstall = selection.action === 'uninstall';
      if (before.stamp !== null && before.version === null) throw new Error('channel-not-supported');
      if (uninstall && before.version === null) throw new Error('program-not-installed');
      const scope = await freezeNpmScope(ctx);
      const release = uninstall
        ? null
        : await resolveNpmView(ctx.machine, PACKAGE + '@latest', 'version', value =>
            isExactVersion(value) ? value : null,
          );
      if (!uninstall && !release) throw new Error('source-unavailable');
      if (release && !release.value.startsWith('2.')) throw new Error('unsupported-ccline-release');
      if (release && before.version && compareVersions(before.version, release.value) > 0)
        throw new Error('newer-version-preserved');
      const program = npmProgram(
        ctx,
        {
          name: PACKAGE,
          binary,
          version: release?.value ?? null,
          beforeVersion: before.version,
          beforeStamp: before.stamp,
          scope,
          registry: release?.registry ?? null,
          args: NPM_ENABLE_SCRIPTS,
        },
        [
          {
            code: uninstall ? 'program-uninstall' : before.version ? 'ccline-program-update' : 'ccline-program-prepare',
            detail: PACKAGE,
          },
          { code: 'keep-user-data' },
        ],
      );
      const original = before.statusLine;
      if (!uninstall && original !== undefined && !connected(original)) throw new Error('local-edits-preserved');
      const target = uninstall ? undefined : { type: 'command', command: 'ccline', padding: 0 };
      const changes = [{ code: uninstall ? 'ccline-detach' : 'ccline-connect', detail: ctx.settingsFile }];
      const connection =
        uninstall && !connected(original)
          ? step(changes, () =>
              Promise.resolve({ state: 'complete', effects: [{ state: 'kept', code: 'no-connection' }] }),
            )
          : frozenJsonWork(ctx, {
              file: ctx.settingsFile,
              fields: [{ path: ['statusLine'], before: jsonFingerprint(original), value: target }],
              changes,
              effects: [{ state: 'done', code: uninstall ? 'disconnected' : 'connected' }],
            });
      if (uninstall) return { ...sequence([connection, program]), action: 'uninstall' };
      const existing = await ctx.machine.read(config);
      const text = existing ?? (await ctx.machine.read(ASSET));
      if (text === null) throw new Error('asset-missing');
      const appearance = step(
        [{ code: existing === null ? 'appearance-copy' : 'appearance-kept' }],
        async () => {
          const current = await ctx.machine.read(config);
          if (current === text)
            return {
              state: 'complete',
              effects: [
                {
                  state: existing === null ? 'done' : 'kept',
                  code: existing === null ? 'appearance-copied' : 'appearance-kept',
                },
              ],
            };
          unchanged(current, existing);
          return { state: 'ready' };
        },
        async () => {
          if (!(await ctx.effects.initialize(config, text))) throw new Error('appearance-changed');
          return { receipt: { kind: 'returned', failure: null } };
        },
      );
      const ready = step([], async () => {
        const version = await ctx.machine.execute(binary, ['--version']);
        const [programName, programVersion] = version.stdout.trim().split(/\s+/);
        if (
          !succeeded(version) ||
          (programName !== 'ccline' && programName !== 'ccometixline') ||
          programVersion !== release?.value
        )
          throw new Error('binary-version-mismatch');
        return { state: 'complete', effects: [{ state: 'done', code: 'program-ready' }] };
      });
      return { ...sequence([program, ready, appearance, connection]), action: before.version ? 'update' : 'install' };
    },
  };
}
