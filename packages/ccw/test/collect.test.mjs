import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createCcw } from '../dist/ccw.js';
import { collectLogs, foldText, redactText } from '../dist/collect.js';
import { createEnv, ok } from './env.mjs';

const collectOptions = (f, machine) => ({
  machine,
  home: f.home,
  claudeRoot: f.claudeRoot,
  cclineRoot: f.cclineRoot,
  platform: process.platform,
});

test('收集诊断日志：折叠路径并落盘本地报告', async t => {
  const f = await createEnv(t, { layout: 'home' });
  const machine = f.machine({
    processes: async () => [],
    npm: async () => ok('{}'),
    execute: async (file, args) => {
      if (file === 'git' && args[0] === 'ls-remote') return ok(`${'0'.repeat(40)}\tHEAD\n`);
      throw new Error(`unexpected command: ${file}`);
    },
  });
  const options = collectOptions(f, machine);
  const collected = await collectLogs(createCcw(options), options);
  assert.ok(collected.file.startsWith(path.join(f.home, '.ccw', 'logs')));
  assert.ok(collected.summary.includes('完整报告'));
  const report = await fs.readFile(collected.file, 'utf8');
  assert.ok(report.includes('# CCW 诊断报告'));
  assert.ok(report.includes('## 检查结果（完整明细）'));
  assert.ok(!report.includes(f.home), '主目录路径必须折叠');
  assert.ok(!report.includes(f.claudeRoot), '配置根路径必须折叠');
  assert.ok(report.includes('## 隐私声明'));
});

test('收集诊断日志：同秒重复收集换名不覆盖', async t => {
  const f = await createEnv(t, { layout: 'home' });
  const machine = f.machine({
    processes: async () => [],
    npm: async () => ok('{}'),
  });
  const options = collectOptions(f, machine);
  const ccw = createCcw(options);
  const first = await collectLogs(ccw, options);
  const second = await collectLogs(ccw, options);
  assert.notEqual(first.file, second.file);
  assert.ok(await fs.stat(first.file));
  assert.ok(await fs.stat(second.file));
});

test('收集诊断日志：包含最近一次执行', async t => {
  const f = await createEnv(t, { layout: 'home' });
  const machine = f.machine({
    processes: async () => [],
    npm: async () => ok('{}'),
  });
  const options = collectOptions(f, machine);
  const ccw = createCcw(options);
  await f.write(path.join(f.claudeRoot, 'skills/manual/SKILL.md'), '---\nname: manual\n---\n');
  const plan = await ccw.plan({ task: 'uninstall', selected: [{ id: 'skill:manual' }] });
  assert.equal((await ccw.apply(plan.id)).state, 'done');
  const collected = await collectLogs(ccw, options);
  const report = await fs.readFile(collected.file, 'utf8');
  assert.match(report, /## 最近一次执行/);
  assert.match(report, /状态：done/);
  assert.match(report, /- manual：done/);
  assert.match(collected.summary, /最近执行：done/);
});

test('收集诊断日志：执行记录不可读时保留未知', async t => {
  const f = await createEnv(t, { layout: 'home' });
  const machine = f.machine({
    processes: async () => [],
    npm: async () => ok('{}'),
  });
  await f.write(path.join(f.home, '.ccw/last-run.json'), '{broken json');
  const options = collectOptions(f, machine);
  const collected = await collectLogs(createCcw(options), options);
  const report = await fs.readFile(collected.file, 'utf8');
  assert.match(report, /最近执行状态未知：记录不可读/);
  assert.doesNotMatch(report, /无执行历史/);
  assert.doesNotMatch(collected.summary, /最近执行/);
});

test('路径折叠：边界与双斜杠形态', () => {
  const home = ['C:', 'Users', 'admin'].join('\\');
  const claudeRoot = [home, '.claude'].join('\\');
  const ctx = { home, claudeRoot };
  assert.equal(foldText(ctx, [claudeRoot, 'skills', 'tdd', 'SKILL.md'].join('\\')), `<claude>\\skills\\tdd\\SKILL.md`);
  assert.equal(foldText(ctx, 'C:/Users/admin/.claude/skills/tdd'), '<claude>/skills/tdd');
  assert.equal(foldText(ctx, [home, 'other', 'file'].join('\\')), `~\\other\\file`);
  assert.equal(foldText(ctx, 'C:\\Users\\administratorX\\file'), 'C:\\Users\\administratorX\\file');
  assert.equal(foldText(ctx, home), '~');
  assert.equal(foldText(ctx, 'D:\\elsewhere'), 'D:\\elsewhere');
});

test('凭据打码：常见令牌形态', () => {
  assert.equal(redactText('Authorization: Bearer sk-ant-abcdef123456'), 'Authorization: Bearer <redacted>');
  assert.equal(redactText('token sk-ant-abcdEEEEEEEEEE'), 'token sk-ant-abcd…<redacted>');
  assert.equal(redactText('ghp_abcdef1234567890'), 'ghp_abcd…<redacted>');
  assert.equal(redactText('key sk-abcdefgh12345678'), 'key sk-abcd…<redacted>');
  assert.equal(redactText('普通文本 example.com/path'), '普通文本 example.com/path');
});
