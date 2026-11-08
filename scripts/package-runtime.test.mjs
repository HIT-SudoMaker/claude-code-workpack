import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { packageRuntime } from './package-runtime.mjs';

test('验证独立运行包', async t => {
  const runtime = packageRuntime();
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-runtime-sandbox-')));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  await t.test('包含生产依赖与许可证', () => {
    for (const name of ['typescript', 'eslint', 'prettier', '@types/react', '@modelcontextprotocol/sdk', 'zod']) {
      assert.equal(fs.existsSync(path.join(runtime, 'node_modules', name)), false, name);
    }
    assert.equal(fs.existsSync(path.join(runtime, 'node_modules/smol-toml/LICENSE')), true);
    assert.equal(fs.existsSync(path.join(runtime, 'packages/ccw/dist/amirc.js')), false);
    assert.equal(
      execFileSync(process.execPath, [path.join(runtime, 'packages/ccw/dist/main.js'), '--version'], {
        cwd: sandbox,
        encoding: 'utf8',
        windowsHide: true,
      }).trim(),
      '0.4.0',
    );
  });
  for (const [scenario, title] of [
    ['ccline', '安装 ccline'],
    ['settings', '保存配置与注册'],
    ['officecli', '安装与卸载 OfficeCLI'],
    ['amirc', '安装随包 AMIRC Skill'],
  ]) {
    await t.test(title, () => {
      const cwd = path.join(sandbox, scenario);
      fs.mkdirSync(cwd);
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('./runtime-fixture.mjs', import.meta.url)), runtime, scenario],
        { cwd, windowsHide: true, encoding: 'utf8', timeout: 30_000 },
      );
    });
  }
  await t.test('显示真实终端', { skip: process.platform !== 'win32' }, () => {
    const terminalFixture = path.join(runtime, 'terminal-test.mjs');
    t.after(() => fs.rmSync(terminalFixture, { force: true }));
    const compiledRoot = pathToFileURL(path.join(runtime, 'packages/ccw/dist') + path.sep).href;
    const source = fs.readFileSync(new URL('../packages/ccw/test/terminal-fixture.mjs', import.meta.url), 'utf8');
    fs.writeFileSync(terminalFixture, source.replaceAll('../dist/', compiledRoot));
    const conpty = path.join(sandbox, 'conpty.exe');
    const compiler = path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(
      compiler,
      [
        '/nologo',
        '/utf8output',
        `/out:${conpty}`,
        fileURLToPath(new URL('../packages/ccw/test/windows-conpty.cs', import.meta.url)),
      ],
      { windowsHide: true, timeout: 20_000 },
    );
    const terminalOutput = execFileSync(conpty, [process.execPath, terminalFixture, 'brand'], {
      cwd: sandbox,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.match(terminalOutput, /PASS: brand/);
  });
});
