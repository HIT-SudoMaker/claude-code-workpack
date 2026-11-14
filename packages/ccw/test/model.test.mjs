import assert from 'node:assert/strict';
import { test } from 'node:test';

import { json } from '../dist/model.js';

test('读取缺失配置：回退空对象', async () => {
  const machine = { read: async () => null };
  assert.deepEqual(await json(machine, 'settings.json'), {});
});

test('读取损坏配置：抛稳定码', async () => {
  const machine = { read: async () => '{ broken' };
  await assert.rejects(json(machine, 'settings.json'), error => {
    assert.equal(error.message, 'invalid-settings');
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
});

test('读取非对象配置：抛稳定码', async () => {
  const machine = { read: async () => '"text"' };
  await assert.rejects(json(machine, 'settings.json'), { message: 'invalid-settings' });
});

test('读取失败：原样传播读取异常', async () => {
  const failure = new Error('read-failed');
  const machine = {
    read: async () => {
      throw failure;
    },
  };
  await assert.rejects(json(machine, 'settings.json'), error => error === failure);
});
