import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { releaseContract } from '../packages/ccw/test/office-release.mjs';
const runtime = path.resolve(process.argv[2]);
const scenario = process.argv[3];
const { createCcw } = await import(pathToFileURL(path.join(runtime, 'packages/ccw/dist/ccw.js')).href);
const { createMachine } = await import(pathToFileURL(path.join(runtime, 'packages/ccw/dist/machine.js')).href);
const home = path.resolve('home');
const claudeRoot = path.resolve('active');
const cclineRoot = path.join(home, '.claude/ccline');
const binary = path.join(cclineRoot, process.platform === 'win32' ? 'ccline.exe' : 'ccline');
const npmPrefix = path.resolve('npm-prefix');
const npmRoot = path.join(npmPrefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules');
let installed = false;
let userPathConfigured = false;
const officeBytes = Buffer.from('packaged OfficeCLI program fixture');
const officeDigest = createHash('sha256').update(officeBytes).digest('hex');
const officeAsset =
  process.platform === 'win32'
    ? 'officecli-win-' + process.arch + '.exe'
    : process.platform === 'darwin'
      ? 'officecli-mac-' + process.arch
      : 'officecli-linux-' + process.arch;
const officeBinary =
  process.platform === 'win32'
    ? path.join(home, 'AppData/Local/OfficeCli/officecli.exe')
    : path.join(home, '.local/bin/officecli');
const officeRelease = releaseContract({
  tag: 'v1.0.123',
  asset: officeAsset,
  digest: officeDigest,
  revision: '0123456789abcdef0123456789abcdef01234567',
});
const SKILLS_CLI_PREFIX = ['exec', '--yes', '--package=skills@1.8.1', '--', 'skills'];
const originalMachine = createMachine();
const machine = {
  ...originalMachine,
  async npm(args, options) {
    if (args[0] === 'exec') {
      assert.deepEqual(args.slice(0, SKILLS_CLI_PREFIX.length), SKILLS_CLI_PREFIX);
      const [operation, sourceArgument, ...flags] = args.slice(SKILLS_CLI_PREFIX.length);
      assert.equal(operation, 'a');
      const source = path.join(runtime, 'packages/ccw/assets/skills/amirc-research');
      assert.equal(sourceArgument, source);
      assert.equal(options.env.CLAUDE_CONFIG_DIR, claudeRoot);
      assert.equal(options.env.XDG_STATE_HOME, path.join(home, '.ccw'));
      if (args.at(-1) === '--list')
        return {
          code: 0,
          failed: false,
          stdout: '│\n◇  Available Skills\n│    amirc-research\n└  Use --skill <name> to install specific skills\n',
        };
      assert.deepEqual(flags, [
        '--skill',
        'amirc-research',
        '--agent',
        'claude-code',
        '--global',
        '--yes',
        '--copy',
        '--json',
      ]);
      const directory = path.join(claudeRoot, 'skills/amirc-research');
      await fs.cp(source, directory, { recursive: true });
      return {
        code: 0,
        failed: false,
        stdout: JSON.stringify([
          {
            name: 'amirc-research',
            status: 'installed',
            path: directory,
            scope: 'global',
            mode: 'copy',
            agents: ['Claude Code'],
          },
        ]),
      };
    }
    if (args[0] === 'config') {
      assert.deepEqual(args.slice(0, 2), ['config', 'get']);
      assert.ok(args.length === 3 && ['registry', '@cometix:registry'].includes(args[2]));
      return { code: 0, failed: false, stdout: args[2] === 'registry' ? 'https://registry.npmjs.org' : 'undefined' };
    }
    const prefix = args.find(arg => arg.startsWith('--prefix='))?.slice('--prefix='.length);
    if (prefix !== undefined) assert.equal(prefix, npmPrefix);
    if (args[0] === 'root') return { code: 0, failed: false, stdout: npmRoot };
    if (args[0] === 'install') {
      assert.equal(prefix, npmPrefix);
      assert.ok(args.includes('--registry=https://registry.npmjs.org'));
      assert.ok(args.includes('--@cometix:registry=https://registry.npmjs.org'));
      await fs.mkdir(npmRoot, { recursive: true });
      await fs.mkdir(cclineRoot, { recursive: true });
      await fs.writeFile(binary, 'isolated fixture');
      installed = true;
    }
    return {
      code: 0,
      failed: false,
      stdout:
        args[0] === 'view'
          ? JSON.stringify('2.0.1')
          : args[0] === 'ls'
            ? JSON.stringify({ dependencies: installed ? { '@cometix/ccline': { version: '2.0.1' } } : {} })
            : '',
    };
  },
  async locate() {
    return [];
  },
  async processes() {
    return [];
  },
  async userPathContains() {
    return userPathConfigured;
  },
  async ensureUserPath() {
    userPathConfigured = true;
  },
  async fetchBytes(url) {
    assert.equal(url, officeRelease.release + officeAsset);
    return officeBytes;
  },
  fetchText: officeRelease.fetchText,
  async source() {
    return [{ path: 'SKILL.md', data: Buffer.from('---\nname: officecli\n---\n') }];
  },
  async execute(executable, args) {
    if (executable === binary) {
      assert.deepEqual(args, ['--version']);
      return { code: 0, failed: false, stdout: 'ccline 2.0.1' };
    }
    if (executable === officeBinary) {
      assert.deepEqual(args, ['--version']);
      return { code: 0, failed: false, stdout: 'OfficeCLI 1.0.123' };
    }
    throw new Error(`Unexpected runtime command: ${executable} ${args.join(' ')}`);
  },
};
const ccw = createCcw({ machine, home, claudeRoot, cclineRoot, platform: process.platform });

async function settings() {
  const batch = await ccw.plan({
    task: 'install',
    selected: [{ id: 'settings', fields: { language: '中文' } }, { id: 'skill:amirc-research' }],
  });
  assert.ok(
    batch.items.every(item => item.problem === null),
    JSON.stringify(batch),
  );
  const result = await ccw.apply(batch.id);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(JSON.parse(await fs.readFile(path.join(claudeRoot, 'settings.json'), 'utf8')).language, '中文');
  assert.match(
    await fs.readFile(path.join(claudeRoot, 'skills/amirc-research/SKILL.md'), 'utf8'),
    /name: amirc-research/,
  );
}
const scenarios = {
  async ccline() {
    const plan = await ccw.plan({ task: 'install', selected: [{ id: 'ccline' }] });
    assert.equal(plan.problem, null);
    assert.ok(
      plan.items.every(item => item.problem === null),
      JSON.stringify(plan),
    );
    assert.equal((await ccw.apply(plan.id)).state, 'done');
    assert.equal(
      createHash('sha256')
        .update((await fs.readFile(path.join(cclineRoot, 'config.toml'), 'utf8')).replaceAll('\r\n', '\n'))
        .digest('hex'),
      'a8a5cf6bbf69add6f5fb99bc96545e7948f61e6082ddbb3bcd48c12fe065da48',
    );
    assert.equal(
      JSON.parse(await fs.readFile(path.join(claudeRoot, 'settings.json'), 'utf8')).statusLine.command,
      'ccline',
    );
  },
  settings,
  async officecli() {
    const officePlan = await ccw.plan({
      task: 'install',
      selected: [{ id: 'officecli' }],
    });
    assert.ok(
      officePlan.items.every(item => item.problem === null),
      JSON.stringify(officePlan),
    );
    assert.equal((await ccw.apply(officePlan.id)).state, 'done');
    assert.equal(
      createHash('sha256')
        .update(await fs.readFile(officeBinary))
        .digest('hex'),
      officeDigest,
    );
    assert.match(await fs.readFile(path.join(claudeRoot, 'skills/officecli/SKILL.md'), 'utf8'), /name: officecli/);
    const officeRemove = await ccw.plan({ task: 'uninstall', selected: [{ id: 'officecli' }] });
    assert.ok(
      officeRemove.items.every(item => item.problem === null),
      JSON.stringify(officeRemove),
    );
    assert.equal((await ccw.apply(officeRemove.id)).state, 'done');
    await assert.rejects(fs.stat(officeBinary), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(claudeRoot, 'skills/officecli')), { code: 'ENOENT' });
  },
};
if (!Object.hasOwn(scenarios, scenario)) throw new Error('unknown-runtime-scenario');
await scenarios[scenario]();
