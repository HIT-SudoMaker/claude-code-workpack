import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createMachine } from '../dist/machine.js';

async function temporaryDirectory(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccw-environment-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('读取命令输出：保留分块中文', async () => {
  const script =
    "const bytes=Buffer.from('中文路径');process.stdout.write(bytes.subarray(0,1));setTimeout(()=>process.stdout.write(bytes.subarray(1,5)),50);setTimeout(()=>process.stdout.write(bytes.subarray(5)),100);";
  const result = await createMachine().execute(process.execPath, ['-e', script]);
  assert.equal(result.code, 0);
  assert.equal(result.failed, false);
  assert.equal(result.stdout, '中文路径');
});

test('限制命令输出：按原始字节计数', async () => {
  const result = await createMachine().execute(process.execPath, [
    '-e',
    'process.stdout.write(Buffer.alloc(1024*1024+1,65));',
  ]);
  assert.equal(result.failed, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 1024 * 1024);
});

test('执行 Windows CMD：支持特殊目录', { skip: process.platform !== 'win32' }, async t => {
  const root = await temporaryDirectory(t);
  const directory = path.join(root, 'space & percent% ! (folder)');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'install.cmd'), '@echo off\r\necho version=%1\r\n');
  const result = await createMachine(process.env, root).execute(
    'cmd.exe',
    ['/d', '/v:off', '/s', '/c', '.\\install.cmd', '2.1.318'],
    { cwd: directory },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), 'version=2.1.318');
});

test('执行 PowerShell：保留参数字面值', { skip: process.platform !== 'win32' }, async t => {
  const root = await temporaryDirectory(t);
  const script = path.join(root, 'literal arguments.ps1');
  await fs.writeFile(script, 'ConvertTo-Json -InputObject @($args) -Compress');
  const args = ['space value', 'a&b', '$(throw "must not run")', 'semi;colon'];
  const result = await createMachine(process.env, root).execute(script, args);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

for (const name of ['PATH', 'Path', 'path'])
  test(`定位程序：读取 ${name}`, async t => {
    const root = await temporaryDirectory(t);
    const binary = path.join(root, process.platform === 'win32' ? 'officecli.exe' : 'officecli');
    await fs.writeFile(binary, 'fixture');
    const result = await createMachine({ [name]: root }, root).locate('officecli');
    assert.deepEqual(result, process.platform === 'win32' || name === 'PATH' ? [binary] : []);
  });

test('合并命令环境：遵守系统键规则', async () => {
  const machine = createMachine({ CCW_TEST_VALUE: 'base' });
  const result = await machine.execute(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify([process.env.CCW_TEST_VALUE,process.env.ccw_test_value]));'],
    { env: { ccw_test_value: 'override' } },
  );
  assert.equal(result.code, 0);
  assert.deepEqual(
    JSON.parse(result.stdout),
    process.platform === 'win32' ? ['override', 'override'] : ['base', 'override'],
  );
});

test('移除命令环境：覆盖已有键', async () => {
  const machine = createMachine({ CCW_TEST_VALUE: 'base' });
  const result = await machine.execute(
    process.execPath,
    ['-e', "process.stdout.write(process.env.CCW_TEST_VALUE??'absent');"],
    { env: { ccw_test_value: undefined } },
  );
  assert.equal(result.stdout, process.platform === 'win32' ? 'absent' : 'base');
});

test('执行 npm：拒绝入口替换', async t => {
  const root = await temporaryDirectory(t);
  const cli = path.join(root, 'npm-cli.js');
  await fs.writeFile(cli, "process.stdout.write('first');");
  const machine = createMachine({ npm_execpath: cli }, root);
  assert.equal((await machine.npm(['--version'])).stdout, 'first');
  await fs.writeFile(cli, "process.stdout.write('replaced');");
  await assert.rejects(machine.npm(['--version']), /^Error: npm-changed$/);
});

for (const shell of ['zsh', 'fish'])
  test(`保存 PATH：遵守 ${shell} 配置根`, async t => {
    const root = await temporaryDirectory(t);
    const redirected = path.join(root, 'configuration');
    const binaryRoot = path.join(root, 'bin');
    const script = `
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { createMachine } = await import(${JSON.stringify(new URL('../dist/machine.js', import.meta.url).href)});
    const machine = createMachine({ HOME: ${JSON.stringify(root)}, SHELL: ${JSON.stringify(shell)}, ZDOTDIR: ${JSON.stringify(redirected)}, XDG_CONFIG_HOME: ${JSON.stringify(redirected)} }, ${JSON.stringify(root)});
    await machine.ensureUserPath(${JSON.stringify(binaryRoot)});
    await machine.ensureUserPath(${JSON.stringify(binaryRoot)});
  `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    assert.equal(child.status, 0, child.stderr);
    const profile = path.join(redirected, shell === 'zsh' ? '.zshrc' : 'fish/config.fish');
    const contents = await fs.readFile(profile, 'utf8');
    assert.equal(contents.trim().split('\n').length, 1);
    assert.ok(contents.includes(binaryRoot));
    await assert.rejects(fs.stat(path.join(root, shell === 'zsh' ? '.zshrc' : '.config/fish/config.fish')), {
      code: 'ENOENT',
    });
  });

for (const value of ['', '   ', '  custom-config  '])
  test(`解析配置根：${value.trim() ? '自定义目录' : value ? '空白值' : '空值'}`, async t => {
    const root = await temporaryDirectory(t);
    const entry = new URL('../dist/main.js', import.meta.url).href;
    const core = new URL('../dist/ccw.js', import.meta.url).href;
    const terminal = new URL('../dist/terminal.js', import.meta.url).href;
    const view = new URL('../dist/terminal-view.js', import.meta.url).href;
    const replacements = {
      [core]:
        'export const createCcw = options => ({ inspect: async () => { console.log(JSON.stringify({home:options.home,claudeRoot:options.claudeRoot,claudeState:options.claudeState}));return {items:[],problems:[]}; } });',
      [terminal]: 'export const runTerminal=()=>{};',
      [view]: 'export const createTerminal=()=>{};',
    };
    const script = `
    import { registerHooks } from 'node:module';
    const replacements=${JSON.stringify(replacements)};
    registerHooks({ load(url, context, nextLoad) { return replacements[url] ? {format:'module',shortCircuit:true,source:replacements[url]} : nextLoad(url,context); } });
    process.argv[2]='--inspect';
    await import(${JSON.stringify(entry)});
  `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: value },
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    assert.equal(child.status, 0, child.stderr);
    const options = JSON.parse(child.stdout.trim());
    assert.equal(options.claudeRoot, value.trim() ? path.join(root, 'custom-config') : path.join(root, '.claude'));
    assert.equal(
      options.claudeState,
      value.trim() ? path.join(root, 'custom-config/.claude.json') : path.join(root, '.claude.json'),
    );
  });
