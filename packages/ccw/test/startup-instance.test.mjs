import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const main = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const STARTUP_TIMEOUT_MS = 5_000;
const SCENARIO_TIMEOUT_MS = 15_000;

function temporaryRoot(testContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-startup-'));
  testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function startCli(testContext, home, args = [], endpoint) {
  // 隔离系统用户并通过管道提供终端输入，保留真实 CLI 与终端流程
  const script = `
    import os from 'node:os';
    import net from 'node:net';
    import { syncBuiltinESMExports } from 'node:module';
    const user = os.userInfo();
    os.userInfo = () => ({...user, username: user.username + '-ccw-startup-${process.pid}'});
    const endpoint = ${JSON.stringify(endpoint ?? null)};
    if (endpoint !== null) {
      const listen = net.Server.prototype.listen;
      net.Server.prototype.listen = function(options, ...rest) {
        return listen.call(this, {...options, port: endpoint}, ...rest);
      };
      const connect = net.createConnection;
      net.createConnection = options => connect({...options, port: endpoint});
      syncBuiltinESMExports();
    }
    Object.defineProperty(process.stdin, 'isTTY', {value: true});
    Object.defineProperties(process.stdout, {
      isTTY: {value: true}, columns: {value: 120}, rows: {value: 30},
    });
    process.stdin.setRawMode = enabled => {
      process.stdin.isRaw = enabled;
      process.stderr.write('RAW_MODE=' + enabled + '\\n');
      return process.stdin;
    };
    process.argv = [process.execPath, ${JSON.stringify(main)}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(new URL('../dist/main.js', import.meta.url).href)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.dirname(main),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CCLINE_HOME: path.join(home, '.claude/ccline'),
      LOCALAPPDATA: path.join(home, 'AppData'),
      PATH: '',
    },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', chunk => {
    stderr += chunk;
  });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  testContext.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  return {
    child,
    closed,
    ready: async () => {
      if (stdout.includes('退出程序')) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error(`CLI did not become ready: ${stdout}\n${stderr}`)),
          STARTUP_TIMEOUT_MS,
        );
        const check = () => {
          if (stdout.includes('退出程序')) finish();
        };
        const exited = () => finish(new Error(`CLI exited before ready: ${stdout}\n${stderr}`));
        function finish(error) {
          clearTimeout(timer);
          child.stdout.off('data', check);
          child.off('close', exited);
          if (error) reject(error);
          else resolve();
        }
        child.stdout.on('data', check);
        child.on('close', exited);
      });
    },
  };
}

// 只读入口与启动释放
test('已有实例运行时帮助和版本仍不接触用户环境', { timeout: SCENARIO_TIMEOUT_MS }, async testContext => {
  const root = temporaryRoot(testContext);
  const first = startCli(testContext, root);
  await first.ready();
  for (const mode of ['--help', '--version']) {
    const result = await startCli(testContext, root, [mode]).closed;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.length > 0);
    assert.deepEqual(fs.readdirSync(root), []);
  }
});

test('正常关闭 CLI 后当前用户可以重新启动', { timeout: SCENARIO_TIMEOUT_MS }, async testContext => {
  const root = temporaryRoot(testContext);
  const first = startCli(testContext, root);
  await first.ready();
  first.child.stdin.write('\u001b');
  const result = await first.closed;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /RAW_MODE=false/);
  await startCli(testContext, root).ready();
});

test('强制终止 CLI 后当前用户可以接管启动', { timeout: SCENARIO_TIMEOUT_MS }, async testContext => {
  const root = temporaryRoot(testContext);
  const first = startCli(testContext, root);
  await first.ready();
  first.child.kill('SIGKILL');
  assert.equal((await first.closed).signal, 'SIGKILL');
  await startCli(testContext, root).ready();
});

// 并发实例与端点冲突
test('同一用户的第二个 CLI 在初始化终端或配置前拒绝启动', { timeout: SCENARIO_TIMEOUT_MS }, async testContext => {
  const root = temporaryRoot(testContext);
  const first = startCli(testContext, root);
  await first.ready();
  const second = startCli(testContext, root);
  const result = await Promise.race([
    second.closed,
    second.ready().then(() => ({ code: null, stdout: 'interactive terminal opened', stderr: '' })),
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'CCW 启动失败：CCW 已在运行\n');
  assert.deepEqual(fs.readdirSync(root), []);
});

test('更换用户目录与 Claude 配置根不能绕过实例限制', { timeout: SCENARIO_TIMEOUT_MS }, async testContext => {
  const root = temporaryRoot(testContext);
  const first = startCli(testContext, root);
  await first.ready();
  const otherHome = path.join(root, 'other');
  fs.mkdirSync(otherHome);
  const result = await startCli(testContext, otherHome, ['--inspect', '--details']).closed;
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^CCW 启动失败：CCW 已在运行\n/);
  assert.match(result.stderr, /代码：instance-already-running/);
  assert.doesNotMatch(result.stderr, /RAW_MODE/);
  assert.deepEqual(fs.readdirSync(otherHome), []);
});

test('启动端点被无关程序占用时安全拒绝且不误报已有 CCW', { timeout: SCENARIO_TIMEOUT_MS }, async testContext => {
  const root = temporaryRoot(testContext);
  const unrelated = createServer(socket => socket.end('unrelated service\n'));
  testContext.after(() => unrelated.close());
  await new Promise(resolve => unrelated.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const address = unrelated.address();
  assert.ok(address && typeof address === 'object');
  // 重定向网络调用至已占用端口，保留真实启动与独占绑定检查
  const result = await startCli(testContext, root, ['--details'], address.port).closed;
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^CCW 启动失败：无法取得启动资格\n/);
  assert.match(result.stderr, /代码：instance-lock-unavailable/);
  assert.doesNotMatch(result.stderr, /CCW 已在运行|RAW_MODE/);
  assert.deepEqual(fs.readdirSync(root), []);
});
