import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createEnv, ok, pluginMarketplaceFiles, revision } from './env.mjs';

/** 身份与标题反例：名称命中不等于身份确认；计划标题由核心独立生成 */
async function fixture(t) {
  const f = await createEnv(t, { layout: 'home' });
  const state = {
    locate: null, // 覆盖 locate：命令名 → 候选路径列表
    stampVanished: null, // treeStamp 对该路径报告目标消失
    interceptRead: null, // 命中时返回替换正文，返回 undefined 走真实读取
  };
  const wrapped = f.machine({
    npm: async () => ({ code: 0, failed: false, stdout: '{}' }),
    execute: async file => (file === 'git' ? ok(`${revision}\tHEAD\n`) : ok()),
    locate: async name => state.locate?.(name) ?? [],
    read: async (file, base) => {
      const body = state.interceptRead?.(file);
      return body !== undefined ? body : base.read(file);
    },
  });
  const machine = {
    ...wrapped,
    source: async () => pluginMarketplaceFiles(),
    treeStamp: (file, signal) => (file === state.stampVanished ? null : wrapped.treeStamp(file, signal)),
  };
  const ccw = f.ccw(machine);
  const mcpItems = async () => (await ccw.inspect()).items.filter(item => item.kind === 'mcp');
  return { ...f, state, machine, ccw, mcpItems };
}

test('MCP 身份：未知地址的同名注册保留原始键', async t => {
  const f = await fixture(t);
  await f.json(f.stateFile, {
    mcpServers: {
      context7: { type: 'http', url: 'https://unknown.example.test/mcp' },
      serena: { type: 'stdio', command: 'other-server', args: ['start'] },
      amirc: { type: 'stdio', command: 'node', args: ['C:\\elsewhere\\server.js'] },
      external: { command: 'server' },
    },
  });
  const byName = Object.fromEntries((await f.mcpItems()).map(item => [item.id.slice(4), item]));
  assert.equal(byName.context7.title, 'context7', '键名命中不确认产品身份');
  assert.equal(byName.serena.title, 'serena');
  assert.equal(byName.amirc.title, 'amirc');
  assert.equal(byName.external.title, 'external', '未知第三方保留原文');
});

test('MCP 身份：匹配注册模板与未注册方案用官方名', async t => {
  const f = await fixture(t);
  await f.json(f.stateFile, {
    mcpServers: {
      context7: { type: 'http', url: 'https://mcp.context7.com/mcp' },
      serena: {
        type: 'stdio',
        command: 'C:\\tools\\serena.exe',
        args: ['start-mcp-server', '--context', 'claude-code'],
      },
    },
  });
  const byName = Object.fromEntries((await f.mcpItems()).map(item => [item.id.slice(4), item]));
  assert.equal(byName.context7.title, 'Context7', '官方端点匹配即确认');
  assert.equal(byName.serena.title, 'Serena');
  assert.equal(byName.amirc, undefined, '退役的MCP不再作为安装方案');
});

test('计划标题由核心生成：调用方不传标题', async t => {
  const f = await fixture(t);
  await f.json(f.stateFile, {
    mcpServers: { context7: { type: 'http', url: 'https://unknown.example.test/mcp' } },
  });
  const detach = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'mcp:context7' }] });
  assert.equal(detach.items[0].title, 'context7', '与检查页同一证据结论');
  await f.ccw.abandon((await f.ccw.recovery()).id);
  const offered = await f.ccw.plan({ task: 'install', selected: [{ id: 'mcp:context7' }] });
  assert.equal(offered.items[0].title, 'context7', '已存在未知注册时安装仍按证据命名');
  assert.equal(offered.items[0].problem, null);
});

test('计划标题由核心生成：未注册方案与技能成员', async t => {
  const f = await fixture(t);
  const install = await f.ccw.plan({ task: 'install', selected: [{ id: 'mcp:context7' }, { id: 'skill-set:ssre2' }] });
  assert.equal(install.items.find(item => item.id === 'mcp:context7')?.title, 'Context7');
  assert.equal(install.items.find(item => item.id === 'skill-set:ssre2')?.title, 'HIT-SudoMaker/SSRE2');
  await f.write(path.join(f.claudeRoot, 'skills/ssre2-design/SKILL.md'), '---\nname: ssre2-design\n---\n');
  await f.ccw.abandon((await f.ccw.recovery()).id);
  const detach = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'skill:ssre2-design' }] });
  assert.equal(detach.items[0].title, 'ssre2-design', '成员用实际成员名');
});

test('多副本计划标题附渠道：预览与结果可辨认', async t => {
  const f = await fixture(t);
  const plan = await f.ccw.plan({
    task: 'uninstall',
    selected: [{ id: 'officecli:npm:C:\\tools\\officecli.js' }, { id: 'officecli:native:C:\\bin\\officecli.exe' }],
  });
  assert.deepEqual(
    plan.items.map(item => item.title),
    ['OfficeCLI (npm)', 'OfficeCLI (native)'],
  );
  assert.ok(
    plan.items.every(item => item.problem === 'program-changed'),
    '目标缺失只影响执行，不影响描述',
  );
});

test('插件身份：官方样式 id 配不匹配来源不获官方标题', async t => {
  const f = await fixture(t);
  await f.json(path.join(f.claudeRoot, 'plugins/known_marketplaces.json'), {
    'claude-plugins-official': { source: { repo: 'someone/else' } },
  });
  await f.json(path.join(f.claudeRoot, 'settings.json'), {
    enabledPlugins: { 'github@claude-plugins-official': true },
  });
  const item = (await f.ccw.inspect()).items.find(entry => entry.id === 'plugin:github@claude-plugins-official');
  assert.ok(item);
  assert.equal(item.title, 'github@claude-plugins-official', '来源不匹配保留原文 id');
  assert.notEqual(item.canInstall, true, '资格由来源证据决定，不因键名授予');
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'plugin:github@claude-plugins-official' }] });
  assert.equal(plan.items[0].title, 'github@claude-plugins-official');
});

test('插件身份：来源匹配获得官方标题', async t => {
  const f = await fixture(t);
  await f.json(path.join(f.claudeRoot, 'plugins/known_marketplaces.json'), {
    'claude-plugins-official': { source: { repo: 'anthropics/claude-plugins-official' } },
  });
  const item = (await f.ccw.inspect()).items.find(entry => entry.id === 'plugin:github@claude-plugins-official');
  assert.ok(item);
  assert.equal(item.title, 'GitHub');
  assert.equal(item.canInstall, true);
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'plugin:github@claude-plugins-official' }] });
  assert.equal(plan.items[0].title, 'GitHub');
  assert.equal(plan.items[0].problem, null);
});

test('MCP 标题：拒绝矛盾协议和伪内置路径', async t => {
  const f = await fixture(t);
  await f.json(f.stateFile, {
    mcpServers: {
      context7: { type: 'stdio', command: 'other', url: 'https://mcp.context7.com/mcp' },
      serena: { type: 'http', url: 'https://unknown.example.test', command: 'serena', args: ['start-mcp-server'] },
      amirc: { type: 'stdio', command: 'other', args: ['/tmp/fake_amirc_academic_mcp/server.js'] },
    },
  });
  const items = await f.mcpItems();
  assert.deepEqual(
    items.map(item => item.id).sort(),
    ['mcp:amirc', 'mcp:context7', 'mcp:serena'],
    '矛盾协议注册必须以原始键名出现在检查列表',
  );
  for (const item of items) assert.equal(item.title, item.id.slice(4));
  const entry = fileURLToPath(new URL('../../amirc_academic_mcp/dist/main.js', import.meta.url));
  await f.json(f.stateFile, { mcpServers: { amirc: { type: 'stdio', command: process.execPath, args: [entry] } } });
  assert.equal((await f.mcpItems()).find(item => item.id === 'mcp:amirc').title, 'amirc');
});

test('同渠道副本：冻结标题包含各自路径', async t => {
  const f = await fixture(t);
  const paths = [path.join(f.root, 'one', 'officecli'), path.join(f.root, 'two', 'officecli')];
  const plan = await f.ccw.plan({
    task: 'uninstall',
    selected: paths.map(file => ({ id: `officecli:native:${file}` })),
  });
  assert.notEqual(plan.items[0].title, plan.items[1].title);
  for (const [i, item] of plan.items.entries()) assert.ok(item.title.includes(paths[i]));
  const result = await f.ccw.apply(plan.id);
  assert.deepEqual(
    result.items.map(item => item.title),
    plan.items.map(item => item.title),
  );
});

test('准备取消：读取注册期间取消不交付迟到标题和计划', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const events = [];
  f.state.interceptRead = file => {
    if (file !== f.stateFile) return undefined;
    controller.abort();
    return JSON.stringify({ mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } } });
  };
  await assert.rejects(
    f.ccw.plan({ task: 'uninstall', selected: [{ id: 'mcp:context7' }] }, controller.signal, event =>
      events.push(event),
    ),
    /cancelled/,
  );
  assert.deepEqual(
    events.map(event => event.title),
    ['context7'],
  );
});

test('插件解除：市场损坏不阻断已确认声明的解除', async t => {
  const f = await fixture(t);
  const name = 'github@claude-plugins-official';
  await f.json(path.join(f.claudeRoot, 'settings.json'), { enabledPlugins: { [name]: true } });
  f.state.interceptRead = file => (file.endsWith('known_marketplaces.json') ? '{broken' : undefined);
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: `plugin:${name}` }] });
  assert.equal(plan.items[0].problem, null);
  assert.equal(plan.items[0].title, name);
  const result = await f.ccw.apply(plan.id);
  assert.equal(result.items[0].state, 'done');
  assert.equal(result.items[0].title, name);
});

test('插件身份：已有实际对象而市场记录缺失保留原始键名', async t => {
  const f = await fixture(t);
  const name = 'github@claude-plugins-official';
  await f.json(path.join(f.claudeRoot, 'plugins/known_marketplaces.json'), {
    other: { source: { repo: 'x/y' } },
  });
  await f.json(path.join(f.claudeRoot, 'plugins/installed_plugins.json'), {
    plugins: { [name]: [{ scope: 'user', installPath: path.join(f.claudeRoot, 'plugins/github') }] },
  });
  const items = (await f.ccw.inspect()).items;
  const installed = items.find(entry => entry.id === `plugin:${name}`);
  assert.ok(installed);
  assert.equal(installed.title, name, '市场记录缺失不确认已安装对象身份');
  const offering = items.find(entry => entry.id === 'plugin:skill-creator@claude-plugins-official');
  assert.equal(offering.title, 'Skill Creator', '未安装的方案入口仍用官方名');
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: `plugin:${name}` }] });
  assert.equal(plan.items[0].title, name, '检查与计划同一结论');
});

test('插件身份：市场文件损坏时检查页保留原始键名', async t => {
  const f = await fixture(t);
  const name = 'github@claude-plugins-official';
  await f.json(path.join(f.claudeRoot, 'settings.json'), { enabledPlugins: { [name]: true } });
  await f.write(path.join(f.claudeRoot, 'plugins/known_marketplaces.json'), '{broken');
  const item = (await f.ccw.inspect()).items.find(entry => entry.id === `plugin:${name}`);
  assert.ok(item);
  assert.equal(item.title, name, '市场损坏时检查与计划同一结论');
});

test('Claude 多副本：同渠道附路径，跨渠道附渠道', async t => {
  const f = await fixture(t);
  const plan = await f.ccw.plan({
    task: 'uninstall',
    selected: [
      { id: 'claude:npm:C:\\one\\claude.js' },
      { id: 'claude:npm:C:\\two\\claude.js' },
      { id: 'claude:native:C:\\bin\\claude.exe' },
    ],
  });
  const titles = Object.fromEntries(plan.items.map(item => [item.id, item.title]));
  assert.equal(titles['claude:npm:C:\\one\\claude.js'], 'Claude Code (npm · C:\\one\\claude.js)');
  assert.equal(titles['claude:npm:C:\\two\\claude.js'], 'Claude Code (npm · C:\\two\\claude.js)');
  assert.equal(titles['claude:native:C:\\bin\\claude.exe'], 'Claude Code (native)');
  for (const item of plan.items) assert.equal(item.problem, 'program-changed', '目标缺失只影响执行');
});

test('程序保留：准备期间二进制消失报 program-changed', async t => {
  const f = await fixture(t);
  const binary = path.join(f.root, 'tool', 'claude.exe');
  await f.write(binary, 'binary');
  f.state.locate = name => (name === 'claude' ? [binary] : []);
  f.state.stampVanished = binary;
  const plan = await f.ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(plan.items[0].problem, 'program-changed', '不允许对已消失程序报告保留');
});

test('技能方案：干净环境不虚构成员占位，只有套件入口', async t => {
  const f = await fixture(t);
  const items = (await f.ccw.inspect()).items;
  assert.equal(
    items.some(item => item.id === 'skill:ssre2-design' || item.id === 'skill:ssre2-review'),
    false,
    '检查只列实际成员，未安装成员不进入契约',
  );
  const suites = Object.fromEntries(
    items.filter(item => item.id.startsWith('skill-set:')).map(item => [item.id, item]),
  );
  assert.deepEqual(Object.keys(suites).sort(), ['skill-set:mattpocock', 'skill-set:ssre2']);
  assert.equal(suites['skill-set:mattpocock'].title, 'Matt Pocock/Skills');
  assert.equal(suites['skill-set:ssre2'].title, 'HIT-SudoMaker/SSRE2');
  assert.equal(suites['skill-set:ssre2'].canInstall, true, '安装资格在套件入口');
});

test('MCP 降级：注册文件损坏时方案入口可见且无资格', async t => {
  const f = await fixture(t);
  await f.write(f.stateFile, '{broken');
  const items = await f.mcpItems();
  assert.deepEqual(items.map(item => item.title).sort(), ['Context7', 'Serena'], '方案入口降级仍用官方名');
  assert.ok(
    items.every(item => item.problem !== undefined),
    '读取失败逐项携带问题',
  );
  assert.ok(
    items.every(item => item.canInstall === false),
    '状态未知不授予安装资格',
  );
  assert.ok(
    items.every(item => item.actions.length === 0),
    '读取失败不授予任何操作资格',
  );
  assert.ok(
    items.every(
      item => !item.facts.some(fact => fact.code === 'registration-exists' || fact.code === 'not-registered'),
    ),
    '注册存在性未知时不虚构事实',
  );
});

test('配套插件身份：市场来源匹配用注册名，市场缺失保留原始键', async t => {
  const f = await fixture(t);
  const name = 'cometix@ccline';
  await f.json(path.join(f.claudeRoot, 'settings.json'), { enabledPlugins: { [name]: true } });
  await f.json(path.join(f.claudeRoot, 'plugins/known_marketplaces.json'), {
    ccline: { source: { repo: 'Haleclipse/CCometixLine' } },
  });
  const confirmed = (await f.ccw.inspect()).items.find(entry => entry.id === `plugin:${name}`);
  assert.ok(confirmed);
  assert.equal(confirmed.title, 'CCometixLine 配套插件', '来源证据确认即用注册标题');
  await fs.rm(path.join(f.claudeRoot, 'plugins/known_marketplaces.json'));
  const raw = (await f.ccw.inspect()).items.find(entry => entry.id === `plugin:${name}`);
  assert.ok(raw);
  assert.equal(raw.title, name, '市场记录缺失保留原始键名');
});

test('程序单副本：计划标题与列表一致，不附渠道', async t => {
  const f = await fixture(t);
  const plan = await f.ccw.plan({ task: 'uninstall', selected: [{ id: 'claude:npm:C:\\one\\claude.js' }] });
  assert.equal(plan.items[0].title, 'Claude Code', '副本后缀只在需要区分时出现');
  assert.equal(plan.items[0].problem, 'program-changed');
});
