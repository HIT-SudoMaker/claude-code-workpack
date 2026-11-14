import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createMachine } from '../dist/machine.js';
import { createTemporaryDirectory } from './test-environment.mjs';

// 部署与已有 PATH
test('替换二进制：校验前置摘要', async testContext => {
  const root = await createTemporaryDirectory(testContext);
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

test('保留已配置的用户 PATH', async testContext => {
  const root = await createTemporaryDirectory(testContext);
  await assert.doesNotReject(createMachine({ PATH: root }, root).ensureUserPath(root));
});

// 路径与用户目录保护
test('拒绝沿共享链接部署程序', async testContext => {
  const root = await createTemporaryDirectory(testContext);
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

test('安装越界资源：保留现有目录', async testContext => {
  const root = await createTemporaryDirectory(testContext);
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

test('缺少用户目录：拒绝修改 PATH', async testContext => {
  const root = await createTemporaryDirectory(testContext);
  await assert.rejects(createMachine({}, root).ensureUserPath(root), /user-home-unconfirmed/);
});

test('PATH 匹配不能绕过非法目标校验', async testContext => {
  const root = await createTemporaryDirectory(testContext);
  for (const directory of ['relative', path.parse(root).root, root + '\ninvalid', root + '\0invalid']) {
    const machine = createMachine({ PATH: directory }, root);
    await assert.rejects(machine.userPathContains(directory), /invalid-target/);
    await assert.rejects(machine.ensureUserPath(directory), /invalid-target/);
  }
});
