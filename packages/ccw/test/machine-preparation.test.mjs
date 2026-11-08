import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import { createMachine } from '../dist/machine.js';

const repository = 'https://github.com/fixture/skills';
const revision = 'a'.repeat(40);
const sourceEnvironment = {
  ...process.env,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'protocol.https.allow',
  GIT_CONFIG_VALUE_0: 'never',
};

async function within(promise, timeoutMs, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function response(body = 'payload', url = 'https://example.invalid/asset', headers) {
  const value = new Response(body, { headers });
  Object.defineProperty(value, 'url', { value: url });
  return value;
}

for (const method of ['fetchText', 'fetchBytes'])
  test(`${method}：跳过已取消请求`, async t => {
    const original = globalThis.fetch;
    let calls = 0;
    t.after(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = async () => {
      calls++;
      return response();
    };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      createMachine()[method]('https://example.invalid/asset', { signal: controller.signal }),
      /^Error: cancelled$/,
    );
    assert.equal(calls, 0);
  });

for (const method of ['fetchText', 'fetchBytes'])
  test(`${method}：丢弃取消后响应`, async t => {
    const original = globalThis.fetch;
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let discarded = false;
    t.after(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = async () => {
      entered.resolve();
      await release.promise;
      return response(
        new ReadableStream({
          cancel() {
            discarded = true;
          },
        }),
      );
    };
    const controller = new AbortController();
    const reading = createMachine()[method]('https://example.invalid/asset', { signal: controller.signal });
    await entered.promise;
    controller.abort();
    release.resolve();
    await assert.rejects(reading, /^Error: cancelled$/);
    assert.equal(discarded, true);
  });

for (const method of ['fetchText', 'fetchBytes'])
  test(`${method}：限制正文读取时长`, async t => {
    const original = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = async () =>
      response(
        new ReadableStream({
          async start(controller) {
            await delay(30);
            controller.enqueue(Buffer.from('late body'));
            controller.close();
          },
        }),
      );
    await assert.rejects(
      createMachine()[method]('https://example.invalid/asset', { timeoutMs: 5 }),
      /^Error: source-timeout$/,
    );
  });

test('下载文本：拒绝不安全重定向', async t => {
  const original = globalThis.fetch;
  let cancelled = false;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      'http://example.invalid/unsafe',
    );
  await assert.rejects(createMachine().fetchText('https://example.invalid/asset'), /invalid-source-url/);
  assert.equal(cancelled, true);
});

test('下载文本：拒绝超大正文', async t => {
  const original = globalThis.fetch;
  let cancelled = false;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      undefined,
      { 'content-length': `${9 * 1024 * 1024}` },
    );
  await assert.rejects(createMachine().fetchText('https://example.invalid/asset'), /source-too-large/);
  assert.equal(cancelled, true);
});

test('取消技能获取：跳过 Git', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createMachine(sourceEnvironment).source(repository, revision, 'skills', { signal: controller.signal }),
    /^Error: cancelled$/,
  );
});

for (const stop of ['cancel', 'timeout'])
  test(`获取技能（${stop === 'cancel' ? '取消' : '超时'}）：清理临时目录`, async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers();
    const calls = [];
    let temporary;
    const machine = {
      ...createMachine(sourceEnvironment),
      async execute(_binary, args, options) {
        temporary = options.cwd;
        calls.push({ args, options });
        if (args.includes('fetch')) {
          entered.resolve();
          await new Promise(resolve => {
            if (options.signal.aborted) resolve();
            else options.signal.addEventListener('abort', resolve, { once: true });
          });
          return { code: null, failed: true, stdout: '' };
        }
        return { code: 0, failed: false, stdout: '' };
      },
    };
    const reading = machine.source(repository, revision, 'skills', {
      signal: controller.signal,
      timeoutMs: stop === 'timeout' ? 500 : 2_000,
    });
    const outcome = reading.then(
      () => 'success',
      error => error.message,
    );
    if (stop === 'cancel') {
      const started = await within(
        entered.promise.then(() => true),
        1_000,
        false,
      );
      controller.abort();
      assert.equal(started, true);
    }
    assert.equal(await outcome, stop === 'cancel' ? 'cancelled' : 'source-timeout');
    assert.ok(calls.length >= 3);
    assert.ok(calls.every(call => call.options.signal === calls[0].options.signal));
    assert.ok(calls.every(call => call.options.env.GIT_TERMINAL_PROMPT === '0'));
    assert.equal(
      await fs.stat(temporary).then(
        () => true,
        () => false,
      ),
      false,
    );
  });

test('获取技能：固定提交并清理目录', async () => {
  let temporary;
  const calls = [];
  const machine = {
    ...createMachine(sourceEnvironment),
    async execute(_binary, args, options) {
      temporary = options.cwd;
      calls.push(args);
      if (args.includes('checkout')) {
        await fs.mkdir(path.join(temporary, 'skills/example'), { recursive: true });
        await fs.writeFile(path.join(temporary, 'skills/example/SKILL.md'), 'fixture skill');
      }
      return { code: 0, failed: false, stdout: '' };
    },
  };
  const files = await machine.source(repository, revision, 'skills');
  assert.deepEqual(
    files.map(file => [file.path, Buffer.from(file.data).toString()]),
    [['example/SKILL.md', 'fixture skill']],
  );
  assert.ok(calls.some(args => args.includes('fetch') && args.includes(repository) && args.includes(revision)));
  assert.equal(
    await fs.stat(temporary).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test('取消 Git 下载：终止 HTTP 子进程', { timeout: 8_000 }, async t => {
  const entered = Promise.withResolvers();
  const server = createServer(() => {
    entered.resolve();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(
    () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const environment = {
    ...process.env,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `url.http://127.0.0.1:${address.port}/skills.insteadOf`,
    GIT_CONFIG_VALUE_0: repository,
    GIT_CONFIG_KEY_1: 'protocol.http.allow',
    GIT_CONFIG_VALUE_1: 'always',
  };
  const machine = createMachine(environment);
  const execute = machine.execute;
  let temporary;
  machine.execute = async (...args) => {
    temporary = args[2].cwd;
    return execute(...args);
  };
  const controller = new AbortController();
  const reading = machine.source(repository, revision, 'skills', { signal: controller.signal });
  const outcome = reading.then(
    () => 'success',
    error => error.message,
  );
  try {
    assert.equal(
      await within(
        entered.promise.then(() => true),
        3_000,
        false,
      ),
      true,
    );
    controller.abort();
    const result = await within(outcome, 2_000, 'git-subprocess-remains');
    assert.equal(result, 'cancelled');
    assert.equal(
      await fs.stat(temporary).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    server.closeAllConnections();
    await outcome;
  }
});

test('取消命令：强制终止拒绝退出的进程', { timeout: 5_000 }, async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const kill = process.kill;
  const signals = [];
  let pid;
  // 用进程控制替身验证 POSIX 升级策略，子进程仍由当前主机启动
  Object.defineProperty(process, 'platform', { value: 'linux' });
  process.kill = (target, signal) => {
    if (target < 0) {
      pid = -target;
      signals.push(signal);
      if (signal === 'SIGTERM') return true;
      return kill(pid, signal);
    }
    return kill(target, signal);
  };
  const abort = new AbortController();
  const command = createMachine().execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: abort.signal,
  });
  try {
    abort.abort();
    assert.notEqual(await within(command, 2_000, 'still-running'), 'still-running');
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  } finally {
    process.kill = kill;
    Object.defineProperty(process, 'platform', platform);
    if (pid !== undefined) {
      try {
        kill(pid, 'SIGKILL');
      } catch (error) {
        assert.equal(error.code, 'ESRCH');
      }
    }
    await command;
  }
});
