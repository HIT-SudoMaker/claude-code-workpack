import { createHash } from 'node:crypto';
import path from 'node:path';

import { errorCode, isObject, succeeded } from './machine.js';
import type { CommandResult } from './machine.js';
import { cancelled, claudeEnvironment, claudeRunning, commandReceipt } from './model.js';
import type {
  Assessment,
  Change,
  Context,
  Effect,
  Json,
  JsonObject,
  OperationDefinition,
  OperationFact,
  OperationHandler,
  OperationOutcome,
  Prepared,
} from './model.js';
import {
  maintainProgramChannel,
  matchesProgramScope,
  npmBinary,
  npmGlobalRoot,
  npmScriptFlags,
  npmVersion,
  PROGRAM_PACKAGES,
  programPackageAbsent,
  programScope,
  removeProgramChannel,
  samePath,
  verifyNpmScope,
  verifyProgramScope,
  verifyProgramBeforeCommand,
} from './program-channels.js';
import type { FrozenNpmScope, FrozenProgramScope, Program } from './program-channels.js';
import { claudeVersion, officeVersion, programs } from './programs.js';
import { npmInstallArgs, npmUninstallArgs } from './npm-registry.js';
import type { NpmRegistry } from './npm-registry.js';

/** Operation payloads contain frozen domain values only; no continuation state. */
export function programOperation(
  itemId: string,
  name: string,
  handler: string,
  payload: unknown,
  changes: readonly Change[] = [],
  dependsOn: readonly string[] = [],
): OperationDefinition {
  return { id: `${itemId}/${name}`, itemId, handler, payload: jsonObject(payload), changes, dependsOn };
}
export function programPrepared(operations: readonly OperationDefinition[]): Prepared {
  return { operations, changes: operations.flatMap(operation => operation.changes) };
}
export function composeProgramOperations(
  prepared: Prepared,
  itemId: string,
  prefix: string,
  prerequisites: readonly string[] = [],
): Prepared {
  if (!prepared.operations) throw new Error('repreview-required');
  const ids = new Map(prepared.operations.map(operation => [operation.id, `${itemId}/${prefix}/${operation.id}`]));
  const references = (value: unknown): unknown => {
    if (typeof value === 'string') return ids.get(value) ?? value;
    if (Array.isArray(value)) return value.map(references);
    if (typeof value === 'object' && value !== null)
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, references(entry)]));
    return value;
  };
  const operations = prepared.operations.map(operation => ({
    ...operation,
    id: ids.get(operation.id)!,
    itemId,
    payload: jsonObject(references(operation.payload)),
    dependsOn: [...operation.dependsOn.map(id => ids.get(id) ?? id), ...prerequisites],
  }));
  return {
    ...programPrepared(operations),
    ...(prepared.inputs
      ? {
          inputs: Object.fromEntries(
            Object.entries(prepared.inputs).map(([id, fields]) => [ids.get(id) ?? id, fields]),
          ),
        }
      : {}),
  };
}
export function programEffects(code: string, detail?: string, state: Effect['state'] = 'done'): readonly Effect[] {
  return [{ code, state, ...(detail === undefined ? {} : { detail }) }];
}
const complete = (evidence: JsonObject, effects?: readonly Effect[]): Assessment => ({
  state: 'complete',
  evidence,
  ...(effects ? { effects } : {}),
});
const unknown = (problem = 'program-installation-unconfirmed'): Assessment => ({ state: 'unknown', problem });
const blocked = (problem: string): Assessment => ({ state: 'blocked', problem });
const returned = (failure: string | null = null): OperationFact['receipt'] & {} => ({ kind: 'returned', failure });
const issued = (fact: OperationFact) => fact.attemptId !== undefined;
const success = (fact: OperationFact) => fact.receipt?.kind === 'returned' && fact.receipt.failure === null;
function isJson(value: unknown): value is Json {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(isJson)) ||
    (isObject(value) && Object.values(value).every(isJson))
  );
}
function jsonObject(value: unknown): JsonObject {
  const encoded: unknown = JSON.parse(JSON.stringify(value));
  if (!isJsonObject(encoded)) throw new Error('operation-record-invalid');
  return encoded;
}
function isJsonObject(value: unknown): value is JsonObject {
  return isObject(value) && Object.values(value).every(isJson);
}
function read<T>(definition: OperationDefinition, validate: (value: unknown) => value is T): T {
  if (!validate(definition.payload)) throw new Error('operation-record-invalid');
  return definition.payload;
}
function text(value: unknown): value is string {
  return typeof value === 'string';
}
function nullableText(value: unknown): value is string | null {
  return value === null || text(value);
}
function optionalText(value: unknown) {
  return value === undefined || text(value);
}
function texts(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(text);
}
function npmScopeValue(value: unknown): value is FrozenNpmScope {
  return (
    isObject(value) &&
    text(value.npmRoot) &&
    text(value.canonical) &&
    texts(value.args) &&
    isObject(value.identity) &&
    text(value.identity.entry) &&
    text(value.identity.binary) &&
    text(value.identity.stamp)
  );
}
function scopeValue(value: unknown): value is FrozenProgramScope {
  return (
    isObject(value) &&
    text(value.channel) &&
    text(value.binary) &&
    (value.npm === undefined || npmScopeValue(value.npm)) &&
    ['manager', 'executable', 'managerStamp', 'root', 'packageRoot', 'scoop'].every(key => optionalText(value[key]))
  );
}
function programValue(value: unknown): value is Program {
  return (
    isObject(value) &&
    (value.kind === 'claude' || value.kind === 'officecli') &&
    text(value.channel) &&
    text(value.binary) &&
    nullableText(value.version) &&
    text(value.packageName) &&
    optionalText(value.npmRoot)
  );
}
function maintenance(value: unknown): value is Maintenance {
  return (
    isObject(value) &&
    programValue(value.program) &&
    scopeValue(value.scope) &&
    nullableText(value.before) &&
    ['install', 'update', 'reinstall', 'login', 'uninstall'].includes(String(value.action)) &&
    nullableText(value.targetVersion) &&
    nullableText(value.registry)
  );
}
function removal(value: unknown): value is FileRemoval {
  return (
    isObject(value) &&
    text(value.file) &&
    nullableText(value.before) &&
    optionalText(value.ownerOperation) &&
    (value.claude === undefined || typeof value.claude === 'boolean')
  );
}
function deployment(value: unknown): value is Deployment {
  return (
    isObject(value) &&
    text(value.binary) &&
    nullableText(value.before) &&
    text(value.digest) &&
    nullableText(value.bytes) &&
    text(value.version)
  );
}
function readiness(value: unknown): value is Ready {
  return (
    isObject(value) &&
    (value.kind === 'claude' || value.kind === 'officecli') &&
    nullableText(value.version) &&
    ['binary', 'before', 'digest', 'command'].every(key => optionalText(value[key])) &&
    (value.scope === undefined || scopeValue(value.scope)) &&
    (value.program === undefined || programValue(value.program)) &&
    (value.alternatives === undefined || texts(value.alternatives)) &&
    (value.removals === undefined || texts(value.removals))
  );
}
function claudeInstall(value: unknown): value is ClaudeInstall {
  return (
    isObject(value) &&
    [
      'version',
      'native',
      'npmOperation',
      'cleanupOperation',
      'stageOperation',
      'cmdOperation',
      'scriptCleanupOperation',
    ].every(key => text(value[key])) &&
    nullableText(value.registry) &&
    (value.npm === null || npmScopeValue(value.npm)) &&
    nullableText(value.script) &&
    nullableText(value.directory)
  );
}
function npmSnapshot(value: unknown): value is NpmSnapshot {
  return isObject(value) && nullableText(value.manifest) && nullableText(value.binary) && nullableText(value.stamp);
}
function directoryValue(value: unknown): value is { directory: string } {
  return isObject(value) && text(value.directory);
}
function requiredText(value: unknown): string {
  if (!text(value)) throw new Error('operation-record-invalid');
  return value;
}

async function outcome(
  effect: () => Promise<CommandResult | void>,
  capture: () => Promise<JsonObject>,
  failure: string,
  effects: readonly Effect[] = [],
): Promise<OperationOutcome> {
  let result: NonNullable<OperationFact['receipt']>;
  try {
    const response = await effect();
    result = response === undefined ? returned() : commandReceipt(response, failure);
  } catch (error) {
    result = { kind: 'unknown', failure: errorCode(error) };
  }
  try {
    return { receipt: result, evidence: await capture(), ...(result.failure === null ? { effects } : {}) };
  } catch {
    return { receipt: result, evidence: { snapshotUnavailable: true } };
  }
}
interface Maintenance {
  readonly program: Program;
  readonly scope: FrozenProgramScope;
  readonly before: string | null;
  readonly action: 'install' | 'update' | 'reinstall' | 'login' | 'uninstall';
  readonly targetVersion: string | null;
  readonly registry: NpmRegistry | null;
}
interface FileRemoval {
  readonly file: string;
  readonly before: string | null;
  readonly claude?: boolean;
  readonly ownerOperation?: string;
}
interface Deployment {
  readonly binary: string;
  readonly before: string | null;
  readonly digest: string;
  readonly bytes: string | null;
  readonly version: string;
}
interface Ready {
  readonly binary?: string;
  readonly before?: string;
  readonly digest?: string;
  readonly version: string | null;
  readonly kind: 'claude' | 'officecli';
  readonly scope?: FrozenProgramScope;
  readonly program?: Program;
  readonly command?: string;
  readonly alternatives?: readonly string[];
  readonly removals?: readonly string[];
  readonly removed?: boolean;
  readonly keep?: boolean;
  readonly preserveData?: boolean;
}
interface ClaudeInstall {
  readonly version: string;
  readonly registry: NpmRegistry;
  readonly npm: FrozenNpmScope | null;
  readonly native: string;
  readonly script: string | null;
  readonly directory: string | null;
  readonly npmOperation: string;
  readonly cleanupOperation: string;
  readonly stageOperation: string;
  readonly cmdOperation: string;
  readonly scriptCleanupOperation: string;
}
interface NpmSnapshot {
  readonly manifest: string | null;
  readonly binary: string | null;
  readonly stamp: string | null;
}
async function snapshot(ctx: Context, target: ClaudeInstall): Promise<NpmSnapshot> {
  if (!target.npm) return { manifest: null, binary: null, stamp: null };
  const manifest = await ctx.machine.treeStamp(path.join(target.npm.npmRoot, PROGRAM_PACKAGES.claude, 'package.json'));
  if (manifest === null) return { manifest, binary: null, stamp: null };
  const binary = await npmBinary(ctx, 'claude', target.npm.npmRoot);
  return { manifest, binary, stamp: await ctx.machine.treeStamp(binary) };
}
async function verifySnapshot(ctx: Context, target: ClaudeInstall, expected: NpmSnapshot) {
  const actual = await snapshot(ctx, target);
  if (actual.manifest !== expected.manifest || actual.binary !== expected.binary || actual.stamp !== expected.stamp)
    throw new Error('program-changed');
}
async function verifyInstallScope(ctx: Context, target: ClaudeInstall) {
  if (target.npm) return verifyNpmScope(ctx, target.npm);
  try {
    await npmGlobalRoot(ctx);
  } catch (error) {
    if (errorCode(error) === 'npm-not-found') return;
    throw error;
  }
  throw new Error('program-scope-unconfirmed');
}
async function installed(ctx: Context, target: ClaudeInstall, channel: 'npm' | 'native') {
  const found = await programs(ctx, 'claude');
  if (found.problems.length) throw new Error('installation-state-unconfirmed');
  for (const program of found.values.values()) {
    if (program.channel !== channel || program.isMissing) continue;
    if (channel === 'npm' && (!target.npm || !program.npmRoot || !samePath(ctx, program.npmRoot, target.npm.npmRoot)))
      continue;
    if (channel === 'native' && !samePath(ctx, program.binary, target.native)) continue;
    const stamp = await ctx.machine.treeStamp(program.binary);
    if (stamp !== null) {
      const version = await claudeVersion(ctx, program.binary);
      if ((await ctx.machine.treeStamp(program.binary)) !== stamp) throw new Error('program-changed');
      if (version === target.version) return { binary: program.binary, stamp };
    }
  }
  return undefined;
}
function fallback(target: ClaudeInstall, facts: Readonly<Record<string, OperationFact>>): Assessment | undefined {
  const npm = facts[target.npmOperation];
  if (npm?.evidence?.installed === true) return { state: 'unneeded', reason: 'program-kept' };
  if (npm?.status !== 'confirmed' || npm.evidence?.fallback !== true) return blocked('dependency-not-ready');
  return undefined;
}
async function ensureEmpty(ctx: Context, target: ClaudeInstall) {
  if ((await snapshot(ctx, target)).manifest !== null || (await ctx.machine.treeStamp(target.native)) !== null)
    throw new Error('program-changed');
  const found = await programs(ctx, 'claude');
  if (found.values.size) throw new Error('program-changed');
  if (found.problems.length) throw new Error('installation-state-unconfirmed');
}
async function ensureStopped(ctx: Context) {
  const running = await claudeRunning(ctx.machine);
  if (running !== false) throw new Error(running ? 'claude-running' : 'process-state-unconfirmed');
}

/** Registered once by the Claude domain; Office uses the same concrete handlers. */
export function programHandlers(ctx: Context): Readonly<Record<string, OperationHandler>> {
  return {
    'program.remove-file': {
      async assess(definition, fact, facts) {
        const target = read(definition, removal);
        if (target.claude) await ensureStopped(ctx);
        const current = await ctx.machine.treeStamp(target.file);
        if (current === null)
          return complete(
            { file: target.file, absent: true },
            target.before === null
              ? []
              : programEffects(
                  target.file.endsWith('install.cmd') ? 'failed-install-cleaned' : 'program-copy-removed',
                  target.file,
                ),
          );
        const expected = target.ownerOperation ? facts[target.ownerOperation]?.evidence?.stamp : target.before;
        if (current !== expected) return blocked('program-changed');
        if (fact.status === 'confirmed') return unknown('program-changed');
        // Compare-and-remove is safe to retry only while the same frozen tree remains.
        return { state: 'ready', dispatch: { stamp: current } };
      },
      execute(definition, fact) {
        const target = read(definition, removal);
        return outcome(
          () => ctx.effects.removeTree(target.file, requiredText(fact.dispatch?.stamp)),
          async () => ({ file: target.file, absent: (await ctx.machine.treeStamp(target.file)) === null }),
          'program-removal-unconfirmed',
        );
      },
    },
    'program.deploy': {
      async assess(definition, fact) {
        const target = read(definition, deployment);
        const current = await ctx.machine.fingerprint(target.binary);
        if (
          current === target.digest &&
          (target.bytes === null || (issued(fact) && (target.before !== target.digest || success(fact))))
        )
          return complete(
            { binary: target.binary, digest: current },
            programEffects(
              target.bytes === null ? 'program-kept' : 'program-file-ready',
              target.binary,
              target.bytes === null ? 'kept' : 'done',
            ),
          );
        if (issued(fact))
          return fact.confirmed || (current !== target.before && current !== target.digest)
            ? blocked('program-changed')
            : unknown();
        if (current !== target.before) return blocked('program-changed');
        if (target.bytes === null) return blocked('program-changed');
        return { state: 'ready', dispatch: { before: current } };
      },
      execute(definition) {
        const target = read(definition, deployment);
        const bytes = Buffer.from(target.bytes!, 'base64');
        if (createHash('sha256').update(bytes).digest('hex') !== target.digest)
          return Promise.resolve({ receipt: returned('release-checksum-mismatch') });
        return outcome(
          () => ctx.effects.replaceFile(target.binary, bytes, target.before, true),
          async () => ({ binary: target.binary, digest: await ctx.machine.fingerprint(target.binary) }),
          'program-installation-unconfirmed',
        );
      },
    },
    'program.path': {
      async assess(definition) {
        const { directory } = read(definition, directoryValue);
        if (await ctx.machine.userPathContains(directory))
          return complete({ directory, configured: true }, programEffects('program-user-path', directory));
        // ensureUserPath is an adapter-owned idempotent configuration operation.
        return { state: 'ready', dispatch: { directory } };
      },
      execute(definition) {
        const { directory } = read(definition, directoryValue);
        return outcome(
          () => ctx.effects.ensureUserPath(directory),
          async () => ({ directory, configured: await ctx.machine.userPathContains(directory) }),
          'user-path-save-failed',
        );
      },
    },
    'program.maintain': {
      async assess(definition, fact) {
        const target = read(definition, maintenance);
        await verifyProgramScope(ctx, target.scope, target.program);
        const current = await ctx.machine.treeStamp(target.program.binary);
        if (target.action === 'login') {
          const result = await ctx.machine.execute(
            target.program.binary.endsWith('.js') ? process.execPath : target.program.binary,
            [...(target.program.binary.endsWith('.js') ? [target.program.binary] : []), 'auth', 'status', '--json'],
            { env: claudeEnvironment(ctx), cwd: ctx.home },
          );
          let status: unknown;
          try {
            status = JSON.parse(result.stdout);
          } catch {
            status = null;
          }
          if (
            succeeded(result) &&
            typeof status === 'object' &&
            status !== null &&
            'loggedIn' in status &&
            status.loggedIn === true
          )
            return complete({ loggedIn: true }, programEffects('logged-in'));
          if (issued(fact)) return unknown('login-unconfirmed');
        } else if (issued(fact)) {
          if (fact.evidence?.snapshotUnavailable === true) return unknown();
          if (fact.evidence?.stamp !== undefined && fact.evidence.stamp !== current) return blocked('program-changed');
          const found = await programs(ctx, target.program.kind);
          for (const candidate of found.values.values()) {
            if (!(await matchesProgramScope(ctx, target.scope, candidate))) continue;
            const beforeProbe = await ctx.machine.treeStamp(candidate.binary);
            if (beforeProbe === null) continue;
            const version =
              target.program.kind === 'claude'
                ? await claudeVersion(ctx, candidate.binary)
                : await officeVersion(ctx, candidate.binary);
            const stamp = await ctx.machine.treeStamp(candidate.binary);
            if (stamp !== beforeProbe || (candidate.binary === target.program.binary && stamp !== current))
              return blocked('program-changed');
            if (stamp !== null && version === target.targetVersion && (success(fact) || target.before !== stamp))
              return complete(
                { binary: candidate.binary, stamp, version },
                programEffects('package-command-completed'),
              );
          }
          return unknown(current === null ? 'program-not-ready' : undefined);
        }
        if (current !== target.before) return blocked('program-changed');
        await verifyProgramBeforeCommand(ctx, target.program, programScope(ctx, target.scope, target.program));
        return { state: 'ready', dispatch: { before: current } };
      },
      execute(definition, _fact, _inputs, signal) {
        const target = read(definition, maintenance);
        cancelled(signal);
        return outcome(
          () =>
            target.action === 'login'
              ? ctx.effects.execute(
                  target.program.binary.endsWith('.js') ? process.execPath : target.program.binary,
                  [...(target.program.binary.endsWith('.js') ? [target.program.binary] : []), 'auth', 'login'],
                  { env: claudeEnvironment(ctx), cwd: ctx.home, isInteractive: true },
                )
              : maintainProgramChannel(
                  ctx,
                  target.program,
                  programScope(ctx, target.scope, target.program),
                  target.action === 'install' || target.action === 'reinstall' ? target.action : 'update',
                  target.targetVersion,
                  target.registry ?? undefined,
                ),
          async () => ({ stamp: await ctx.machine.treeStamp(target.program.binary) }),
          target.action === 'login' ? 'login-failed' : 'program-installation-unconfirmed',
          programEffects(target.action === 'login' ? 'logged-in' : 'package-command-completed'),
        );
      },
    },
    'program.remove-package': {
      async assess(definition, fact) {
        const target = read(definition, maintenance);
        if (target.program.kind === 'claude') await ensureStopped(ctx);
        if (target.program.channel !== 'scoop' || !issued(fact))
          await verifyProgramScope(ctx, target.scope, target.program);
        const current = await ctx.machine.treeStamp(target.program.binary);
        const absent =
          target.program.channel === 'npm'
            ? (await npmVersion(ctx, PROGRAM_PACKAGES[target.program.kind], target.scope.npm?.npmRoot)) === null
            : await programPackageAbsent(ctx, target.program, programScope(ctx, target.scope, target.program));
        if (current === null && absent === true)
          return complete(
            { absent: true, binary: target.program.binary },
            programEffects('program-removed', target.program.binary),
          );
        if (issued(fact) && current === null) return unknown('program-removal-unconfirmed');
        if (issued(fact) && (fact.receipt?.kind !== 'returned' || fact.receipt.failure === null))
          return unknown('program-removal-unconfirmed');
        if (current !== target.before) return blocked('program-changed');
        await verifyProgramBeforeCommand(ctx, target.program, programScope(ctx, target.scope, target.program));
        return { state: 'ready', dispatch: { before: current } };
      },
      execute(definition) {
        const target = read(definition, maintenance);
        return outcome(
          () => removeProgramChannel(ctx, target.program, programScope(ctx, target.scope, target.program)),
          async () => ({ stamp: await ctx.machine.treeStamp(target.program.binary) }),
          'program-uninstall-failed',
        );
      },
    },
    'program.ready': {
      async assess(definition, fact, facts) {
        const target = read(definition, readiness);
        if (target.removals && !target.removals.every(id => facts[id]?.status === 'confirmed'))
          return blocked('dependency-not-ready');
        if (target.removed) {
          const effects = [
            ...programEffects('program-removed', target.binary),
            ...(target.preserveData ? programEffects('keep-user-data', undefined, 'kept') : []),
          ];
          try {
            const found = await programs(ctx, target.kind);
            effects.push(
              ...[...found.values.values()].flatMap(program =>
                programEffects('program-other-copies-kept', program.binary, 'kept'),
              ),
            );
            effects.push(...found.problems.flatMap(code => programEffects('program-inspection-warning', code, 'kept')));
          } catch (error) {
            effects.push(...programEffects('program-inspection-warning', errorCode(error), 'kept'));
          }
          return complete({ absent: true }, effects);
        }
        let binary = target.binary;
        let expected: string | undefined = target.before ?? target.digest;
        if (target.command) {
          const command = facts[target.command];
          if (command?.status !== 'confirmed') return blocked('dependency-not-ready');
          binary = text(command.evidence?.binary) ? command.evidence.binary : binary;
          expected = text(command.evidence?.stamp) ? command.evidence.stamp : undefined;
        }
        if (target.alternatives) {
          const selected = target.alternatives
            .map(id => facts[id])
            .find(entry => entry?.status === 'confirmed' && entry.evidence?.installed === true);
          if (!selected) return blocked('dependency-not-ready');
          binary = requiredText(selected.evidence?.binary);
          expected = requiredText(selected.evidence?.stamp);
        }
        if (!binary || (await ctx.machine.treeStamp(binary)) === null) return blocked('program-not-ready');
        if (expected !== undefined && (await ctx.machine.treeStamp(binary)) !== expected)
          return blocked('program-changed');
        if (fact.evidence?.stamp !== undefined && (await ctx.machine.treeStamp(binary)) !== fact.evidence.stamp)
          return blocked('program-changed');
        if (target.scope && target.program) await verifyProgramScope(ctx, target.scope, target.program);
        if (
          !target.keep &&
          (target.kind === 'claude' ? await claudeVersion(ctx, binary) : await officeVersion(ctx, binary)) !==
            target.version
        )
          return blocked('program-not-ready');
        const stamp = await ctx.machine.treeStamp(binary);
        if (expected !== undefined && stamp !== expected) return blocked('program-changed');
        return complete(
          { binary, stamp, version: target.version },
          programEffects(target.keep ? 'program-kept' : 'program-ready', binary, target.keep ? 'kept' : 'done'),
        );
      },
      execute() {
        return Promise.resolve({ receipt: returned('program-not-ready') });
      },
    },
    'claude.install-npm': {
      async assess(definition, fact, facts) {
        const target = read(definition, claudeInstall);
        await verifyInstallScope(ctx, target);
        if (!issued(fact)) {
          await ensureEmpty(ctx, target);
          return { state: 'ready', dispatch: { native: null, manifest: null } };
        }
        if (fact.evidence?.snapshotUnavailable === true) return unknown();
        if (
          fact.evidence?.stamp !== undefined &&
          fact.evidence.stamp !== (await ctx.machine.treeStamp(requiredText(fact.evidence.binary)))
        )
          return blocked('program-changed');
        const selected = await installed(ctx, target, 'npm');
        if (selected) {
          const captured: unknown = fact.evidence?.snapshot;
          if (!npmSnapshot(captured)) return unknown();
          await verifySnapshot(ctx, target, captured);
          if (fact.evidence?.stamp !== undefined && fact.evidence.stamp !== selected.stamp)
            return blocked('program-changed');
          return complete(
            { ...fact.evidence, ...selected, installed: true },
            programEffects('package-command-completed'),
          );
        }
        if (ctx.platform !== 'win32' || fact.receipt?.kind !== 'returned') return unknown();
        // A returned command with failed installation permits the frozen CMD alternative.
        const prior: unknown = fact.evidence?.snapshot;
        if (!npmSnapshot(prior)) return unknown();
        const cleanup = facts[target.cleanupOperation];
        if (cleanup?.confirmed && cleanup.evidence?.absent === true) {
          if (
            (await snapshot(ctx, target)).manifest !== null ||
            (prior.binary && (await ctx.machine.treeStamp(prior.binary)) !== null)
          )
            return blocked('program-changed');
        } else await verifySnapshot(ctx, target, prior);
        return complete(
          { ...fact.evidence, fallback: true, installed: false },
          programEffects(fact.receipt.failure ?? 'program-not-ready', undefined, 'failed'),
        );
      },
      execute(definition) {
        const target = read(definition, claudeInstall);
        return outcome(
          () =>
            target.npm
              ? ctx.effects.npm(
                  npmInstallArgs(
                    [
                      'install',
                      '-g',
                      ...target.npm.args,
                      ...npmScriptFlags('claude'),
                      `${PROGRAM_PACKAGES.claude}@${target.version}`,
                    ],
                    target.registry,
                  ),
                )
              : Promise.resolve({ code: 1, failed: false, stdout: '' }),
          async () => {
            const current = await snapshot(ctx, target);
            return {
              snapshot: { ...current },
              ...(current.stamp ? { stamp: current.stamp, binary: current.binary } : {}),
            };
          },
          'npm-install-failed',
        );
      },
    },
    'claude.cleanup-npm': {
      async assess(definition, fact, facts) {
        const target = read(definition, claudeInstall);
        const alternative = fallback(target, facts);
        if (alternative) return alternative;
        await verifyInstallScope(ctx, target);
        const before: unknown = facts[target.npmOperation]?.evidence?.snapshot;
        if (!npmSnapshot(before)) return unknown();
        const current = await snapshot(ctx, target);
        if (current.manifest === null) {
          if (before.binary && (await ctx.machine.treeStamp(before.binary)) !== null) return blocked('program-changed');
          return complete(
            { absent: true },
            before.manifest === null && !issued(fact) ? [] : programEffects('failed-install-cleaned'),
          );
        }
        await verifySnapshot(ctx, target, before);
        if (!target.npm || (await npmVersion(ctx, PROGRAM_PACKAGES.claude, target.npm.npmRoot)) !== target.version)
          return blocked('program-changed');
        if (issued(fact) && fact.receipt?.kind !== 'returned') return unknown();
        return { state: 'ready', dispatch: { snapshot: { ...before } } };
      },
      execute(definition) {
        const target = read(definition, claudeInstall);
        return outcome(
          () => ctx.effects.npm(npmUninstallArgs(['uninstall', '-g', ...target.npm!.args, PROGRAM_PACKAGES.claude])),
          async () => ({ snapshot: { ...(await snapshot(ctx, target)) } }),
          'failed-install-cleanup-failed',
        );
      },
    },
    'claude.stage-cmd': {
      async assess(definition, fact, facts) {
        const target = read(definition, claudeInstall);
        const alternative = fallback(target, facts);
        if (alternative) return alternative;
        if (facts[target.cleanupOperation]?.status !== 'confirmed') return blocked('dependency-not-ready');
        if (!target.directory || !target.script) return blocked('installer-unavailable');
        const stamp = await ctx.machine.treeStamp(target.directory);
        if (facts[target.scriptCleanupOperation]?.confirmed && stamp === null) return complete(fact.evidence ?? {});
        if (issued(fact)) {
          if (fact.evidence?.snapshotUnavailable === true) return unknown();
          if (fact.receipt?.kind === 'returned' && fact.receipt.failure !== null) return unknown('installer-conflict');
          const entries = await ctx.machine.entries(target.directory);
          if (
            stamp !== null &&
            entries.length === 1 &&
            entries[0]?.name === 'install.cmd' &&
            entries[0].kind === 'file' &&
            (await ctx.machine.read(path.join(target.directory, 'install.cmd'))) === target.script &&
            (await ctx.machine.treeStamp(target.directory)) === stamp
          )
            return complete({ stamp, directory: target.directory });
          return unknown('installer-conflict');
        }
        if (stamp !== null) return blocked('installer-conflict');
        await ensureEmpty(ctx, target);
        return { state: 'ready', dispatch: { absent: true } };
      },
      async execute(definition) {
        const target = read(definition, claudeInstall);
        let result: NonNullable<OperationFact['receipt']>;
        try {
          result = returned(
            (await ctx.effects.initialize(path.join(target.directory!, 'install.cmd'), target.script!))
              ? null
              : 'installer-conflict',
          );
        } catch (error) {
          result = { kind: 'unknown', failure: errorCode(error) };
        }
        try {
          return { receipt: result, evidence: { stamp: await ctx.machine.treeStamp(target.directory!) } };
        } catch {
          return { receipt: result };
        }
      },
    },
    'claude.install-cmd': {
      async assess(definition, fact, facts) {
        const target = read(definition, claudeInstall);
        const alternative = fallback(target, facts);
        if (alternative) return alternative;
        await verifyInstallScope(ctx, target);
        if (issued(fact)) {
          if (fact.evidence?.snapshotUnavailable === true) return unknown();
          if (
            fact.evidence?.stamp !== undefined &&
            fact.evidence.stamp !== (await ctx.machine.treeStamp(target.native))
          )
            return blocked('program-changed');
          const selected = await installed(ctx, target, 'native');
          if (!selected) return unknown(fact.receipt?.failure ?? undefined);
          if (fact.evidence?.stamp !== undefined && fact.evidence.stamp !== selected.stamp)
            return blocked('program-changed');
          return complete({ ...selected, installed: true }, programEffects('package-command-completed'));
        }
        if (facts[target.stageOperation]?.status !== 'confirmed') return blocked('dependency-not-ready');
        if ((await ctx.machine.treeStamp(target.directory!)) !== facts[target.stageOperation]?.evidence?.stamp)
          return blocked('installer-conflict');
        await ensureEmpty(ctx, target);
        return { state: 'ready', dispatch: { native: null } };
      },
      execute(definition) {
        const target = read(definition, claudeInstall);
        return outcome(
          () =>
            ctx.effects.execute('cmd.exe', ['/d', '/v:off', '/s', '/c', '.\\install.cmd', target.version], {
              env: claudeEnvironment(ctx),
              cwd: target.directory!,
            }),
          async () => ({ binary: target.native, stamp: await ctx.machine.treeStamp(target.native) }),
          'cmd-install-failed',
        );
      },
    },
    'claude.cleanup-script': {
      async assess(definition, _fact, facts) {
        const target = read(definition, claudeInstall);
        const alternative = fallback(target, facts);
        if (alternative) return alternative;
        if (!facts[target.cmdOperation]?.attemptId) return blocked('dependency-not-ready');
        const stamp = await ctx.machine.treeStamp(target.directory!);
        if (stamp === null) return complete({ absent: true });
        if (stamp !== facts[target.stageOperation]?.evidence?.stamp) return blocked('installer-conflict');
        return { state: 'ready', dispatch: { stamp } };
      },
      execute(definition, fact) {
        const target = read(definition, claudeInstall);
        return outcome(
          () => ctx.effects.removeTree(target.directory!, requiredText(fact.dispatch?.stamp)),
          async () => ({ absent: (await ctx.machine.treeStamp(target.directory!)) === null }),
          'installer-conflict',
        );
      },
    },
  };
}
