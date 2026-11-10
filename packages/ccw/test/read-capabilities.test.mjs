import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createReadMachine } from '../dist/read-machine.js';
import { createEffectMachine, createEffectScope } from '../dist/effect-machine.js';

test('读取能力：不暴露受管写方法', () => {
  const machine = {
    read: async () => null,
    initialize: async () => true,
    editJson: async () => {},
    remove: async () => {},
    removeTree: async () => {},
    removeEmptyDirectory: async () => true,
    replaceFile: async () => {},
    replaceTree: async () => {},
    ensureUserPath: async () => {},
  };
  const reading = createReadMachine(machine, () => undefined);
  for (const method of [
    'initialize',
    'editJson',
    'remove',
    'removeTree',
    'removeEmptyDirectory',
    'replaceFile',
    'replaceTree',
    'ensureUserPath',
  ])
    assert.equal(method in reading, false, method);
});

test('读取能力：变更命令与未知命令在派发前拒绝', async () => {
  const calls = [];
  const reading = createReadMachine(
    {
      npm: async args => {
        calls.push(args);
        return { code: 0, stdout: '', failed: false };
      },
      execute: async (file, args) => {
        calls.push([file, ...args]);
        return { code: 0, stdout: '', failed: false };
      },
    },
    () => undefined,
  );
  await assert.rejects(reading.npm(['install', '-g', 'anything']), /read-command-not-allowed/);
  for (const args of [
    ['config', 'list'],
    ['config', 'get', '//registry.example.test/:_authToken'],
    ['config', 'get', 'registry', '_authToken'],
    ['config', 'set', 'registry', 'https://registry.example.test'],
  ])
    await assert.rejects(reading.npm(args), /read-command-not-allowed/);
  await assert.rejects(
    reading.execute('powershell.exe', ['-Command', 'Remove-Item anything']),
    /read-command-not-allowed/,
  );
  await assert.rejects(reading.execute('git', ['checkout', 'HEAD']), /read-command-not-allowed/);
  await assert.rejects(reading.execute('rm', ['tool', 'list']), /read-command-not-allowed/);
  await assert.rejects(reading.execute('unrecognized-script', ['--version']), /read-command-not-allowed/);
  await assert.rejects(
    reading.execute(process.execPath, ['arbitrary-script.js', '--help']),
    /read-command-not-allowed/,
  );
  assert.deepEqual(calls, []);
});

test('读取能力：实际查询与暂存来源仍可用', async () => {
  const calls = [];
  const reading = createReadMachine(
    {
      npm: async args => {
        calls.push(args);
        return { code: 0, stdout: '{}', failed: false };
      },
      execute: async (file, args) => {
        calls.push([file, ...args]);
        return { code: 0, stdout: '', failed: false };
      },
      source: async () => [{ path: 'SKILL.md', data: Buffer.from('skill') }],
    },
    () => undefined,
  );
  await reading.npm(['view', '@officecli/officecli@latest', 'version', '--json']);
  await reading.npm(['config', 'get', 'registry']);
  await reading.npm(['config', 'get', '@officecli:registry']);
  await reading.execute('git', ['ls-remote', 'https://github.com/example/skills', 'HEAD']);
  assert.equal(
    (await reading.source('https://github.com/example/skills', 'a'.repeat(40), 'skills'))[0].path,
    'SKILL.md',
  );
  assert.equal(calls.length, 4);
});

test('效果能力：每次派发复核执行资格，捕获方法不能带走许可', async () => {
  let allowed = false;
  const writes = [];
  const effects = createEffectMachine(
    {
      removeTree: async (...args) => writes.push(args),
    },
    () => allowed,
  );
  const captured = effects.removeTree;
  await assert.rejects(async () => captured('target', 'stamp'), /effect-not-authorized/);
  assert.deepEqual(writes, []);
  allowed = true;
  await captured('target', 'stamp');
  assert.deepEqual(writes, [['target', 'stamp', undefined]]);
  allowed = false;
  await assert.rejects(async () => captured('target', 'stamp'), /effect-not-authorized/);
  assert.equal(writes.length, 1);
});

test('效果作用域：旧调用链与无作用域任务不能借用新 apply 的许可', async () => {
  const writes = [];
  const scope = createEffectScope(
    {
      removeTree: async file => writes.push(file),
    },
    () => true,
  );
  const releaseOld = Promise.withResolvers();
  let oldTask;
  await scope.run(async () => {
    oldTask = releaseOld.promise.then(async () => {
      await assert.rejects(async () => scope.machine.removeTree('old', 'stamp'), /effect-not-authorized/);
    });
    await scope.machine.removeTree('first', 'stamp');
  });
  const releaseNew = Promise.withResolvers();
  const newStarted = Promise.withResolvers();
  const running = scope.run(async () => {
    newStarted.resolve();
    await releaseNew.promise;
    await scope.machine.removeTree('second', 'stamp');
  });
  await newStarted.promise;
  await assert.rejects(async () => scope.machine.removeTree('unscoped', 'stamp'), /effect-not-authorized/);
  releaseOld.resolve();
  await oldTask;
  releaseNew.resolve();
  await running;
  assert.deepEqual(writes, ['first', 'second']);
});
