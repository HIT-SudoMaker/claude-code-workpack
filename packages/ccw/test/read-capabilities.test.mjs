import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createReadMachine } from '../dist/read-machine.js';
import { createEffectMachine, createEffectScope } from '../dist/effect-machine.js';

function commandFixture() {
  const calls = [];
  const record = async args => {
    calls.push(args);
    return { code: 0, stdout: '{}', failed: false };
  };
  const reading = createReadMachine(
    {
      npm: record,
      execute: (file, args) => record([file, ...args]),
      source: async () => [{ path: 'SKILL.md', data: Buffer.from('skill') }],
    },
    () => undefined,
  );
  return { reading, calls };
}

function pendingCall(result) {
  const gate = Promise.withResolvers();
  let argument;
  return {
    async invoke(...args) {
      argument = args.at(-1);
      await gate.promise;
      return result;
    },
    get argument() {
      return argument;
    },
    release: gate.resolve,
  };
}

// 查询与共享读取
test('读取能力：实际查询与暂存来源仍可用', async () => {
  const { reading, calls } = commandFixture();
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

test('共享读取复用查询并隔离返回值与底层失败', async () => {
  const release = Promise.withResolvers();
  let entriesCalls = 0;
  let readCalls = 0;
  const reading = createReadMachine(
    {
      entries: async () => {
        entriesCalls++;
        await release.promise;
        return [{ name: 'file', kind: 'file', sizeBytes: 1n }];
      },
      read: async () => {
        readCalls++;
        throw new Error('read-failed');
      },
    },
    () => undefined,
    { shouldShareReads: true },
  );
  const first = reading.entries('target');
  const second = reading.entries('target');
  assert.equal(entriesCalls, 1);
  release.resolve();
  const [left, right] = await Promise.all([first, second]);
  left[0].name = 'changed';
  assert.equal(right[0].name, 'file');
  assert.equal((await reading.entries('target'))[0].name, 'file');
  assert.equal(entriesCalls, 1);
  await assert.rejects(reading.read('target'), /read-failed/);
  await assert.rejects(reading.read('target'), /read-failed/);
  assert.equal(readCalls, 1);
});

// 读写能力与作用域边界
test('读取能力：不暴露受管写方法', () => {
  const machine = {
    read: async () => null,
    initialize: async () => true,
    editJson: async () => {},
    removeTree: async () => {},
    replaceFile: async () => {},
    replaceTree: async () => {},
    ensureUserPath: async () => {},
  };
  const reading = createReadMachine(machine, () => undefined);
  for (const method of ['initialize', 'editJson', 'removeTree', 'replaceFile', 'replaceTree', 'ensureUserPath'])
    assert.equal(method in reading, false, method);
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

test('读取能力：变更命令与未知命令在派发前拒绝', async () => {
  const { reading, calls } = commandFixture();
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
  await assert.rejects(reading.execute('claude', ['plugin', 'uninstall', '--help']), /read-command-not-allowed/);
  await assert.rejects(reading.execute('rm', ['tool', 'list']), /read-command-not-allowed/);
  await assert.rejects(reading.execute('unrecognized-script', ['--version']), /read-command-not-allowed/);
  await assert.rejects(
    reading.execute(process.execPath, ['arbitrary-script.js', '--help']),
    /read-command-not-allowed/,
  );
  assert.deepEqual(calls, []);
});

test('效果作用域：旧调用链与无作用域任务不能借用新 apply 的许可', async () => {
  const writes = [];
  const scope = createEffectScope({ removeTree: async file => writes.push(file) });
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
  await assert.rejects(
    scope.run(async () => scope.machine.removeTree('concurrent', 'stamp')),
    /operation-in-progress/,
  );
  await assert.rejects(async () => scope.machine.removeTree('unscoped', 'stamp'), /effect-not-authorized/);
  releaseOld.resolve();
  await oldTask;
  releaseNew.resolve();
  await running;
  assert.deepEqual(writes, ['first', 'second']);
});

// 失败、时限与取消
test('效果作用域：失败后撤销许可并允许下一次运行', async () => {
  const writes = [];
  const scope = createEffectScope({ removeTree: async file => writes.push(file) });
  await assert.rejects(
    scope.run(async () => {
      await scope.machine.removeTree('first', 'stamp');
      throw new Error('write-failed');
    }),
    /write-failed/,
  );
  await assert.rejects(async () => scope.machine.removeTree('unscoped', 'stamp'), /effect-not-authorized/);
  await scope.run(async () => scope.machine.removeTree('second', 'stamp'));
  assert.deepEqual(writes, ['first', 'second']);
});

for (const [method, args] of [
  ['processes', []],
  ['userPathContains', ['target']],
]) {
  test('系统查询：共享时限耗尽后不派发：' + method, async () => {
    let calls = 0;
    const reading = createReadMachine({ [method]: async () => calls++ }, () => ({ deadlineMs: performance.now() - 1 }));
    await assert.rejects(reading[method](...args), /inspection-timeout/);
    assert.equal(calls, 0);
  });

  test('系统查询：使用剩余预算并拒绝迟到结果：' + method, async () => {
    const call = pendingCall();
    const scope = { deadlineMs: performance.now() + 1_000 };
    const reading = createReadMachine({ [method]: call.invoke }, () => scope);
    const pending = reading[method](...args, { timeoutMs: 2_000 });
    assert.ok(call.argument.timeoutMs > 0 && call.argument.timeoutMs <= 1_000);
    const rejected = assert.rejects(pending, /inspection-timeout/);
    scope.deadlineMs = performance.now() - 1;
    call.release();
    await rejected;
  });
}

for (const [method, args] of [
  ['processes', []],
  ['userPathContains', ['target']],
  ['npm', [['root', '-g']]],
  ['execute', ['claude', ['--version']]],
  ['fetchText', ['https://example.test/metadata']],
  ['fetchBytes', ['https://example.test/asset']],
  ['source', ['https://github.com/example/skills', 'a'.repeat(40), 'skills']],
])
  test('命令读取：取消在派发前和返回前生效：' + method, async () => {
    const caller = new AbortController();
    caller.abort();
    let calls = 0;
    let reports = 0;
    const reading = createReadMachine({ [method]: async () => calls++ }, () => ({ report: () => reports++ }));
    await assert.rejects(reading[method](...args, { signal: caller.signal }), /cancelled/);
    assert.equal(calls, 0);
    assert.equal(reports, 0);

    for (const from of ['caller', 'scope']) {
      const caller = new AbortController();
      const scope = new AbortController();
      const call = pendingCall();
      const reading = createReadMachine({ [method]: call.invoke }, () => ({ signal: scope.signal }));
      const pending = reading[method](...args, { signal: caller.signal });
      const rejected = assert.rejects(pending, /cancelled/);
      (from === 'caller' ? caller : scope).abort();
      assert.equal(call.argument.signal.aborted, true);
      call.release();
      await rejected;
    }

    const options = { timeoutMs: 1234, signal: new AbortController().signal };
    let received;
    const unscoped = createReadMachine(
      {
        [method]: async (...args) => {
          received = args.at(-1);
        },
      },
      () => undefined,
    );
    await unscoped[method](...args, options);
    assert.equal(received, options);
  });

for (const method of ['fingerprint', 'treeStamp'])
  test('读取能力同时尊重调用方和作用域取消：' + method, async () => {
    const invoke = (reading, signal) => reading[method]('target', signal);
    const active = new AbortController();
    const cancelled = new AbortController();
    cancelled.abort();
    let calls = 0;
    const reading = createReadMachine(
      {
        [method]: async () => {
          calls++;
          return null;
        },
      },
      () => ({ signal: active.signal }),
    );
    await assert.rejects(invoke(reading, cancelled.signal), /cancelled/);
    assert.equal(calls, 0);
    for (const from of ['caller', 'scope']) {
      const caller = new AbortController();
      const scope = new AbortController();
      const call = pendingCall(null);
      const pendingRead = createReadMachine({ [method]: call.invoke }, () => ({ signal: scope.signal }));
      const pending = invoke(pendingRead, caller.signal);
      const rejected = assert.rejects(pending, /cancelled/);
      (from === 'caller' ? caller : scope).abort();
      const propagated = call.argument.aborted;
      call.release();
      await rejected;
      assert.equal(propagated, true);
      assert.equal((from === 'caller' ? scope : caller).signal.aborted, false);
    }
  });

for (const [method, expected] of [
  ['read', 'cached text'],
  ['entries', [{ name: 'file', kind: 'file', sizeBytes: 1n }]],
  ['realpath', '/resolved/target'],
  ['locate', ['/bin/target']],
])
  test('共享读取取消后不交付缓存：' + method, async () => {
    for (const timing of ['before', 'during']) {
      const abort = new AbortController();
      let calls = 0;
      const reading = createReadMachine(
        {
          [method]: async () => {
            calls++;
            return expected;
          },
        },
        () => ({ signal: abort.signal }),
        { shouldShareReads: true },
      );
      assert.deepEqual(await reading[method]('target'), expected);
      assert.deepEqual(await reading[method]('target'), expected);
      assert.equal(calls, 1);
      if (timing === 'before') abort.abort();
      const cached = reading[method]('target');
      const rejected = assert.rejects(cached, /cancelled/);
      if (timing === 'during') abort.abort();
      await rejected;
      assert.equal(calls, 1);
    }
  });

test('效果作用域取消后拒绝同一操作中的后续写入', async () => {
  const writes = [];
  const scope = createEffectScope({ removeTree: async file => writes.push(file) });
  const abort = new AbortController();
  await scope.run(async () => {
    await scope.machine.removeTree('first', 'stamp');
    abort.abort();
    await assert.rejects(async () => scope.machine.removeTree('second', 'stamp'), /cancelled/);
  }, abort.signal);
  assert.deepEqual(writes, ['first']);
});

test('Skills 发现能力只允许固定版本的 list，部署必须经效果能力', async () => {
  const { reading } = commandFixture();
  const prefix = [
    'exec',
    '--yes',
    '--package=skills@1.8.1',
    '--',
    'skills',
    'a',
    'https://github.com/example/skills/tree/' + 'a'.repeat(40) + '/skills',
  ];
  await assert.doesNotReject(reading.npm([...prefix, '--list']));
  await assert.rejects(reading.npm([...prefix, '--yes', '--copy']), /read-command-not-allowed/);
  await assert.rejects(
    reading.npm([...prefix.slice(0, 2), '--package=skills@latest', ...prefix.slice(3), '--list']),
    /read-command-not-allowed/,
  );
});
