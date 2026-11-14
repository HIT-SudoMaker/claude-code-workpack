import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCcw } from '../dist/ccw.js';
import { createMachine } from '../dist/machine.js';

export { releaseContract } from './office-release.mjs';

/** 构造命令/npm 成功结果：code 0、failed false、stdout 默认空串 */
export const ok = (stdout = '') => ({ code: 0, stdout, failed: false });
/** 构造命令/npm 失败结果：code 1、空 stdout、failed false */
export const fail = () => ({ code: 1, stdout: '', failed: false });
export const revision = '0123456789abcdef0123456789abcdef01234567';
/** 判定路径存在性：stat 成功即存在 */
export const exists = file =>
  fs.stat(file).then(
    () => true,
    () => false,
  );
/** 模拟 npm 公共配置查询，供版本与安装来源核验使用 */
export function npmConfig(args, registry = 'https://registry.npmjs.org') {
  if (args.length !== 3 || args[0] !== 'config' || args[1] !== 'get') throw new Error('unexpected npm config command');
  if (args[2] === 'registry') return ok(registry);
  if (/^@[a-z0-9._-]+:registry$/i.test(args[2])) return ok('undefined');
  throw new Error('unexpected npm config key');
}
/** 创建本测试专用目录，并在测试结束后清理 */
export async function createTemporaryDirectory(testContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccw-env-')));
  testContext.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** 创建隔离文件目录、配置样本和可记录命令的测试环境 */
export async function createTestEnvironment(testContext, { layout = 'home', seed = {} } = {}) {
  const root = await createTemporaryDirectory(testContext);
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
  const faults = { editJson: new Map() };
  const intercept = async fault => {
    if (fault instanceof Error) throw fault;
    if (fault !== undefined) await fault();
  };

  function machine(overrides = {}) {
    const base = createMachine({}, root);
    return {
      ...base,
      // 模拟 npm 身份，避免测试依赖宿主的安装位置
      npmIdentity: async () => ({ entry: 'test-npm', binary: 'test-npm', stamp: 'test-npm' }),
      locate: overrides.locate ?? (async () => []),
      ...(overrides.read ? { read: file => overrides.read(file, base) } : {}),
      ...(overrides.processes ? { processes: overrides.processes } : {}),
      npm: async (args, options) => {
        calls.push({ kind: 'npm', target: args[0], args: [...args], options });
        if (!overrides.npm) throw new Error(`unexpected npm command: ${args[0]}`);
        return overrides.npm(args, options, base);
      },
      execute: async (file, args, options) => {
        calls.push({ kind: 'execute', target: file, args: [...args], options });
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
    createCcw({ machine, home, claudeRoot, cclineRoot, ...opts, platform: opts.platform ?? process.platform });

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
