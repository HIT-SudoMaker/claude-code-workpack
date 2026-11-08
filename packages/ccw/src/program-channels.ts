import path from 'node:path';

import { isObject, succeeded } from './machine.js';
import { claudeEnvironment, json, normalizePath, success } from './model.js';
import { npmInstallArgs, npmUninstallArgs, NPM_READ_TIMEOUT_MS } from './npm-registry.js';
import type { CommandResult } from './machine.js';
import type { Context } from './model.js';
import type { NpmRegistry } from './npm-registry.js';

export type ProgramKind = 'claude' | 'officecli';
type ProgramChannel = 'native' | 'npm' | 'brew' | 'winget' | 'scoop' | 'apt' | 'dnf' | 'apk' | 'manual';

export interface Program {
  readonly kind: ProgramKind;
  readonly channel: ProgramChannel;
  readonly binary: string;
  readonly version: string | null;
  readonly packageName: string;
  readonly isMissing?: boolean;
  readonly npmRoot?: string;
}

interface ProgramScope {
  readonly verify: () => Promise<void>;
  readonly matches: (program: Program) => Promise<boolean>;
  readonly manager?: string;
  readonly npmRoot?: string;
}

export interface NpmScope {
  readonly npmRoot: string;
  readonly args: readonly string[];
  readonly verify: () => Promise<void>;
  readonly matches: (root: string) => Promise<boolean>;
}

export const PROGRAM_PACKAGES: Readonly<Record<ProgramKind, string>> = {
  claude: '@anthropic-ai/claude-code',
  officecli: '@officecli/officecli',
};

export function officeBinary(ctx: Context) {
  const root =
    ctx.platform === 'win32'
      ? path.join(ctx.localAppData ?? path.join(ctx.home, 'AppData/Local'), 'OfficeCli')
      : path.join(ctx.home, '.local/bin');
  if (!path.isAbsolute(root) || path.resolve(root) === path.parse(path.resolve(root)).root)
    throw new Error('invalid-config-root');
  return path.join(root, ctx.platform === 'win32' ? 'officecli.exe' : 'officecli');
}

export function samePath(ctx: Context, left: string, right: string) {
  return normalizePath(ctx.platform, left) === normalizePath(ctx.platform, right);
}

export function containsPath(ctx: Context, directory: string, file: string) {
  const root = path.resolve(directory);
  const target = path.resolve(file);
  return ctx.platform === 'win32'
    ? target.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)
    : target.startsWith(`${root}${path.sep}`);
}

export function npmScopeArgs(ctx: Context, root?: string) {
  if (root === undefined) return [];
  const prefix = ctx.platform === 'win32' ? path.dirname(root) : path.dirname(path.dirname(root));
  return [`--prefix=${prefix}`];
}

export async function npmGlobalRoot(ctx: Context, expected?: string) {
  const result = await ctx.machine.npm(['root', '-g', ...npmScopeArgs(ctx, expected)], {
    timeoutMs: NPM_READ_TIMEOUT_MS,
  });
  if (result.reason === 'npm-not-found') throw new Error('npm-not-found');
  const root = success(result).trim();
  if (!path.isAbsolute(root) || /[\r\n]/.test(root)) throw new Error('invalid-npm-root');
  return root;
}

/** 冻结 npm 全局根；变更命令沿用显式前缀，继续前复核当前上下文 */
export async function freezeNpmScope(ctx: Context, root?: string): Promise<NpmScope> {
  const npmRoot = root ?? (await npmGlobalRoot(ctx));
  const canonical = (await ctx.machine.realpath(npmRoot)) ?? npmRoot;
  const matches = async (current: string) => samePath(ctx, (await ctx.machine.realpath(current)) ?? current, canonical);
  const verify = async () => {
    if (!(await matches(await npmGlobalRoot(ctx))) || !(await matches(await npmGlobalRoot(ctx, npmRoot))))
      throw new Error('program-scope-unconfirmed');
  };
  await verify();
  return { npmRoot, args: npmScopeArgs(ctx, npmRoot), verify, matches };
}

export async function npmVersion(
  ctx: Context,
  name: string,
  root?: string,
  options: { needsNpm?: boolean } = {},
): Promise<string | null> {
  const result = await ctx.machine.npm(['ls', '-g', ...npmScopeArgs(ctx, root), '--depth=0', '--json', name], {
    timeoutMs: NPM_READ_TIMEOUT_MS,
  });
  if (result.reason === 'npm-not-found') {
    if (options.needsNpm) throw new Error('npm-not-found');
    return null;
  }
  if (result.failed) throw new Error('npm-inspection-failed');
  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error('invalid-npm-result');
  }
  if (
    isObject(data) &&
    isObject(data.error) &&
    data.error.code === 'ENOENT' &&
    (await ctx.machine.treeStamp(await npmGlobalRoot(ctx, root))) === null
  )
    return null;
  // npm ls 以退出码 1 表示未安装；其余非零才是检查失败
  if (result.code !== 0 && result.code !== 1) throw new Error('npm-inspection-failed');
  if (!isObject(data) || data.error !== undefined || (Array.isArray(data.problems) && data.problems.length))
    throw new Error('npm-inspection-failed');
  if (data.dependencies === undefined) return null;
  if (!isObject(data.dependencies)) throw new Error('invalid-npm-result');
  const entry = data.dependencies[name];
  if (entry === undefined) return null;
  if (!isObject(entry) || typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(entry.version))
    throw new Error('invalid-npm-result');
  return entry.version;
}

export async function npmBinary(ctx: Context, kind: ProgramKind, root?: string) {
  const directory = path.join(root ?? (await npmGlobalRoot(ctx)), PROGRAM_PACKAGES[kind]);
  if (kind === 'officecli')
    return path.join(directory, 'vendor', ctx.platform === 'win32' ? 'officecli.exe' : 'officecli');
  const manifest = await json(ctx.machine, path.join(directory, 'package.json'));
  const relative =
    typeof manifest.bin === 'string' ? manifest.bin : isObject(manifest.bin) ? manifest.bin.claude : undefined;
  if (typeof relative !== 'string') throw new Error('program-not-ready');
  const binary = path.resolve(directory, relative);
  if (!binary.startsWith(`${directory}${path.sep}`)) throw new Error('invalid-program-entry');
  return binary;
}

/** 将已定位入口归属到唯一渠道；无法确认所有权时保持 manual */
export async function identifyProgramChannel(
  ctx: Context,
  kind: ProgramKind,
  binary: string,
  canonical: string,
  native: string,
): Promise<Pick<Program, 'channel' | 'packageName'>> {
  let channel: ProgramChannel = samePath(ctx, binary, native) ? 'native' : 'manual';
  if (channel === 'native' && kind === 'claude') {
    const versionRoot = path.join(ctx.home, '.local/share/claude/versions');
    if (!containsPath(ctx, versionRoot, canonical)) {
      const stamp = await ctx.machine.treeStamp(binary);
      let hasMatchingVersion = false;
      for (const entry of await ctx.machine.entries(versionRoot)) {
        if (entry.kind === 'file' && (await ctx.machine.treeStamp(path.join(versionRoot, entry.name))) === stamp) {
          hasMatchingVersion = true;
          break;
        }
      }
      if (!hasMatchingVersion) channel = 'manual';
    }
  }

  const normalized = canonical.replaceAll('\\', '/').toLowerCase();
  if (
    (kind === 'claude' && /\/caskroom\/claude-code(?:@latest)?\//.test(normalized)) ||
    (kind === 'officecli' && /\/cellar\/officecli\/[^/]+\/(?:[^/]+\/)*officecli$/.test(normalized))
  )
    channel = 'brew';
  // WinGet 便携包目录带来源段；伪造版本目录不授予渠道身份与卸载资格
  if (
    kind === 'claude' &&
    /\/microsoft\/winget\/packages\/anthropic\.claudecode_microsoft\.winget\.source_8wekyb3d8bbwe\/(?:[^/]+\/)*claude\.exe$/.test(
      normalized,
    )
  )
    channel = 'winget';
  if (kind === 'officecli' && normalized.includes('/apps/officecli/')) {
    const appRoot = /^(.*[\\/]apps[\\/]officecli[\\/][^\\/]+)/i.exec(canonical)?.[1];
    const manifest = appRoot === undefined ? {} : await json(ctx.machine, path.join(appRoot, 'manifest.json'));
    const scoopRoot = await ctx.machine.realpath(ctx.scoopRoot ?? path.join(ctx.home, 'scoop'));
    const appParent = appRoot === undefined ? undefined : path.dirname(appRoot);
    if (
      scoopRoot !== null &&
      appParent !== undefined &&
      samePath(ctx, appParent, path.join(scoopRoot, 'apps/officecli')) &&
      typeof manifest.homepage === 'string' &&
      /^https:\/\/(?:github\.com\/iOfficeAI\/OfficeCLI\/?|officecli\.ai\/?)$/.test(manifest.homepage)
    )
      channel = 'scoop';
  }
  if (ctx.platform === 'linux' && channel === 'manual') {
    for (const [manager, args] of [
      ['apt', ['dpkg-query', '-S', canonical]],
      ['dnf', ['rpm', '-qf', '--qf', '%{NAME}\n', canonical]],
      ['apk', ['apk', 'info', '--who-owns', canonical]],
    ] as const) {
      const result = await ctx.machine.execute(args[0], args.slice(1));
      if (!succeeded(result) || kind !== 'claude') continue;
      const lines = result.stdout.trim().split(/\r?\n/);
      const isOwned =
        manager === 'apt'
          ? lines.length === 1 &&
            /^claude-code(?::[A-Za-z0-9_-]+)?: /.test(lines[0] ?? '') &&
            lines[0]?.endsWith(`: ${canonical}`)
          : manager === 'dnf'
            ? lines.length === 1 && lines[0] === 'claude-code'
            : lines.length === 1 &&
              lines[0]?.startsWith(`${canonical} is owned by `) &&
              /^claude-code-\d[A-Za-z0-9._+~]*-r\d+$/.test(lines[0].slice(`${canonical} is owned by `.length));
      if (isOwned) {
        channel = manager;
        break;
      }
    }
  }
  return {
    channel,
    packageName:
      channel === 'brew' && kind === 'claude' && normalized.includes('/caskroom/claude-code@latest/')
        ? 'claude-code@latest'
        : kind === 'claude'
          ? 'claude-code'
          : 'officecli',
  };
}

export function channelCanPinVersion(channel: ProgramChannel) {
  return channel === 'npm' || channel === 'native' || channel === 'winget';
}

async function scoopTarget(ctx: Context, program: Program) {
  const result = await ctx.machine.execute('scoop', ['prefix', 'officecli']);
  const prefix = result.stdout.trim();
  if (!succeeded(result) || !path.isAbsolute(prefix) || /[\r\n]/.test(prefix))
    throw new Error('program-scope-unconfirmed');
  const current = await ctx.machine.realpath(prefix);
  const binary = await ctx.machine.realpath(program.binary);
  if (current === null || binary === null || !samePath(ctx, path.join(current, 'officecli.exe'), binary))
    throw new Error('program-scope-unconfirmed');
  return current;
}

const BREW_ENV = { HOMEBREW_NO_AUTO_UPDATE: '1' };

async function brewPackage(ctx: Context, program: Program, manager: string) {
  const result = await ctx.machine.execute(
    manager,
    ['list', program.kind === 'claude' ? '--cask' : '--formula', '--versions', program.packageName],
    { env: BREW_ENV },
  );
  const canonical = await ctx.machine.realpath(program.binary);
  const packageRoot = path.join(
    path.dirname(path.dirname(manager)),
    program.kind === 'claude' ? 'Caskroom' : 'Cellar',
    program.packageName,
  );
  if (canonical === null || !containsPath(ctx, packageRoot, canonical)) throw new Error('program-scope-unconfirmed');
  const version = path.relative(packageRoot, canonical).split(path.sep)[0];
  const registered = result.stdout
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map(line => line.trim().split(/\s+/));
  // 无版本参数的变更命令无法绑定同一包内的多版本
  if (
    !succeeded(result) ||
    registered.length !== 1 ||
    registered[0]?.length !== 2 ||
    registered[0][0] !== program.packageName ||
    registered[0][1] !== version
  )
    throw new Error('program-scope-unconfirmed');
}

/** 冻结管理器与安装根；后续观察只能匹配同一包的副本 */
export async function freezeProgramScope(ctx: Context, program: Program): Promise<ProgramScope> {
  const matches = (candidate: Program) =>
    Promise.resolve(candidate.channel === program.channel && samePath(ctx, candidate.binary, program.binary));
  if (program.channel === 'npm') {
    const scope = await freezeNpmScope(ctx, program.npmRoot);
    if (!samePath(ctx, await npmBinary(ctx, program.kind, scope.npmRoot), program.binary))
      throw new Error('program-scope-unconfirmed');
    return {
      npmRoot: scope.npmRoot,
      verify: scope.verify,
      matches: async candidate =>
        candidate.channel === 'npm' && candidate.npmRoot !== undefined && (await scope.matches(candidate.npmRoot)),
    };
  }
  if (program.channel === 'brew') {
    const canonical = await ctx.machine.realpath(program.binary);
    const collection = program.kind === 'claude' ? 'Caskroom' : 'Cellar';
    const marker = `${path.sep}${collection}${path.sep}${program.packageName}${path.sep}`;
    const index = canonical?.indexOf(marker) ?? -1;
    if (canonical === null || index < 0) throw new Error('program-scope-unconfirmed');
    const root = canonical.slice(0, index);
    const packageRoot = path.join(root, collection, program.packageName);
    const manager = path.join(root, 'bin/brew');
    const executable = await ctx.machine.realpath(manager);
    const stamp = executable === null ? null : await ctx.machine.treeStamp(executable);
    if (executable === null || stamp === null) throw new Error('program-scope-unconfirmed');
    const verify = async () => {
      const current = await ctx.machine.realpath(manager);
      if (current === null || !samePath(ctx, current, executable) || (await ctx.machine.treeStamp(current)) !== stamp)
        throw new Error('program-scope-unconfirmed');
      const result = await ctx.machine.execute(manager, [collection === 'Cellar' ? '--cellar' : '--caskroom'], {
        env: BREW_ENV,
      });
      const location = result.stdout.trim();
      if (
        !succeeded(result) ||
        !path.isAbsolute(location) ||
        /[\r\n]/.test(location) ||
        !samePath(ctx, (await ctx.machine.realpath(location)) ?? location, path.join(root, collection))
      )
        throw new Error('program-scope-unconfirmed');
    };
    await verify();
    await brewPackage(ctx, program, manager);
    return {
      manager,
      verify,
      matches: async candidate => {
        const current = await ctx.machine.realpath(candidate.binary);
        return (
          candidate.channel === 'brew' &&
          candidate.packageName === program.packageName &&
          current !== null &&
          containsPath(ctx, packageRoot, current)
        );
      },
    };
  }
  if (program.channel === 'scoop') {
    const expected = await scoopTarget(ctx, program);
    return {
      verify: async () => {
        if (!samePath(ctx, await scoopTarget(ctx, program), expected)) throw new Error('program-scope-unconfirmed');
      },
      matches: async candidate => {
        const current = await ctx.machine.realpath(candidate.binary);
        return candidate.channel === 'scoop' && current !== null && containsPath(ctx, path.dirname(expected), current);
      },
    };
  }
  return { verify: async () => {}, matches };
}

export async function maintainProgramChannel(
  ctx: Context,
  program: Program,
  scope: ProgramScope,
  action: 'install' | 'update' | 'reinstall',
  targetVersion: string | null,
  targetRegistry: NpmRegistry | undefined,
  packageCommandCompleted: () => Promise<void>,
): Promise<void> {
  if (program.channel === 'manual') throw new Error('channel-not-supported');
  if (program.channel === 'npm') {
    if (
      (await npmVersion(ctx, PROGRAM_PACKAGES[program.kind], scope.npmRoot)) !== program.version ||
      !samePath(ctx, await npmBinary(ctx, program.kind, scope.npmRoot), program.binary)
    )
      throw new Error('program-changed');
    const args = npmInstallArgs(
      [
        'install',
        '-g',
        ...npmScopeArgs(ctx, scope.npmRoot),
        ...(action === 'reinstall' ? ['--force'] : []),
        '--ignore-scripts=false',
        ...(program.kind === 'claude' ? [`--allow-scripts=${PROGRAM_PACKAGES.claude}`, '--include=optional'] : []),
        `${PROGRAM_PACKAGES[program.kind]}@${targetVersion}`,
      ],
      targetRegistry ?? null,
    );
    success(await ctx.machine.npm(args));
    await packageCommandCompleted();
    return;
  }
  if (program.channel === 'native') {
    if (program.kind !== 'claude' || targetVersion === null) throw new Error('channel-not-supported');
    success(
      await ctx.machine.execute(
        program.binary,
        ['install', targetVersion, ...(action === 'reinstall' ? ['--force'] : [])],
        { env: claudeEnvironment(ctx), cwd: ctx.home },
      ),
    );
    await packageCommandCompleted();
    return;
  }
  const commands: Partial<Record<ProgramChannel, readonly string[]>> = {
    brew: [
      scope.manager ?? '',
      action === 'reinstall' ? 'reinstall' : 'upgrade',
      ...(program.kind === 'claude' ? ['--cask'] : []),
      program.packageName,
    ],
    winget: [
      'winget',
      action === 'reinstall' ? 'install' : 'upgrade',
      ...(action === 'reinstall' ? ['--force'] : []),
      '--id',
      'Anthropic.ClaudeCode',
      ...(targetVersion !== null ? ['--version', targetVersion] : []),
      '--exact',
      '--disable-interactivity',
    ],
    scoop: ['scoop', 'update', ...(action === 'reinstall' ? ['--force'] : []), 'officecli'],
    apt: [
      'apt-get',
      'install',
      '--yes',
      action === 'reinstall' ? '--reinstall' : '--only-upgrade',
      program.packageName,
    ],
    dnf: ['dnf', action === 'reinstall' ? 'reinstall' : 'upgrade', '--assumeyes', program.packageName],
    apk: ['apk', action === 'reinstall' ? 'fix' : 'upgrade', program.packageName],
  };
  const command = commands[program.channel];
  if (command === undefined) throw new Error('channel-not-supported');
  const [executable, ...args] = command;
  if (!executable) throw new Error('channel-not-supported');
  if (program.channel === 'brew') await brewPackage(ctx, program, executable);
  success(await ctx.machine.execute(executable, args, program.channel === 'brew' ? { env: BREW_ENV } : undefined));
  await packageCommandCompleted();
}

export async function removeProgramChannel(
  ctx: Context,
  program: Program,
  scope: ProgramScope,
): Promise<CommandResult> {
  if (program.channel === 'npm') {
    if (
      (await npmVersion(ctx, PROGRAM_PACKAGES[program.kind], scope.npmRoot)) !== program.version ||
      !samePath(ctx, await npmBinary(ctx, program.kind, scope.npmRoot), program.binary)
    )
      throw new Error('program-changed');
    return ctx.machine.npm(
      npmUninstallArgs(['uninstall', '-g', ...npmScopeArgs(ctx, scope.npmRoot), PROGRAM_PACKAGES[program.kind]]),
    );
  }
  const commands: Partial<Record<ProgramChannel, readonly string[]>> = {
    brew: [scope.manager ?? '', 'uninstall', ...(program.kind === 'claude' ? ['--cask'] : []), program.packageName],
    winget: ['winget', 'uninstall', '--id', 'Anthropic.ClaudeCode', '--exact', '--disable-interactivity'],
    scoop: ['scoop', 'uninstall', 'officecli'],
    apt: ['apt-get', 'remove', '--yes', program.packageName],
    dnf: ['dnf', 'remove', '--assumeyes', program.packageName],
    apk: ['apk', 'del', program.packageName],
  };
  const command = commands[program.channel];
  if (command === undefined) throw new Error('channel-not-supported');
  const [executable, ...args] = command;
  if (!executable) throw new Error('channel-not-supported');
  if (program.channel === 'brew') await brewPackage(ctx, program, executable);
  return ctx.machine.execute(executable, args, program.channel === 'brew' ? { env: BREW_ENV } : undefined);
}

export async function programPackageAbsent(
  ctx: Context,
  program: Program,
  scope: ProgramScope,
): Promise<boolean | null> {
  if (program.channel === 'brew') {
    await scope.verify();
    if (scope.manager === undefined) return null;
    const result = await ctx.machine.execute(
      scope.manager,
      ['list', program.kind === 'claude' ? '--cask' : '--formula', '--versions'],
      { env: BREW_ENV },
    );
    return !succeeded(result)
      ? null
      : !result.stdout.split(/\r?\n/).some(line => line.trim().split(/\s+/)[0] === program.packageName);
  }
  if (program.channel === 'winget') {
    const result = await ctx.machine.execute('winget', [
      'list',
      '--id',
      'Anthropic.ClaudeCode',
      '--exact',
      '--disable-interactivity',
    ]);
    if (result.failed || result.code === null) return null;
    if (result.code >>> 0 === 0x8a150014) return true;
    return result.code !== 0 ? null : !/\bAnthropic\.ClaudeCode\b/i.test(result.stdout);
  }
  if (program.channel === 'scoop') {
    const result = await ctx.machine.execute('scoop', ['list', 'officecli']);
    return !succeeded(result) ? null : !result.stdout.split(/\r?\n/).some(line => /^\s*officecli\s/i.test(line));
  }
  if (program.channel === 'apt') {
    const result = await ctx.machine.execute('dpkg-query', ['-W', '-f=${Package} ${db:Status-Status}\n']);
    return !succeeded(result)
      ? null
      : !result.stdout.split(/\r?\n/).some(line => line.trim() === `${program.packageName} installed`);
  }
  if (program.channel === 'dnf') {
    const result = await ctx.machine.execute('rpm', ['-qa', '--qf', '%{NAME}\n']);
    return !succeeded(result) ? null : !result.stdout.split(/\r?\n/).some(line => line.trim() === program.packageName);
  }
  if (program.channel === 'apk') {
    const result = await ctx.machine.execute('apk', ['info']);
    return !succeeded(result) ? null : !result.stdout.split(/\r?\n/).some(line => line.trim() === program.packageName);
  }
  return null;
}
