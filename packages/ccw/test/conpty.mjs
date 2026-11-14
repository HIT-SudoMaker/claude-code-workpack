import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMPILE_TIMEOUT_MS = 20_000;
const SCENARIO_TIMEOUT_MS = 30_000;

export function compileConpty(directory) {
  const executable = path.join(directory, 'conpty.exe');
  const compiler = path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(
    compiler,
    ['/nologo', '/utf8output', `/out:${executable}`, fileURLToPath(new URL('./windows-conpty.cs', import.meta.url))],
    { windowsHide: true, timeout: COMPILE_TIMEOUT_MS },
  );
  return executable;
}

export function runConpty(executable, fixture, scenario, cwd) {
  return execFileSync(executable, [process.execPath, fixture, scenario], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: SCENARIO_TIMEOUT_MS,
    cwd,
  });
}
