import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileConpty, runConpty } from './conpty.mjs';

test('验证 Windows 终端交互', { skip: process.platform !== 'win32' }, testContext => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-terminal-'));
  testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = compileConpty(root);
  for (const scenario of [
    'home',
    'inspection',
    'narrow',
    'selection',
    'settings',
    'form',
    'handoff',
    'cancel',
    'waiting',
  ]) {
    const output = runConpty(exe, fileURLToPath(new URL('./terminal-fixture.mjs', import.meta.url)), scenario);
    assert.match(output, new RegExp(`PASS: ${scenario}`));
  }
});
