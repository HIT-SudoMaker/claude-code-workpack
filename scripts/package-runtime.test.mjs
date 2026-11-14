import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { packageRuntime } from './package-runtime.mjs';
import { compileConpty, runConpty } from '../packages/ccw/test/conpty.mjs';

const RUNTIME_SCENARIO_TIMEOUT_MS = 30_000;

const { version } = JSON.parse(fs.readFileSync(new URL('../packages/ccw/package.json', import.meta.url), 'utf8'));

test('验证独立运行包', async testContext => {
  const runtime = packageRuntime();
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-runtime-sandbox-')));
  testContext.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  await testContext.test('包含生产依赖与许可证', () => {
    for (const name of ['typescript', 'eslint', 'prettier', '@types/react']) {
      assert.equal(fs.existsSync(path.join(runtime, 'node_modules', name)), false, name);
    }
    assert.deepEqual(fs.readdirSync(path.join(runtime, 'packages')), ['ccw']);
    assert.equal(
      fs.readFileSync(path.join(runtime, 'LICENSE'), 'utf8'),
      fs.readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'),
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'packages/ccw/package.json'), 'utf8'));
    assert.equal(manifest.private, true);
    for (const field of ['devDependencies', 'files', 'publishConfig', 'scripts'])
      assert.equal(manifest[field], undefined);
    assert.equal(
      execFileSync(process.execPath, [path.join(runtime, 'packages/ccw/dist/main.js'), '--version'], {
        cwd: sandbox,
        encoding: 'utf8',
        windowsHide: true,
      }).trim(),
      version,
    );
  });
  for (const [scenario, title] of [
    ['ccline', '安装 ccline'],
    ['settings', '保存配置并安装随包 AMIRC Skill'],
    ['officecli', '安装与卸载 OfficeCLI'],
  ]) {
    await testContext.test(title, () => {
      const cwd = path.join(sandbox, scenario);
      fs.mkdirSync(cwd);
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('./runtime-fixture.mjs', import.meta.url)), runtime, scenario],
        { cwd, windowsHide: true, encoding: 'utf8', timeout: RUNTIME_SCENARIO_TIMEOUT_MS },
      );
    });
  }
  await testContext.test('显示真实终端', { skip: process.platform !== 'win32' }, () => {
    const terminalFixture = path.join(runtime, 'terminal-fixture.mjs');
    testContext.after(() => fs.rmSync(terminalFixture, { force: true }));
    const compiledRoot = pathToFileURL(path.join(runtime, 'packages/ccw/dist') + path.sep).href;
    const source = fs.readFileSync(new URL('../packages/ccw/test/terminal-fixture.mjs', import.meta.url), 'utf8');
    fs.writeFileSync(terminalFixture, source.replaceAll('../dist/', compiledRoot));
    const conpty = compileConpty(sandbox);
    const terminalOutput = runConpty(conpty, terminalFixture, 'home', sandbox);
    assert.match(terminalOutput, /PASS: home/);
  });
});
