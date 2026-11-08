import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function packageRuntime() {
  const scratch = path.join(source, '.scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const destination = fs.mkdtempSync(path.join(scratch, 'runtime-0.4.0-'));
  for (const file of ['package.json', 'package-lock.json'])
    fs.copyFileSync(path.join(source, file), path.join(destination, file));
  for (const name of ['ccw']) {
    const workspace = path.join(destination, 'packages', name);
    fs.mkdirSync(workspace, { recursive: true });
    for (const entry of ['dist', 'package.json', 'assets'])
      fs.cpSync(path.join(source, 'packages', name, entry), path.join(workspace, entry), { recursive: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
    pkg.private = true;
    for (const field of ['devDependencies', 'files', 'publishConfig', 'scripts']) delete pkg[field];
    fs.writeFileSync(path.join(workspace, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    if (pkg.private !== true || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('invalid-runtime-package');
  }
  const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  // React 类型同时是 Ink 的可选 peer；两类均排除，避免类型与开发工具进入运行包
  execFileSync(
    process.execPath,
    [npm, 'ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'],
    { cwd: destination, windowsHide: true, stdio: 'pipe' },
  );
  fs.writeFileSync(
    path.join(destination, 'README.md'),
    '# CCW 0.4.0\n\n运行 `node packages/ccw/dist/main.js`，进入安装套件、检查套件、卸载套件或清理数据。\n安装直接执行；卸载和清理先预览确认。准备时显示当前步骤，Esc 取消准备。↑↓ 移动，空格选择，A 全选普通项，Enter 编辑或提交，Esc 返回；长详情使用 PgUp/PgDn。\n包含 CCometixLine 外观资产、AMIRC Research Skill 和生产依赖。运行 CCW 期间需保留本目录与 Node.js；已安装的 Skill 使用独立副本。其他安装来源需要网络及所选渠道的工具。\n',
  );
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(`${packageRuntime()}\n`);
