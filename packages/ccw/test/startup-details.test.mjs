import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startupFailure } from '../dist/render.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const main = fileURLToPath(new URL('../dist/main.js', import.meta.url));
// 隔离测试用户，避免并行测试争用启动锁；配置环境变量仍使用真实值
const userFixture = `data:text/javascript,${encodeURIComponent(`
  import os from 'node:os';
  const user = os.userInfo();
  os.userInfo = () => ({ ...user, username: user.username + '-ccw-details-${process.pid}' });
`)}`;
const run = (args, env = {}) =>
  spawnSync(process.execPath, ['--import', userFixture, main, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    env: { ...process.env, ...env },
  });

// 帮助与版本的正常输出
for (const mode of ['--help', '--version'])
  for (const args of [
    [mode, '--details'],
    ['--details', mode],
  ])
    test(`保留正常输出：${args.join(' ')}`, () => {
      const result = run(args, { CLAUDE_CONFIG_DIR: path.parse(process.cwd()).root });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      if (mode === '--version') assert.equal(result.stdout, `${version}\n`);
      else assert.match(result.stdout, /--details：显示诊断代码与检查明细/);
      assert.doesNotMatch(result.stdout, /代码：/);
    });

// 无效参数与启动失败
for (const args of [
  ['--bad'],
  ['--detials'],
  ['--details=value'],
  ['--help', '--bad'],
  ['--version', 'secret-argument'],
  ['--help', '--version'],
  ['--inspect', '--inspect'],
  ['--collect-logs', '--inspect'],
  ['--'],
])
  test(`拒绝无效参数：${args.join(' ')}`, () => {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'CCW 启动失败：参数无效\n');
  });

for (const args of [
  ['--details', '--bad=secret-argument'],
  ['--help', '--details', '--bad=secret-argument'],
  ['--details', '--details'],
])
  test(`主动显示参数说明：${args.join(' ')}`, () => {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^CCW 启动失败：参数无效\n/);
    assert.match(result.stderr, /代码：unknown-argument/);
    assert.equal(result.stderr, 'CCW 启动失败：参数无效\n代码：unknown-argument\n');
    assert.doesNotMatch(result.stderr, /secret-argument|Error:|at main|process\.env/);
  });

test('保留交互终端失败退出码', () => {
  const ordinary = run([]);
  const explicit = run(['--details']);
  assert.equal(ordinary.status, 1);
  assert.equal(explicit.status, 1);
  assert.equal(ordinary.stderr, 'CCW 启动失败：需要交互终端\n');
  assert.match(explicit.stderr, /^CCW 启动失败：需要交互终端\n/);
  assert.match(explicit.stderr, /代码：interactive-terminal-required/);
});

test('按需显示检查模式的启动异常', () => {
  const env = { CLAUDE_CONFIG_DIR: path.parse(process.cwd()).root };
  const ordinary = run(['--inspect'], env);
  const explicit = run(['--inspect', '--details'], env);
  assert.equal(ordinary.status, 1);
  assert.equal(explicit.status, 1);
  assert.equal(ordinary.stderr, 'CCW 启动失败：配置目录无效\n');
  assert.equal(ordinary.stdout, '');
  assert.match(explicit.stderr, /^CCW 启动失败：配置目录无效\n/);
  assert.match(explicit.stderr, /代码：invalid-config-root/);
});

test('隐藏异常的原始内容', () => {
  assert.equal(startupFailure('unmapped-startup', false), 'CCW 启动失败：原因未知');
  assert.equal(
    startupFailure('secret\nAuthorization: private-value', true),
    'CCW 启动失败：原因未知\n代码：operation-failed',
  );
});
