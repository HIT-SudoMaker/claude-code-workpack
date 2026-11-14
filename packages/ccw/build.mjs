import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 清空生成目录，避免退役模块进入运行包
rmSync(new URL('./dist/', import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, [fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  windowsHide: true,
  stdio: 'inherit',
});
