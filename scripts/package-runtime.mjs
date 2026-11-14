import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function packageRuntime() {
  const scratch = path.join(source, '.scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const destination = fs.mkdtempSync(path.join(scratch, 'runtime-'));
  for (const file of ['package.json', 'package-lock.json', 'LICENSE'])
    fs.copyFileSync(path.join(source, file), path.join(destination, file));
  const workspace = path.join(destination, 'packages/ccw');
  fs.mkdirSync(workspace, { recursive: true });
  for (const entry of ['dist', 'package.json', 'assets'])
    fs.cpSync(path.join(source, 'packages/ccw', entry), path.join(workspace, entry), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('invalid-runtime-package');
  pkg.private = true;
  for (const field of ['devDependencies', 'files', 'publishConfig', 'scripts']) delete pkg[field];
  fs.writeFileSync(path.join(workspace, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  // React 类型同时是 Ink 的可选 peer；两类均排除，避免类型与开发工具进入运行包
  execFileSync(
    process.execPath,
    [npm, 'ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'],
    { cwd: destination, windowsHide: true, stdio: 'pipe' },
  );
  fs.writeFileSync(
    path.join(destination, 'README.md'),
    '# CCW\n\n运行 `node packages/ccw/dist/main.js`，进入安装配置、检查状态、移除程序或清理数据。\n已有项目自动更新；所有变更先预览确认。↑↓ 移动，空格勾选，A 全选，Enter 继续，Esc 返回；长内容使用 PgUp/PgDn。移除程序保留会话记录和个人文件，清理数据会永久删除所选类别的数据。\n包含 CCometixLine 外观资产、AMIRC Research Skill 和生产依赖。运行 CCW 期间需保留本目录与 Node.js；已安装的 Skill 使用独立副本。获取程序和扩展需要网络；Serena 通过官方插件安装，服务由插件声明的 uvx 启动。\n',
  );
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(`${packageRuntime()}\n`);
