import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 本包固定生成目录先清空，退役模块不会残留进入运行包。
rmSync(new URL('./dist/', import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, [fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  windowsHide: true,
  stdio: 'inherit',
});
