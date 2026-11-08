import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contentRows, describeChange, describeInspection, describeItem, reason } from '../dist/render.js';

for (const [kind, title, facts, expected] of [
  ['officecli', 'OfficeCLI', ['program-exists', 'program-identity-unchecked'], '待确认'],
  ['officecli', 'OfficeCLI', ['program-exists', 'not-connected'], '待接入'],
  ['officecli', 'OfficeCLI', ['program-exists', 'connected'], '已安装'],
  ['officecli', 'OfficeCLI', ['not-installed', 'connected'], '残留配置'],
  ['ccline', 'CCometixLine', ['program-exists', 'connected', 'appearance-missing'], '待配置'],
  ['mcp', 'Context7', ['registration-exists'], '已注册'],
])
  test(`显示事实状态：${kind} ${expected}`, () => {
    const item = {
      id: kind,
      name: kind,
      title,
      kind,
      facts: facts.map(code => ({ code })),
      actions: [],
    };
    const group = kind === 'mcp' ? 'MCPs' : '附加工具';
    assert.deepEqual(contentRows([item])[0], { label: title, detail: expected, group });
    assert.deepEqual(contentRows([{ ...item, problem: 'inspection-timeout' }])[0], {
      label: title,
      detail: '待确认',
      group,
    });
  });

test('程序列表：多副本按渠道与路径区分', () => {
  const copy = (id, location, channel) => ({
    id,
    name: 'claude',
    title: 'Claude Code',
    kind: 'claude',
    location,
    facts: [
      { code: 'program-exists', detail: channel },
      { code: 'program-version', detail: '1.2.3' },
    ],
    actions: [],
  });
  const sameChannel = contentRows([
    copy('claude:npm:C:\\tools\\a\\claude.js', 'C:\\tools\\a\\claude.js', 'npm'),
    copy('claude:npm:C:\\tools\\b\\claude.js', 'C:\\tools\\b\\claude.js', 'npm'),
  ]);
  assert.ok(sameChannel[0].label.includes('(npm · C:\\tools\\a\\claude.js)'), sameChannel[0].label);
  assert.ok(sameChannel[1].label.includes('(npm · C:\\tools\\b\\claude.js)'), sameChannel[1].label);
  const crossChannel = contentRows([
    copy('claude:npm:C:\\tools\\a\\claude.js', 'C:\\tools\\a\\claude.js', 'npm'),
    copy('claude:native:C:\\bin\\claude.exe', 'C:\\bin\\claude.exe', 'native'),
  ]);
  assert.ok(crossChannel[0].label.includes('(npm)') && !crossChannel[0].label.includes('·'), crossChannel[0].label);
  assert.ok(crossChannel[1].label.includes('(native)'), crossChannel[1].label);
});

test('渲染路径：移除控制字符', () => {
  assert.equal(
    describeChange({ code: 'ccline-root-configure', detail: '/custom\u001b[31m-root\u0007' }),
    '设置 CCometixLine 配置目录：/custom[31m-root',
  );
});

test('区分未知和已确认缺失', () => {
  const item = { id: 'claude', title: 'Claude Code', kind: 'claude', actions: [], facts: [] };
  assert.equal(contentRows([{ ...item, problem: 'inspection-timeout' }])[0].detail, '待确认');
  assert.equal(contentRows([{ ...item, facts: [{ code: 'not-installed' }] }])[0].detail, '未安装');
  assert.equal(
    contentRows([{ ...item, kind: 'plugin', facts: [{ code: 'plugin-files-missing' }] }])[0].detail,
    '插件文件缺失',
  );
  assert.equal(contentRows([{ ...item, facts: [{ code: 'program-missing' }] }])[0].detail, '程序入口缺失');
});

test('区分连接字段和登录状态', () => {
  const item = { id: 'settings', title: '模型配置', kind: 'settings', actions: [], facts: [] };
  assert.equal(contentRows([item])[0].detail, '默认连接');
  assert.equal(contentRows([{ ...item, facts: [{ code: 'api-configured' }] }])[0].detail, '已有连接字段');
  assert.doesNotMatch(describeItem(item), /已登录|官方账号/);
});

test('主动展开对象检查记录', () => {
  const item = {
    id: 'claude:npm:chosen',
    title: 'Claude Code',
    kind: 'claude',
    actions: [],
    facts: [{ code: 'program-exists', detail: 'npm' }],
    problem: 'inspection-timeout',
    location: '/tools/claude',
  };
  assert.equal(describeItem(item), 'Claude Code\n待确认\n位置：/tools/claude');
  const explicit = describeInspection({ items: [item], problems: [] });
  assert.match(explicit, /标识：claude:npm:chosen/);
  assert.match(explicit, /代码：inspection-timeout/);
  assert.match(explicit, /程序存在：npm/);
});

test('回退未知原因码', () => {
  assert.equal(reason('unmapped-failure'), '操作失败');
  assert.match(describeChange({ code: 'unmapped-failure' }), /^操作失败：原因未知$/);
});
