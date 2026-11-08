import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createMachine } from '../dist/machine.js';

async function temporaryDirectory(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccw-binary-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('替换二进制：校验前置摘要', async t => {
  const root = await temporaryDirectory(t);
  const machine = createMachine({}, root);
  const binary = path.join(root, 'tool');
  const notes = path.join(root, 'notes');
  await fs.writeFile(notes, 'user data');
  const first = Uint8Array.from([0, 128, 255]);
  const second = Uint8Array.from([255, 0, 2]);
  await machine.replaceFile(binary, first, null, true);
  assert.deepEqual(await fs.readFile(binary), Buffer.from(first));
  await assert.rejects(machine.replaceFile(binary, second, null), /target-changed/);
  assert.deepEqual(await fs.readFile(binary), Buffer.from(first));
  await machine.replaceFile(binary, second, createHash('sha256').update(first).digest('hex'), true);
  assert.deepEqual(await fs.readFile(binary), Buffer.from(second));
  assert.equal(await fs.readFile(notes, 'utf8'), 'user data');
  assert.deepEqual((await fs.readdir(root)).sort(), ['notes', 'tool']);
});

test('拒绝沿共享链接部署程序', async t => {
  const root = await temporaryDirectory(t);
  const shared = path.join(root, 'shared');
  const link = path.join(root, 'link');
  await fs.mkdir(shared);
  await fs.writeFile(path.join(shared, 'tool'), 'shared');
  await fs.symlink(shared, link, process.platform === 'win32' ? 'junction' : 'dir');
  const machine = createMachine({}, root);
  await assert.rejects(
    machine.replaceFile(
      path.join(link, 'tool'),
      Buffer.from('new'),
      await machine.fingerprint(path.join(shared, 'tool')),
    ),
    /linked-parent/,
  );
  assert.equal(await fs.readFile(path.join(shared, 'tool'), 'utf8'), 'shared');
});

test('安装越界资源：保留现有目录', async t => {
  const root = await temporaryDirectory(t);
  const machine = createMachine({}, root);
  const directory = path.join(root, 'asset');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'keep'), 'old');
  const stamp = await machine.treeStamp(directory);
  await assert.rejects(
    machine.replaceTree(directory, [{ path: '../escaped', data: Buffer.from('bad') }], stamp),
    /invalid-source-path/,
  );
  assert.equal(await fs.readFile(path.join(directory, 'keep'), 'utf8'), 'old');
  assert.equal(
    await fs.stat(path.join(root, 'escaped')).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test('缺少用户目录：拒绝修改 PATH', async t => {
  const root = await temporaryDirectory(t);
  await assert.rejects(createMachine({}, root).ensureUserPath(root), /user-home-unconfirmed/);
});

test('保留已配置的用户 PATH', async t => {
  const root = await temporaryDirectory(t);
  await assert.doesNotReject(createMachine({ PATH: root }, root).ensureUserPath(root));
});
