import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCcw } from '../dist/ccw.js';
import { createMachine } from '../dist/machine.js';

/** 构造命令/npm 成功结果：code 0、failed false、stdout 默认空串 */
export const ok = (stdout = '') => ({ code: 0, stdout, failed: false });
/** 构造命令/npm 失败结果：code 1、空 stdout、failed false */
export const fail = () => ({ code: 1, stdout: '', failed: false });
/** 测试共享的等待桩：不渲染界面，直接在取消作用域内执行任务 */
export const wait = (_title, work) => work(new AbortController().signal);
/** 测试共享的固定 git 修订单（40 位十六进制） */
export const revision = '0123456789abcdef0123456789abcdef01234567';
/** 完整市场快照及相对插件载荷，供 Git/Claude CLI 边界 fixture 使用。 */
export function pluginMarketplaceFiles(
  names = ['code-simplifier', 'frontend-design', 'github', 'mcp-server-dev', 'skill-creator'],
) {
  return [
    {
      path: '.claude-plugin/marketplace.json',
      data: Buffer.from(
        JSON.stringify({
          name: 'claude-plugins-official',
          plugins: names.map(name => ({ name, source: `./plugins/${name}` })),
        }),
      ),
    },
    ...names.map(name => ({ path: `plugins/${name}/.claude-plugin/plugin.json`, data: Buffer.from('{}') })),
  ];
}
/** 测试共享的无归属环境注记：不携带 commit、PR 与会话链接 */
export const attribution = { commit: '', pr: '', sessionUrl: false };
/** 判定路径存在性：stat 成功即存在 */
export const exists = file =>
  fs.stat(file).then(
    () => true,
    () => false,
  );
/** 种子二进制 fixture：建父目录后写入内容 */
export const seedBinary = async (file, content) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
};
/** 筛选 f.calls 中目标子命令的 npm 调用记录 */
export const npmOf = (f, target) => f.calls.filter(call => call.kind === 'npm' && call.target === target);
/** 解析 npm 参数中的 --registry（= 内联与独立两形态）：无则 null，尾斜杠归一 */
export function registryOf(args) {
  const inline = args.find(value => value.startsWith('--registry='));
  if (inline !== undefined) return inline.slice('--registry='.length).replace(/\/$/, '');
  const index = args.indexOf('--registry');
  return index < 0 ? null : (args[index + 1]?.replace(/\/$/, '') ?? null);
}
/** 解析 npm 参数中的 --<scope>:registry（= 内联与独立两形态）：无则 null，尾斜杠归一 */
export function scopedRegistryOf(args, scope) {
  const option = `--${scope}:registry`;
  const inline = args.find(value => value.startsWith(`${option}=`));
  if (inline !== undefined) return inline.slice(option.length + 1).replace(/\/$/, '');
  const index = args.indexOf(option);
  return index < 0 ? null : (args[index + 1]?.replace(/\/$/, '') ?? null);
}
/** Model only the public registry getters used to freeze npm metadata and installation sources. */
export function npmConfig(args, registry = 'https://registry.npmjs.org') {
  if (args.length !== 3 || args[0] !== 'config' || args[1] !== 'get') throw new Error('unexpected npm config command');
  if (args[2] === 'registry') return ok(registry);
  if (/^@[a-z0-9._-]+:registry$/i.test(args[2])) return ok('undefined');
  throw new Error('unexpected npm config key');
}
/** 构造 npm 世界应答器：ls/root/view/install/uninstall 共性集中，差异经策略参数暴露，返回 {npm, state} */
export function npmWorld({
  package: name,
  npmRoot,
  state: given = null,
  version = null,
  installVersion = version,
  view = null,
  install = null,
  binary = null,
  binaryContent = 'fixture binary',
  bin = null,
  lsOnRequest = false,
  onCommand = null,
  onInstall = null,
  failCommand = null,
}) {
  const state = given ?? { version, npmRoot };
  const npm = async args => {
    if (onCommand) await onCommand(args);
    if (failCommand !== null && args[0] === failCommand(args)) return fail();
    if (args[0] === 'config') return npmConfig(args);
    if (args[0] === 'ls')
      return ok(
        JSON.stringify({
          dependencies:
            state.version === null || (lsOnRequest && !args.includes(name))
              ? {}
              : { [name]: { version: state.version } },
        }),
      );
    if (args[0] === 'root') return ok(state.npmRoot);
    if (args[0] === 'view') return view ? view(args) : fail();
    if (args[0] === 'install') {
      if (install === 'fail') return fail();
      if (typeof install === 'function') return install(state, args);
      if (onInstall) onInstall(args);
      state.version = installVersion;
      if (bin) {
        await seedBinary(
          path.join(npmRoot, name, 'package.json'),
          JSON.stringify({ name, version: state.version, bin }),
        );
        await seedBinary(path.join(npmRoot, name, Object.values(bin)[0]), binaryContent);
      } else if (binary) {
        await seedBinary(binary, binaryContent);
      }
      return ok();
    }
    if (args[0] === 'uninstall') {
      state.version = null;
      return ok();
    }
    throw new Error(`unexpected npm command: ${args[0]}`);
  };
  return { npm, state };
}
/** 构造 --version 探针应答器：命中 binary（node 模式经 execPath）返回 output，before 逃生舱优先，其余 fail 或抛错 */
export function versionProbe({ binary, node = false, output = 'ccline 2.0.1', before = null, otherwise = null } = {}) {
  const respond = typeof output === 'function' ? output : () => output;
  return async (executable, args, options) => {
    if (before) {
      const override = await before(executable, args, options);
      if (override !== undefined) return override;
    }
    const hit = node
      ? executable === process.execPath && args[0] === binary && args[1] === '--version'
      : (binary === undefined || executable === binary) && args[0] === '--version';
    if (!hit) {
      if (otherwise === 'throw') throw new Error(`unexpected command: ${executable} ${args.join(' ')}`);
      return fail();
    }
    return ok(respond());
  };
}
/** 构造 GitHub release 合同 fetchText：latest 摘要、SHA256SUMS、tag ref 三端点合一；network 记录 URL，also 兜底其余端点 */
export function releaseContract({ tag, asset, digest, revision, network = null, also = null }) {
  const release = `https://github.com/iOfficeAI/OfficeCLI/releases/download/${tag}/`;
  const fetchText = async url => {
    if (network) network.push(url);
    if (url === 'https://api.github.com/repos/iOfficeAI/OfficeCLI/releases/latest')
      return JSON.stringify({
        draft: false,
        prerelease: false,
        tag_name: tag,
        assets: [
          { name: asset, browser_download_url: release + asset, digest: `sha256:${digest}` },
          { name: 'SHA256SUMS', browser_download_url: release + 'SHA256SUMS' },
        ],
      });
    if (url === release + 'SHA256SUMS') return `${digest}  ${asset}\n`;
    if (url === `https://api.github.com/repos/iOfficeAI/OfficeCLI/git/ref/tags/${tag}`)
      return JSON.stringify({ ref: `refs/tags/${tag}`, object: { type: 'commit', sha: revision } });
    if (also) return also(url);
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetchText, release };
}

export async function createEnv(t, { layout = 'home', seed = {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccw-env-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = layout === 'home' ? path.join(root, 'home') : root;
  const claudeRoot = layout === 'home' ? path.join(home, '.claude') : path.join(root, 'claude');
  const stateFile = layout === 'home' ? path.join(home, '.claude.json') : path.join(claudeRoot, '.claude.json');
  const settingsFile = path.join(claudeRoot, 'settings.json');
  const cclineRoot = path.join(claudeRoot, 'ccline');
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  };
  const json = (file, value) => write(file, JSON.stringify(value));
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const roles = { settings: settingsFile, state: stateFile };
  for (const [role, value] of Object.entries(seed)) await json(roles[role] ?? path.join(claudeRoot, role), value);

  const calls = [];
  const faults = { editJson: new Map(), npm: new Map(), execute: new Map() };
  const intercept = async fault => {
    if (fault instanceof Error) throw fault;
    if (fault !== undefined) await fault();
  };

  function machine(overrides = {}) {
    const base = createMachine({}, root);
    return {
      ...base,
      locate: overrides.locate ?? (async () => []),
      ...(overrides.read ? { read: file => overrides.read(file, base) } : {}),
      ...(overrides.processes ? { processes: overrides.processes } : {}),
      npm: async (args, options) => {
        calls.push({ kind: 'npm', target: args[0], args: [...args], options });
        await intercept(faults.npm.get(args[0]));
        if (!overrides.npm) throw new Error(`unexpected npm command: ${args[0]}`);
        return overrides.npm(args, options, base);
      },
      execute: async (file, args, options) => {
        calls.push({ kind: 'execute', target: file, args: [...args], options });
        await intercept(faults.execute.get(file));
        if (!overrides.execute) throw new Error(`unexpected execute command: ${file}`);
        return overrides.execute(file, args, options, base);
      },
      editJson: async (file, edit) => {
        calls.push({ kind: 'editJson', target: file, args: [] });
        await intercept(faults.editJson.get(file));
        return (overrides.editJson ?? ((target, change) => base.editJson(target, change)))(file, edit);
      },
    };
  }

  const ccw = (machine, opts = {}) =>
    createCcw({ machine, home, claudeRoot, cclineRoot, platform: opts.platform ?? process.platform });

  return {
    root,
    home,
    claudeRoot,
    settingsFile,
    stateFile,
    cclineRoot,
    write,
    json,
    read,
    calls,
    faults,
    machine,
    ccw,
  };
}
