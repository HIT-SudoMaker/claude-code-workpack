import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
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
const officeBase = 'https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.123/';
const originalMachine = createMachine();
const machine = {
  ...createMachine(),
  async npm(args) {
    const prefix = args.find(arg => arg.startsWith('--prefix='))?.slice('--prefix='.length);
    if (prefix !== undefined) assert.equal(prefix, npmPrefix);
    if (args[0] === 'root') return { code: 0, failed: false, stdout: npmRoot };
    if (args[0] === 'install') {
      assert.equal(prefix, npmPrefix);
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
  async ensureUserPath() {},
  async fetchBytes(url) {
    assert.equal(url, officeBase + officeAsset);
    return officeBytes;
  },
  async fetchText(url) {
    if (url.endsWith('/releases/latest'))
      return JSON.stringify({
        tag_name: 'v1.0.123',
        draft: false,
        prerelease: false,
        assets: [
          { name: officeAsset, browser_download_url: officeBase + officeAsset, digest: 'sha256:' + officeDigest },
          { name: 'SHA256SUMS', browser_download_url: officeBase + 'SHA256SUMS' },
        ],
      });
    assert.equal(url, officeBase + 'SHA256SUMS');
    return officeDigest + '  ' + officeAsset;
  },
  async execute(executable, args, options) {
    if (executable === binary) {
      assert.deepEqual(args, ['--version']);
      return { code: 0, failed: false, stdout: 'ccline 2.0.1' };
    }
    if (executable === officeBinary) {
      assert.deepEqual(args, ['--version']);
      return { code: 0, failed: false, stdout: 'OfficeCLI 1.0.123' };
    }
    return originalMachine.execute(executable, args, options);
  },
};
const ccw = createCcw({ machine, home, claudeRoot, cclineRoot, platform: process.platform });

async function settings() {
  const batch = await ccw.plan({
    task: 'install',
    selected: [
      { id: 'settings', fields: { language: '中文' } },
      { id: 'mcp:context7' },
      { id: 'skill:amirc-research' },
    ],
  });
  assert.ok(batch.items.every(item => item.problem === null));
  assert.equal((await ccw.apply(batch.id)).state, 'done');
  assert.equal(JSON.parse(await fs.readFile(path.join(claudeRoot, 'settings.json'), 'utf8')).language, '中文');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(claudeRoot, '.claude.json'), 'utf8')).mcpServers.context7.url,
    'https://mcp.context7.com/mcp',
  );
  const state = JSON.parse(await fs.readFile(path.join(claudeRoot, '.claude.json'), 'utf8'));
  assert.equal(state.mcpServers.amirc, undefined);
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
        .update(await fs.readFile(path.join(cclineRoot, 'config.toml')))
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
      selected: [{ id: 'officecli', fields: { connection: 'mcp' } }],
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
    assert.equal(
      JSON.parse(await fs.readFile(path.join(claudeRoot, '.claude.json'), 'utf8')).mcpServers.officecli.command,
      officeBinary,
    );
    const officeRemove = await ccw.plan({ task: 'uninstall', selected: [{ id: 'officecli' }] });
    assert.ok(
      officeRemove.items.every(item => item.problem === null),
      JSON.stringify(officeRemove),
    );
    assert.equal((await ccw.apply(officeRemove.id)).state, 'done');
    assert.equal(
      await fs.stat(officeBinary).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      JSON.parse(await fs.readFile(path.join(claudeRoot, '.claude.json'), 'utf8')).mcpServers.officecli,
      undefined,
    );
  },
  async amirc() {
    await settings();
    assert.equal(
      await fs.stat(path.join(runtime, 'packages/amirc_academic_mcp')).then(
        () => true,
        () => false,
      ),
      false,
    );
  },
};
if (!Object.hasOwn(scenarios, scenario)) throw new Error('unknown-runtime-scenario');
await scenarios[scenario]();
