import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createMachine } from '../dist/machine.js';
import { claudeRunning } from '../dist/claude-program.js';
import { createReadMachine } from '../dist/read-machine.js';

// 进程识别与查询
for (const [name, command, expected] of [
  ['claude.exe', 'claude --resume', true],
  ['node.exe', 'node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', true],
  ['node.exe', 'node /home/user/node_modules/@anthropic-ai/claude-code/cli.js', true],
  ['node.exe', 'node /home/user/node_modules/@openai/codex/bin/codex.js', false],
  ['node.exe', 'node unrelated.js', false],
])
  test(`识别 Claude 进程：${command}`, async () => {
    const machine = {
      ...createMachine(),
      async execute(_binary, _args, options) {
        assert.equal(options.timeoutMs, 5_000);
        return {
          code: 0,
          failed: false,
          stdout:
            process.platform === 'win32'
              ? JSON.stringify([{ Name: name, CommandLine: command }])
              : `${name.replace('.exe', '')} ${command}`,
        };
      },
    };
    const found = await machine.processes();
    assert.deepEqual(found, [
      process.platform === 'win32' ? { name, command } : { name: name.replace('.exe', ''), command },
    ]);
    assert.equal(await claudeRunning(machine), expected);
  });

test('识别 npm 启动的 Claude 进程', { timeout: 20_000 }, async testContext => {
  const machine = createMachine();
  if ((await claudeRunning(machine)) !== false) {
    testContext.skip('主机已有 Claude 或进程状态未知，不能隔离此探测');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccw-process-'));
  const file = path.join(root, 'node_modules/@anthropic-ai/claude-code/cli.js');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'setInterval(() => {}, 1000); process.stdout.write("ready");');
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  testContext.after(async () => {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    await fs.rm(root, { recursive: true, force: true });
  });
  await once(child.stdout, 'data');
  assert.equal(await claudeRunning(machine), true);
});

// 查询信号与预算
test('Claude 运行检查：传递枚举取消选项', async () => {
  const controller = new AbortController();
  let options;
  assert.equal(
    await claudeRunning(
      {
        processes: async value => {
          options = value;
          return [];
        },
      },
      controller.signal,
    ),
    false,
  );
  assert.deepEqual(options, { signal: controller.signal });
});

for (const method of ['processes', 'userPathContains'])
  test(
    '系统查询：剩余预算与取消信号传给实际命令：' + method,
    {
      skip: method === 'userPathContains' && process.platform !== 'win32',
    },
    async () => {
      const directory = path.join(os.tmpdir(), 'ccw-path-probe');
      const caller = new AbortController();
      const scope = new AbortController();
      const deadlineMs = performance.now() + 1_000;
      const calls = [];
      const command = Promise.withResolvers();
      const machine = {
        ...createMachine({ HOME: os.tmpdir(), USERPROFILE: os.tmpdir(), PATH: '' }),
        async execute(file, args, options) {
          calls.push({ file, args, options });
          await command.promise;
          return { code: 0, failed: false, stdout: method === 'processes' ? '[]' : 'true' };
        },
      };
      const reading = createReadMachine(machine, () => ({ deadlineMs, signal: scope.signal }));
      const options = { timeoutMs: 2_000, signal: caller.signal };
      const pending =
        method === 'processes' ? reading.processes(options) : reading.userPathContains(directory, options);
      assert.equal(calls.length, 1);
      const call = calls[0];
      assert.equal(call.file, process.platform === 'win32' ? 'powershell.exe' : 'ps');
      assert.ok(call.options.timeoutMs > 0 && call.options.timeoutMs <= 1_000);
      assert.equal(call.options.signal.aborted, false);
      if (method === 'userPathContains') assert.deepEqual(call.options.env, { CCW_PATH_ENTRY: directory });
      const rejected = assert.rejects(pending, /cancelled/);
      caller.abort();
      assert.equal(call.options.signal.aborted, true);
      command.resolve();
      await rejected;
    },
  );

// 超时与取消后的子进程回收
test('只读命令超时：结束子进程', { timeout: 3_000 }, async () => {
  const result = await createMachine().execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 100,
  });
  assert.equal(result.failed, true);
  assert.notEqual(result.code, 0);
});

test('交互命令超时：强制终止拒绝退出', () => {
  const childSource = `
    import { EventEmitter } from 'node:events';
    export function spawn(_file, _args, options) {
      if (options.stdio !== 'inherit') throw new Error('expected-interactive-command');
      const child = new EventEmitter(); child.pid = 42;
      child.kill = (signal = 'SIGTERM') => {
        globalThis.commandSignals.push(signal);
        if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null));
        return true;
      };
      globalThis.commandChild = child;
      return child;
    }
  `;
  const script = `
    import { registerHooks } from 'node:module';
    const childModule = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(childSource)}`)};
    registerHooks({ resolve(specifier, context, nextResolve) { return specifier === 'node:child_process' ? { url: childModule, shortCircuit: true } : nextResolve(specifier, context); } });
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.kill = () => { throw new Error('unexpected-process-group'); };
    globalThis.commandSignals = [];
    const { createMachine } = await import(${JSON.stringify(new URL('../dist/machine.js', import.meta.url).href)});
    const watchdog = setTimeout(() => globalThis.commandChild.emit('close', null), 700);
    try {
      const result = await createMachine({}).execute('interactive-tool', [], { isInteractive: true, timeoutMs: 10 });
      process.stdout.write(JSON.stringify({ result, signals: globalThis.commandSignals }));
    } finally { clearTimeout(watchdog); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const payload = JSON.parse(child.stdout);
  assert.equal(payload.result.failed, true);
  assert.deepEqual(payload.signals, ['SIGTERM', 'SIGKILL']);
});

test('取消只读命令：释放子进程', { timeout: 3_000 }, async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const result = await createMachine().execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      signal: controller.signal,
    });
    assert.equal(result.failed, true);
    assert.notEqual(result.code, 0);
  } finally {
    clearTimeout(timer);
  }
});
