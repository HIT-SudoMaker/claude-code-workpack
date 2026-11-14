import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { npmConfig, createTestEnvironment, exists, fail, ok, releaseContract, revision } from './test-environment.mjs';
import { createSkillsCliFixture } from './skills-cli-fixture.mjs';

async function createInstallationScenario(
  testContext,
  { platform = process.platform, cclineOutput = 'ccline 2.0.1', claudeEntry = 'cli.js' } = {},
) {
  const workspace = await createTestEnvironment(testContext, {
    layout: 'root',
    seed: { settings: {}, state: { projects: { untouched: { mcpServers: { projectOnly: { command: 'keep' } } } } } },
  });
  const cclineRoot = path.join(workspace.home, '.claude/ccline');
  const skills = createSkillsCliFixture(workspace);
  const cclineBinary = path.join(cclineRoot, platform === 'win32' ? 'ccline.exe' : 'ccline');
  const npmRoot = path.join(workspace.root, 'npm/node_modules');
  const claudePackage = '@anthropic-ai/claude-code';
  const claudeBinary = path.join(npmRoot, claudePackage, claudeEntry);
  const native = path.join(workspace.home, '.local/bin', platform === 'win32' ? 'claude.exe' : 'claude');
  const officeBinary =
    platform === 'win32'
      ? path.join(workspace.home, 'AppData/Local/OfficeCli/officecli.exe')
      : path.join(workspace.home, '.local/bin/officecli');
  const officeAsset =
    'officecli-' +
    { win32: 'win', darwin: 'mac', linux: 'linux' }[platform] +
    '-' +
    process.arch +
    (platform === 'win32' ? '.exe' : '');
  const officePayload = Buffer.from('OfficeCLI native fixture');
  const release = releaseContract({
    tag: 'v1.0.123',
    asset: officeAsset,
    digest: createHash('sha256').update(officePayload).digest('hex'),
    revision,
  });
  const packages = new Map();
  const state = { fail: '', stableVersion: '2.1.318' };
  const readJson = async file => ((await exists(file)) ? workspace.read(file) : {});
  const machine = {
    ...workspace.machine({
      locate: async command => {
        const binary = command === 'claude' ? native : command === 'officecli' ? officeBinary : undefined;
        return binary && (await exists(binary)) ? [binary] : [];
      },
      processes: async () => [],
      npm: async (args, options) => {
        state.onNpm?.(args, options);
        const last = args.at(-1);
        if (state.fail === 'npm:' + args[0]) return fail();
        if (args[0] === 'exec') return skills.npm(args, options);
        if (args[0] === 'config') return npmConfig(args);
        if (args[0] === 'root') return ok(npmRoot);
        if (args[0] === 'ls')
          return ok(
            JSON.stringify({ dependencies: packages.has(last) ? { [last]: { version: packages.get(last) } } : {} }),
          );
        if (args[0] === 'view') {
          assert.ok(
            [claudePackage + '@stable', '@cometix/ccline@latest'].includes(args[1]),
            'unsupported package query',
          );
          return ok(JSON.stringify(args[1].startsWith(claudePackage) ? state.stableVersion : '2.0.1'));
        }
        if (args[0] === 'uninstall') {
          assert.ok([claudePackage, '@cometix/ccline'].includes(last));
          packages.delete(last);
          await fs.rm(path.join(npmRoot, last), { recursive: true, force: true });
          if (last === '@cometix/ccline') await fs.rm(cclineBinary, { force: true });
          return ok();
        }
        if (args[0] === 'install') {
          const split = last.lastIndexOf('@');
          const name = last.slice(0, split),
            version = last.slice(split + 1);
          assert.ok([claudePackage, '@cometix/ccline'].includes(name));
          packages.set(name, version);
          await workspace.json(path.join(npmRoot, name, 'package.json'), {
            name,
            version,
            bin: { claude: claudeEntry },
          });
          await workspace.write(name === claudePackage ? claudeBinary : cclineBinary, 'binary fixture');
          return ok();
        }
        throw new Error('Unexpected npm command: ' + args[0]);
      },
      execute: async (executable, args) => {
        if (executable === cclineBinary || executable === officeBinary) {
          assert.deepEqual(args, ['--version']);
          return ok(executable === cclineBinary ? cclineOutput : 'OfficeCLI 1.0.123');
        }
        if (executable === 'git') {
          assert.equal(args[0], 'ls-remote');
          return ok(revision + '\tHEAD\n');
        }
        if (executable === native) {
          assert.deepEqual(args, ['--version']);
          return ok('2.1.318 (Claude Code)');
        }
        if (executable !== claudeBinary) {
          assert.equal(executable, process.execPath);
          assert.equal(args[0], claudeBinary);
          args = args.slice(1);
        }
        if (args[0] === '--version') return ok(packages.get(claudePackage) + ' (Claude Code)');
        assert.equal(args[0], 'plugin');
        if (args[1] === 'marketplace') {
          assert.deepEqual(args.slice(1), [
            'marketplace',
            'add',
            'anthropics/claude-plugins-official',
            '--scope',
            'user',
          ]);
          await workspace.json(path.join(workspace.claudeRoot, 'plugins/known_marketplaces.json'), {
            'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } },
          });
          return ok();
        }
        assert.ok(['install', 'update', 'enable'].includes(args[1]));
        assert.deepEqual(args.slice(3), ['--scope', 'user']);
        const id = args[2],
          config = await readJson(workspace.settingsFile);
        const recordFile = path.join(workspace.claudeRoot, 'plugins/installed_plugins.json');
        const records = await readJson(recordFile);
        const installPath = path.join(workspace.claudeRoot, 'plugins/cache', id);
        await workspace.write(path.join(installPath, '.claude-plugin/plugin.json'), '{}');
        records.version = 2;
        records.plugins ??= {};
        records.plugins[id] = [{ scope: 'user', version: '1.0.0', installPath, gitCommitSha: revision }];
        config.enabledPlugins ??= {};
        config.enabledPlugins[id] = true;
        await workspace.json(recordFile, records);
        await workspace.json(workspace.settingsFile, config);
        return ok();
      },
    }),
    userPathContains: async () => true,
    async ensureUserPath() {},
    async replaceFile(...args) {
      if (state.fail === 'replace-file') throw Object.assign(new Error('fixture'), { code: 'EACCES' });
      const result = await workspace.machine().replaceFile(...args);
      if (state.fail === 'replace-after-write') throw Object.assign(new Error('fixture'), { code: 'EACCES' });
      return result;
    },
    async fetchBytes(url) {
      assert.equal(url, release.release + officeAsset);
      return officePayload;
    },
    fetchText: release.fetchText,
    async source(repository, commit, folder) {
      assert.equal(commit, revision);
      assert.equal(repository, 'https://github.com/iOfficeAI/OfficeCLI');
      assert.equal(folder, 'skills/officecli');
      return [{ path: 'SKILL.md', data: Buffer.from('---\nname: officecli\n---\n') }];
    },
  };
  const ccw = workspace.ccw(machine, { cclineRoot, platform });
  const apply = async input => {
    const plan = await ccw.plan(input);
    assert.ok(
      plan.items.every(item => item.problem === null),
      JSON.stringify(plan),
    );
    return ccw.apply(plan.id);
  };
  return { ...workspace, native, settings: workspace.settingsFile, ccw, state, packages, readJson, apply };
}

const installation = [
  { id: 'claude' },
  {
    id: 'settings',
    fields: {
      mode: 'api',
      baseUrl: 'https://example.test/api',
      secret: 'fixture-secret',
      model: 'fixture-model',
      language: '中文',
    },
  },
  ...['code-simplifier', 'frontend-design', 'github', 'context7', 'serena'].map(name => ({
    id: 'plugin:' + name + '@claude-plugins-official',
  })),
  { id: 'skill:amirc-research' },
  { id: 'skill-set:ssre2' },
  { id: 'skill-set:mattpocock' },
  { id: 'officecli' },
  { id: 'ccline' },
];

// 完整流程：安装、重复更新与移除保留数据
for (const platform of ['win32', 'darwin', 'linux'])
  test(platform + ' 固定渠道安装，重复操作自动更新，卸载保留用户数据', async testContext => {
    const scenario = await createInstallationScenario(testContext, { platform });
    const plan = await scenario.ccw.plan({ task: 'install', selected: installation });
    assert.ok(
      plan.items.every(i => i.problem === null),
      JSON.stringify(plan),
    );
    assert.equal(JSON.stringify(plan).includes('fixture-secret'), false);
    let result = await scenario.ccw.apply(plan.id);
    assert.equal(result.state, 'done', JSON.stringify(result));
    let config = await scenario.readJson(scenario.settings);
    assert.equal(config.env.ANTHROPIC_API_KEY, 'fixture-secret');
    assert.equal(config.statusLine.command, 'ccline');
    assert.equal(config.enabledPlugins['context7@claude-plugins-official'], true);
    assert.equal((await scenario.readJson(scenario.stateFile)).mcpServers?.context7, undefined);
    assert.equal((await scenario.readJson(scenario.stateFile)).mcpServers?.officecli, undefined);
    assert.ok(await exists(path.join(scenario.claudeRoot, 'skills/officecli/SKILL.md')));
    assert.ok(await exists(path.join(scenario.claudeRoot, 'skills/tdd/SKILL.md')));
    assert.equal(
      scenario.calls.some(c => c.kind === 'execute' && /^(brew|winget|scoop|apt|uv)$/.test(c.target)),
      false,
    );
    scenario.state.stableVersion = '2.1.319';
    const update = await scenario.ccw.plan({ task: 'install', selected: installation });
    for (const id of ['claude', 'officecli', 'ccline', 'plugin:github@claude-plugins-official'])
      assert.equal(update.items.find(item => item.id === id).action, 'update');
    result = await scenario.ccw.apply(update.id);
    assert.equal(result.state, 'done', JSON.stringify(result));
    assert.equal(scenario.packages.get('@anthropic-ai/claude-code'), '2.1.319');
    const preserved = path.join(scenario.claudeRoot, 'projects/user-session.jsonl');
    await scenario.write(preserved, 'user history');
    const cclineConfig = path.join(scenario.home, '.claude/ccline/config.toml');
    const before = await fs.readFile(cclineConfig, 'utf8');
    const remove = await scenario.ccw.plan({
      task: 'uninstall',
      selected: [
        { id: 'claude' },
        { id: 'ccline' },
        { id: 'officecli' },
        { id: 'plugin:context7@claude-plugins-official' },
        { id: 'plugin:serena@claude-plugins-official' },
        { id: 'plugin:github@claude-plugins-official' },
        { id: 'skill:amirc-research' },
      ],
    });
    assert.ok(
      remove.items.every(i => i.problem === null),
      JSON.stringify(remove),
    );
    result = await scenario.ccw.apply(remove.id);
    assert.equal(result.state, 'done', JSON.stringify(result));
    assert.equal(await fs.readFile(preserved, 'utf8'), 'user history');
    assert.equal(await fs.readFile(cclineConfig, 'utf8'), before);
    assert.equal((await scenario.readJson(scenario.settings)).enabledPlugins['github@claude-plugins-official'], false);
    assert.equal((await scenario.readJson(scenario.settings)).env.ANTHROPIC_API_KEY, 'fixture-secret');
  });

// Claude：固定 stable 渠道，确认安装后再配置连接
test('新版 Claude npm 原生入口直接执行，首次写入 bypass 与危险提示配置', async testContext => {
  const scenario = await createInstallationScenario(testContext, { claudeEntry: 'bin/claude.exe' });
  const result = await scenario.apply({
    task: 'install',
    selected: [{ id: 'claude' }, { id: 'plugin:context7@claude-plugins-official' }],
  });
  assert.equal(result.state, 'done', JSON.stringify(result));
  const settings = await scenario.readJson(scenario.settings);
  assert.equal(settings.permissions.defaultMode, 'bypassPermissions');
  assert.equal(settings.skipDangerousModePermissionPrompt, true);
  assert.ok(
    scenario.calls.some(
      call => call.kind === 'execute' && call.target.endsWith('claude.exe') && call.args[0] === '--version',
    ),
  );
  assert.equal(
    scenario.calls.some(call => call.kind === 'execute' && call.target === process.execPath),
    false,
  );
});

test('Claude 已装更高版本时仍回到当次 stable，更新通道保持 stable', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  await scenario.apply({ task: 'install', selected: [{ id: 'claude' }] });
  await scenario.json(scenario.settings, {
    autoUpdatesChannel: 'latest',
    permissions: { defaultMode: 'plan' },
    skipDangerousModePermissionPrompt: false,
  });
  scenario.state.stableVersion = '2.1.300';
  const result = await scenario.apply({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(result.state, 'done');
  assert.equal(scenario.packages.get('@anthropic-ai/claude-code'), '2.1.300');
  const settings = await scenario.readJson(scenario.settings);
  assert.equal(settings.autoUpdatesChannel, 'stable');
  assert.equal(settings.permissions.defaultMode, 'plan');
  assert.equal(settings.skipDangerousModePermissionPrompt, false);
});

test('npm 与外部 Claude 共存时，只更新固定 npm 安装', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  assert.equal((await scenario.apply({ task: 'install', selected: [{ id: 'claude' }] })).state, 'done');
  await scenario.write(scenario.native, 'external installation');
  scenario.state.stableVersion = '2.1.319';
  const plan = await scenario.ccw.plan({ task: 'install', selected: [{ id: 'claude' }] });
  assert.equal(plan.items[0].problem, null);
  assert.equal(plan.items[0].action, 'update');
  assert.equal((await scenario.ccw.apply(plan.id)).state, 'done');
  assert.equal(scenario.packages.get('@anthropic-ai/claude-code'), '2.1.319');
  assert.equal(await fs.readFile(scenario.native, 'utf8'), 'external installation');
});

test('外部 Claude 仅显示；固定安装渠道拒绝接管', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  await scenario.write(scenario.native, 'external installation');
  const inspected = await scenario.ccw.inspect();
  const external = inspected.items.find(i => i.kind === 'claude' && i.id.includes('external'));
  assert.ok(external);
  assert.equal(external.canInstall, false);
  assert.equal(external.canUninstall, false);
  const plan = await scenario.ccw.plan({ task: 'uninstall', selected: [{ id: external.id }] });
  assert.ok(plan.items[0].problem);
  await scenario.ccw.apply(plan.id);
  assert.equal(await fs.readFile(scenario.native, 'utf8'), 'external installation');
});

test('预览已阻断官方登录时，不提前清除现有 API 配置', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  await scenario.json(scenario.settings, { env: { ANTHROPIC_API_KEY: 'existing-key' } });
  scenario.state.fail = 'npm:config';
  const plan = await scenario.ccw.plan({
    task: 'install',
    selected: [{ id: 'claude' }, { id: 'settings', fields: { mode: 'official', login: 'yes' } }],
  });
  assert.equal(plan.items.find(item => item.id === 'settings').problem, 'dependency-not-ready');
  const result = await scenario.ccw.apply(plan.id);
  assert.equal(result.items.find(item => item.id === 'settings').state, 'skipped');
  assert.equal((await scenario.readJson(scenario.settings)).env.ANTHROPIC_API_KEY, 'existing-key');
});

test('Claude 安装失败时，已准备的官方登录不会清除现有 API 配置', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  await scenario.json(scenario.settings, { env: { ANTHROPIC_API_KEY: 'existing-key' } });
  scenario.state.fail = 'npm:install';
  const plan = await scenario.ccw.plan({
    task: 'install',
    selected: [{ id: 'claude' }, { id: 'settings', fields: { mode: 'official', login: 'yes' } }],
  });
  assert.ok(plan.items.every(item => item.problem === null));
  const result = await scenario.ccw.apply(plan.id);
  assert.equal(result.items.find(item => item.id === 'settings').state, 'skipped');
  assert.equal((await scenario.readJson(scenario.settings)).env.ANTHROPIC_API_KEY, 'existing-key');
});

// 插件与 MCP：统一插件接入，保留独立配置
for (const existing of [false, true])
  test(`GitHub 与默认 Context7 不写入传入令牌，保留已有配置：${existing}`, async testContext => {
    const scenario = await createInstallationScenario(testContext);
    await scenario.apply({ task: 'install', selected: [{ id: 'claude' }] });
    const env = existing ? { GITHUB_PERSONAL_ACCESS_TOKEN: 'user-token', USER_VALUE: 'keep' } : { USER_VALUE: 'keep' };
    await scenario.json(scenario.settings, { env });
    const context7 = { type: 'http', url: 'https://mcp.context7.com/mcp' };
    if (existing) context7.headers = { Authorization: 'Bearer user-token', 'X-User': 'keep' };
    await scenario.json(scenario.stateFile, { mcpServers: existing ? { context7 } : {} });
    const result = await scenario.apply({
      task: 'install',
      selected: [
        { id: 'plugin:github@claude-plugins-official', fields: { secret: 'unwanted-token' } },
        { id: 'plugin:context7@claude-plugins-official', fields: { secret: 'unwanted-token' } },
      ],
    });
    assert.equal(result.state, 'done');
    assert.deepEqual((await scenario.readJson(scenario.settings)).env, env);
    assert.deepEqual(
      (await scenario.readJson(scenario.stateFile)).mcpServers.context7,
      existing ? context7 : undefined,
    );
    assert.doesNotMatch(JSON.stringify(result), /unwanted-token|github-credential/);
  });

test('Context7 只安装插件，保留所有独立 MCP 配置', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  await scenario.apply({ task: 'install', selected: [{ id: 'claude' }] });
  const state = {
    mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' }, custom: { command: 'keep' } },
  };
  await scenario.json(scenario.stateFile, state);
  const result = await scenario.apply({
    task: 'install',
    selected: [{ id: 'plugin:context7@claude-plugins-official' }],
  });
  assert.equal(result.state, 'done');
  assert.deepEqual(await scenario.readJson(scenario.stateFile), state);
  assert.equal(
    scenario.calls.some(call => call.kind === 'execute' && call.args.includes('mcp')),
    false,
  );
});

test('独立 MCP 配置变化不影响 Context7 插件安装', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  await scenario.apply({ task: 'install', selected: [{ id: 'claude' }] });
  await scenario.json(scenario.stateFile, {
    mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } },
  });
  const plan = await scenario.ccw.plan({
    task: 'install',
    selected: [{ id: 'plugin:context7@claude-plugins-official' }],
  });
  await scenario.json(scenario.stateFile, { mcpServers: { context7: { command: 'new-user-tool' } } });
  const result = await scenario.ccw.apply(plan.id);
  assert.equal(result.state, 'done');
  assert.equal((await scenario.readJson(scenario.stateFile)).mcpServers.context7.command, 'new-user-tool');
});

test('Serena 通过插件安装和移除，无独立运行程序也能选择，保留已有 MCP 配置', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  const state = {
    mcpServers: {
      serena: { command: 'user-serena' },
      context7: { type: 'http', url: 'https://foreign.test' },
      other: { command: 'keep' },
    },
  };
  await scenario.json(scenario.stateFile, state);
  const inspection = await scenario.ccw.inspect();
  assert.equal(inspection.items.find(item => item.id === 'plugin:serena@claude-plugins-official').canInstall, true);
  assert.equal(
    inspection.items.some(item => item.id.startsWith('mcp:')),
    false,
  );
  const result = await scenario.apply({
    task: 'install',
    selected: [{ id: 'claude' }, { id: 'plugin:serena@claude-plugins-official' }],
  });
  assert.equal(result.state, 'done');
  assert.equal((await scenario.readJson(scenario.settings)).enabledPlugins['serena@claude-plugins-official'], true);
  assert.deepEqual(await scenario.readJson(scenario.stateFile), state);
  assert.equal(
    (await scenario.apply({ task: 'uninstall', selected: [{ id: 'plugin:serena@claude-plugins-official' }] })).state,
    'done',
  );
  assert.equal((await scenario.readJson(scenario.settings)).enabledPlugins['serena@claude-plugins-official'], false);
  assert.deepEqual(await scenario.readJson(scenario.stateFile), state);
  for (const task of ['install', 'uninstall']) {
    const unsupported = await scenario.ccw.plan({ task, selected: [{ id: 'mcp:context7' }, { id: 'mcp:serena' }] });
    assert.ok(unsupported.items.every(item => item.problem === 'unknown-selection'));
    await scenario.ccw.apply(unsupported.id);
    assert.deepEqual(await scenario.readJson(scenario.stateFile), state);
  }
});

for (const failure of ['invalid-json', 'unreadable-json', 'invalid-record', 'unreadable-installation'])
  test(`插件停用只依赖启用字段，保留异常安装数据：${failure}`, async testContext => {
    const scenario = await createInstallationScenario(testContext);
    assert.equal((await scenario.apply({ task: 'install', selected: [{ id: 'claude' }] })).state, 'done');
    const plugin = 'github@claude-plugins-official';
    const id = 'plugin:' + plugin;
    const settings = {
      enabledPlugins: { [plugin]: true, 'user-plugin@private': true },
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'existing-token', USER_VALUE: 'keep' },
      statusLine: { type: 'command', command: 'user-status' },
      custom: { keep: ['unchanged'] },
    };
    await scenario.json(scenario.settings, settings);
    const metadata = path.join(scenario.claudeRoot, 'plugins/installed_plugins.json');
    const pluginFile = path.join(scenario.claudeRoot, 'plugins/cache/github/local.txt');
    await scenario.write(pluginFile, 'local plugin content');
    if (failure === 'invalid-json') await scenario.write(metadata, '{broken');
    else if (failure === 'unreadable-json') await scenario.write(path.join(metadata, 'keep.txt'), 'metadata directory');
    else
      await scenario.json(metadata, {
        plugins: {
          [plugin]: [{ scope: 'user', installPath: failure === 'invalid-record' ? 42 : pluginFile + '\0' }],
        },
        custom: 'keep',
      });
    const preservedMetadata = failure === 'unreadable-json' ? path.join(metadata, 'keep.txt') : metadata;
    const metadataBefore = await fs.readFile(preservedMetadata, 'utf8');
    const inspected = (await scenario.ccw.inspect()).items.find(item => item.id === id);
    assert.equal(inspected.canUninstall, true);
    assert.ok(inspected.problem);
    assert.ok(inspected.facts.some(fact => fact.code === 'declared-enabled'));
    const install = await scenario.ccw.plan({ task: 'install', selected: [{ id }] });
    assert.equal(install.items[0].problem, inspected.problem);
    const before = scenario.calls.length;
    const plan = await scenario.ccw.plan({ task: 'uninstall', selected: [{ id }] });
    assert.equal(plan.items[0].problem, null);
    assert.equal(plan.items[0].action, 'detach');
    assert.equal((await scenario.ccw.apply(plan.id)).state, 'done');
    assert.deepEqual(
      scenario.calls.slice(before).map(call => call.kind),
      ['editJson'],
    );
    assert.deepEqual(await scenario.readJson(scenario.settings), {
      ...settings,
      enabledPlugins: { ...settings.enabledPlugins, [plugin]: false },
    });
    assert.equal(await fs.readFile(preservedMetadata, 'utf8'), metadataBefore);
    assert.equal(await fs.readFile(pluginFile, 'utf8'), 'local plugin content');
    assert.equal((await scenario.ccw.inspect()).items.find(item => item.id === id).canUninstall, false);
    assert.equal(
      (await scenario.ccw.plan({ task: 'uninstall', selected: [{ id }] })).items[0].problem,
      'no-connection',
    );
  });

test('Context7 插件安装失败保留旧默认注册', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  await scenario.apply({ task: 'install', selected: [{ id: 'claude' }] });
  const registration = { type: 'http', url: 'https://mcp.context7.com/mcp' };
  await scenario.json(scenario.stateFile, { mcpServers: { context7: registration } });
  await scenario.json(path.join(scenario.claudeRoot, 'plugins/known_marketplaces.json'), {
    'claude-plugins-official': { source: { repo: 'foreign/repo' } },
  });
  const plan = await scenario.ccw.plan({
    task: 'install',
    selected: [{ id: 'plugin:context7@claude-plugins-official' }],
  });
  assert.equal(plan.items[0].problem, 'marketplace-source-conflict');
  await scenario.ccw.apply(plan.id);
  assert.deepEqual((await scenario.readJson(scenario.stateFile)).mcpServers.context7, registration);
});

test('Claude 安装失败不切换渠道，GitHub 和 Context7 插件均跳过', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  scenario.state.fail = 'npm:install';
  const plan = await scenario.ccw.plan({
    task: 'install',
    selected: [
      { id: 'claude' },
      { id: 'plugin:github@claude-plugins-official' },
      { id: 'plugin:context7@claude-plugins-official' },
    ],
  });
  const result = await scenario.ccw.apply(plan.id);
  assert.equal(result.state, 'failed', JSON.stringify(result));
  assert.notEqual(result.items.find(i => i.id === 'claude').state, 'done');
  assert.notEqual(result.items.find(i => i.id.startsWith('plugin:')).state, 'done');
  assert.equal(result.items.find(i => i.id === 'plugin:context7@claude-plugins-official').state, 'skipped');
  assert.equal(await exists(scenario.native), false);
});

// 工具与用户内容：保留已有修改，失败后允许重试
test('重复配置 CCometixLine 保留外观和子代理状态栏', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  const config = path.join(scenario.home, '.claude/ccline/config.toml');
  await scenario.write(config, '# custom appearance\n');
  await scenario.json(scenario.settings, { subagentStatusLine: { type: 'command', command: 'my-subagent-status' } });
  for (let i = 0; i < 2; i++)
    assert.equal((await scenario.apply({ task: 'install', selected: [{ id: 'ccline' }] })).state, 'done');
  assert.equal(await fs.readFile(config, 'utf8'), '# custom appearance\n');
  assert.equal((await scenario.readJson(scenario.settings)).subagentStatusLine.command, 'my-subagent-status');
});

test('本地修改的 Skill 与状态栏不覆盖', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  assert.equal((await scenario.apply({ task: 'install', selected: [{ id: 'skill:amirc-research' }] })).state, 'done');
  await scenario.write(path.join(scenario.claudeRoot, 'skills/amirc-research/SKILL.md'), 'local edits');
  await scenario.json(scenario.settings, {
    statusLine: { type: 'command', command: 'user-status' },
    subagentStatusLine: { type: 'command', command: 'user-subagent' },
  });
  const plan = await scenario.ccw.plan({
    task: 'install',
    selected: [{ id: 'skill:amirc-research' }, { id: 'ccline' }],
  });
  assert.equal(plan.items[0].problem, 'local-edits-preserved');
  assert.ok(plan.items[1].problem);
  await scenario.ccw.apply(plan.id);
  assert.equal(
    await fs.readFile(path.join(scenario.claudeRoot, 'skills/amirc-research/SKILL.md'), 'utf8'),
    'local edits',
  );
  assert.equal((await scenario.readJson(scenario.settings)).statusLine.command, 'user-status');
});

for (const task of ['install', 'uninstall']) {
  test('CCometixLine 保留异形状态栏字段：' + task, async testContext => {
    const scenario = await createInstallationScenario(testContext);
    await scenario.apply({ task: 'install', selected: [{ id: 'ccline' }] });
    const statusLine = { type: 'command', command: ['ccline'] };
    await scenario.json(scenario.settings, { statusLine });
    const plan = await scenario.ccw.plan({ task, selected: [{ id: 'ccline' }] });
    assert.equal(plan.items[0].problem, task === 'install' ? 'local-edits-preserved' : null);
    const result = await scenario.ccw.apply(plan.id);
    assert.equal(result.state, task === 'install' ? 'failed' : 'done');
    assert.deepEqual((await scenario.readJson(scenario.settings)).statusLine, statusLine);
  });
}

test('OfficeCLI 写入权限失败保留真实原因，解除问题后可以重试', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  scenario.state.fail = 'replace-file';
  const request = { task: 'install', selected: [{ id: 'officecli' }] };
  const failed = await scenario.apply(request);
  assert.equal(failed.state, 'failed');
  assert.ok(failed.items[0].effects.some(effect => effect.state === 'failed' && effect.code === 'EACCES'));
  assert.ok(!failed.items[0].effects.some(effect => effect.code === 'program-changed'));
  assert.ok(!failed.items[0].effects.some(effect => effect.code === 'program-removed'));
  scenario.state.fail = '';
  assert.equal((await scenario.apply(request)).state, 'done');
});

test('OfficeCLI 写入后回执丢失，由统一步骤核验实际结果', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  scenario.state.fail = 'replace-after-write';
  const result = await scenario.apply({ task: 'install', selected: [{ id: 'officecli' }] });
  assert.equal(result.state, 'done');
  assert.ok(!result.items[0].effects.some(effect => effect.state === 'failed'));
  assert.ok(await exists(path.join(scenario.claudeRoot, 'skills/officecli/SKILL.md')));
});

// 操作边界：拒绝无效目标和不支持的动作
test('拒绝不支持的动作和整目录删除参数', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  for (const input of [
    { task: 'cleanup', selected: [] },
    { task: 'install', selected: [{ id: 'claude', action: 'reinstall' }] },
    { task: 'uninstall', selected: [], removeData: true },
  ])
    await assert.rejects(scenario.ccw.plan(input), /action-unavailable/);
});

for (const task of ['install', 'uninstall'])
  test(`未知 CCometixLine 标识：${task} 在读取程序前拒绝`, async testContext => {
    const scenario = await createInstallationScenario(testContext);
    const before = scenario.calls.length;
    const plan = await scenario.ccw.plan({ task, selected: [{ id: 'ccline:unknown' }] });
    assert.equal(plan.items[0].problem, 'unknown-selection');
    assert.equal(scenario.calls.length, before);
    assert.equal((await scenario.ccw.apply(plan.id)).state, 'failed');
  });

for (const cclineOutput of ['ccline 2.0.10', 'ccline 2.0.1-beta'])
  test('CCometixLine 精确版本核验拒绝前缀匹配：' + cclineOutput, async testContext => {
    const scenario = await createInstallationScenario(testContext, { cclineOutput });
    const result = await scenario.apply({ task: 'install', selected: [{ id: 'ccline' }] });
    assert.equal(result.state, 'partial');
    assert.ok(result.items[0].effects.some(effect => effect.code === 'binary-version-mismatch'));
    assert.equal((await scenario.readJson(scenario.settings)).statusLine, undefined);
  });

// 结果核验：各项独立确认，保留已完成事实
test('逐项最终核验拥有独立预算，较慢查询不会让后续项目误报超时', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  let now = 0;
  let final = false;
  let checked = 0;
  testContext.mock.method(performance, 'now', () => now);
  scenario.state.onNpm = args => {
    if (final && args[0] === 'ls') now += 3000;
  };
  const plan = await scenario.ccw.plan({ task: 'install', selected: [{ id: 'claude' }, { id: 'ccline' }] });
  assert.ok(plan.items.every(item => item.problem === null));
  const result = await scenario.ccw.apply(plan.id, undefined, event => {
    if (event.kind === 'checked' && ++checked === 2) final = true;
  });
  assert.equal(result.state, 'done', JSON.stringify(result));
});

test('已经安装完成的插件不因随后 Claude 核验失败而被降为部分完成', async testContext => {
  const scenario = await createInstallationScenario(testContext);
  let final = false;
  let checked = 0;
  scenario.state.onNpm = args => {
    if (final && args[0] === 'ls') throw new Error('inspection-timeout');
  };
  const plan = await scenario.ccw.plan({
    task: 'install',
    selected: [{ id: 'claude' }, { id: 'plugin:github@claude-plugins-official' }],
  });
  const result = await scenario.ccw.apply(plan.id, undefined, event => {
    if (event.kind === 'checked' && ++checked === 2) final = true;
  });
  assert.equal(result.items.find(item => item.id === 'claude').state, 'partial');
  assert.equal(result.items.find(item => item.id.startsWith('plugin:')).state, 'done', JSON.stringify(result));
});
