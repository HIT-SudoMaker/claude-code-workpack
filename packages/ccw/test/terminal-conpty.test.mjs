import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('验证 Windows 终端交互与恢复', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-terminal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, 'conpty.exe');
  const compiler = path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(
    compiler,
    ['/nologo', '/utf8output', `/out:${exe}`, fileURLToPath(new URL('./windows-conpty.cs', import.meta.url))],
    { windowsHide: true, timeout: 20_000 },
  );
  for (const scenario of [
    'brand',
    'settings',
    'selection',
    'recovery',
    'recovery-unknown',
    'skills-cancel',
    'uninstall',
    'uninstall-data',
    'cleanup',
    'form',
    'form-details',
    'progress',
    'progress-narrow',
    'multiline-result',
    'handoff',
    'cancel',
    'render',
    'waiting',
  ]) {
    const output = execFileSync(
      exe,
      [process.execPath, fileURLToPath(new URL('./terminal-fixture.mjs', import.meta.url)), scenario],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
    );
    assert.match(output, new RegExp(`PASS: ${scenario}`));
  }
});
