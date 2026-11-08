import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRunPresentation, describeRun } from '../dist/run-presentation.js';

const items = [
  { id: 'claude', title: 'Claude Code', action: 'install' },
  { id: 'plugin:github', title: 'GitHub', action: 'install' },
  { id: 'mcp:context7', title: 'Context7', action: 'install' },
];
const effect = { state: 'failed', code: 'installer-unavailable' };
const claude = { id: 'claude', state: 'partial', effects: [{ state: 'done', code: 'program-file-ready' }, effect] };
const github = {
  id: 'plugin:github',
  state: 'failed',
  effects: [{ state: 'skipped', code: 'dependency-not-ready' }],
};
const context7 = { id: 'mcp:context7', state: 'done', effects: [{ state: 'done', code: 'registration-saved' }] };

test('进度投影：事件推进状态与汇总', () => {
  const presentation = createRunPresentation({ items });
  assert.deepEqual(
    presentation.progress().rows.map(row => [row.symbol, row.status]),
    [
      ['·', '等待'],
      ['·', '等待'],
      ['·', '等待'],
    ],
  );
  const running = presentation.progress({ kind: 'started', id: 'claude' });
  assert.equal(running.activeId, 'claude');
  assert.equal(running.rows[0].status, '执行中');
  assert.equal(running.summary, '处理 0/3 · 完成 0 · 失败 0 · 跳过 0');
  assert.deepEqual(presentation.progress({ kind: 'effect', id: 'claude', effect }).rows[0].details, []);
});

test('结果投影：部分完成与详情文本', () => {
  const presentation = createRunPresentation({ items });
  for (const result of [claude, github, context7]) presentation.progress({ kind: 'finished', id: result.id, result });
  const actual = { state: 'partial', remaining: 'frozen', items: [claude, github, context7] };
  const result = presentation.result(actual);
  assert.equal(result.title, '运行结果 · 部分完成');
  assert.equal(result.summary, '处理 3/3 · 完成 1 · 失败 1 · 跳过 1');
  assert.deepEqual(
    result.rows.map(row => [row.symbol, row.status, row.title]),
    [
      ['!', '部分完成', 'Claude Code'],
      ['○', '已跳过', 'GitHub'],
      ['✔', '完成', 'Context7'],
    ],
  );
  assert.ok(result.rows.every(row => row.details.length === 0));
  assert.doesNotMatch(describeRun(result), /installer-unavailable|官方来源|程序文件/);
  const details = describeRun(presentation.details(actual, 'claude'));
  assert.match(details, /本次仍有可续办任务/);
  assert.match(details, /已完成 · 写入程序文件/);
  assert.match(details, /代码：program-file-ready/);
  assert.match(details, /代码：installer-unavailable/);
  assert.match(details, /官方来源返回网页；未执行安装/);
  assert.doesNotMatch(details, /登录成功|GitHub|Context7/);
  assert.deepEqual(presentation.result(actual), result);
});

test('显示部分写入和纯失败', () => {
  const presentation = createRunPresentation(
    {
      items: [
        { id: 'settings', title: '模型配置', action: 'configure' },
        { id: 'claude', title: 'Claude Code', action: 'install' },
      ],
    },
    'install',
  );
  const result = presentation.result({
    state: 'partial',
    items: [
      {
        id: 'settings',
        state: 'partial',
        effects: [
          { state: 'done', code: 'settings-saved' },
          { state: 'failed', code: 'login-unconfirmed' },
        ],
      },
      { id: 'claude', state: 'failed', effects: [{ state: 'failed', code: 'command-failed' }] },
    ],
  });
  assert.deepEqual(
    result.rows.map(row => row.status),
    ['部分完成', '安装失败'],
  );
  assert.ok(result.rows.every(row => row.details.length === 0));
});

test('显示批次操作上下文', () => {
  const presentation = createRunPresentation(
    {
      items: [
        { id: 'settings', title: '模型配置', action: 'configure' },
        { id: 'claude', title: 'Claude Code', action: 'install' },
      ],
    },
    'install',
  );
  const result = presentation.result({
    state: 'failed',
    items: [
      { id: 'settings', state: 'failed', effects: [] },
      { id: 'claude', state: 'failed', effects: [] },
    ],
  });
  assert.equal(result.title, '运行结果 · 安装失败');
  assert.deepEqual(
    result.rows.map(row => row.status),
    ['配置失败', '安装失败'],
  );
});

test('保留取消前效果', () => {
  const presentation = createRunPresentation({ items: [{ id: 'claude', title: 'Claude Code', action: 'install' }] });
  const actual = {
    state: 'cancelled',
    items: [
      { id: 'claude', state: 'cancelled', isPending: false, effects: [{ state: 'done', code: 'program-file-ready' }] },
    ],
  };
  assert.equal(presentation.result(actual).rows[0].status, '已停止');
  const details = describeRun(presentation.details(actual, 'claude'));
  assert.match(details, /已完成 · 写入程序文件/);
  assert.match(details, /本项无可续办步骤/);
  assert.doesNotMatch(details, /已撤销|全部完成|已回滚/);
});

test('保留效果的实际严重性', () => {
  const presentation = createRunPresentation({ items: [{ id: 'claude', title: 'Claude Code', action: 'uninstall' }] });
  const actual = {
    state: 'done',
    items: [{ id: 'claude', state: 'done', effects: [{ state: 'kept', code: 'npm-not-found' }] }],
  };
  assert.equal(presentation.result(actual).rows[0].status, '完成');
  const details = presentation.details(actual, 'claude').rows[0].details;
  assert.equal(details[1].symbol, '—');
  assert.equal(details[1].tone, 'muted');
});

test('显示数据保留结果', () => {
  const presentation = createRunPresentation({ items: [{ id: 'data:cache', title: '缓存与日志', action: 'clean' }] });
  const item = { id: 'data:cache', state: 'done', effects: [{ state: 'kept', code: 'cleanup-link-kept' }] };
  const actual = { state: 'done', items: [item] };
  const result = presentation.result(actual);
  assert.equal(result.title, '运行结果 · 清理完成（有保留）');
  assert.deepEqual(result.rows[0].details, []);
  assert.equal(presentation.details(actual, item.id).rows[0].details[1].symbol, '—');
});

test('保留未知原因码', () => {
  const presentation = createRunPresentation({ items: [{ id: 'unknown', title: '外部对象', action: 'install' }] });
  const actual = {
    state: 'failed',
    items: [{ id: 'unknown', state: 'failed', effects: [{ state: 'failed', code: 'unmapped-failure' }] }],
  };
  assert.equal(presentation.result(actual).rows[0].status, '安装失败');
  const details = describeRun(presentation.details(actual, 'unknown'));
  assert.match(details, /代码：unmapped-failure/);
  assert.match(details, /操作失败：原因未知/);
  assert.doesNotMatch(details, /权限不足|未安装/);
});
