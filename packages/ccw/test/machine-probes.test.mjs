import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createMachine } from '../dist/machine.js';
import { claudeProcessActive, claudeRunning } from '../dist/model.js';

for (const [name, command, expected] of [
  ['claude.exe', 'claude --resume', true],
  ['node.exe', 'node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', true],
  ['node.exe', 'node /home/user/node_modules/@anthropic-ai/claude-code/cli.js', true],
  ['node.exe', 'node /home/user/node_modules/@openai/codex/bin/codex.js', false],
  ['node.exe', 'node unrelated.js', false],
])
  test(`识别 Claude 进程：${command}`, async () => {
    assert.equal(claudeProcessActive(name, command), expected);
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
    assert.equal(
      found.some(entry => claudeProcessActive(entry.name, entry.command)),
      expected,
    );
  });

test('只读命令超时：结束子进程', { timeout: 3_000 }, async () => {
  const result = await createMachine().execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 100,
  });
  assert.equal(result.failed, true);
  assert.notEqual(result.code, 0);
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

test('识别 npm 启动的 Claude 进程', { timeout: 20_000 }, async t => {
  const machine = createMachine();
  if ((await claudeRunning(machine)) !== false) {
    t.skip('主机已有 Claude 或进程状态未知，不能隔离此探测');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccw-process-'));
  const file = path.join(root, 'node_modules/@anthropic-ai/claude-code/cli.js');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'setInterval(() => {}, 1000); process.stdout.write("ready");');
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  t.after(async () => {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    await fs.rm(root, { recursive: true, force: true });
  });
  await once(child.stdout, 'data');
  assert.equal(await claudeRunning(machine), true);
});
