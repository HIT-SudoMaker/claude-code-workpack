#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';

import { createCcw } from './ccw.js';
import { createMachine, errorCode, isObject } from './machine.js';
import { BRAND, describeInspection, HELP_TEXT, startupFailure } from './render.js';
import { runTerminal } from './terminal.js';
import { createTerminal } from './terminal-view.js';

function parseArguments(args: readonly string[]) {
  let mode: '--help' | '--version' | '--inspect' | undefined;
  let hasDetails = false;
  for (const argument of args) {
    if (argument === '--details' && !hasDetails) hasDetails = true;
    else if ((argument === '--help' || argument === '--version' || argument === '--inspect') && mode === undefined)
      mode = argument;
    else throw new Error('unknown-argument');
  }
  return mode;
}

async function main() {
  const argument = parseArguments(process.argv.slice(2));
  if (argument === '--version') {
    process.stdout.write(`${BRAND.version.slice(1)}\n`);
    return;
  }
  if (argument === '--help') {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (argument === undefined && !process.stdin.isTTY) throw new Error('interactive-terminal-required');
  if (process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('unsupported-platform');
  const home = os.homedir();
  const claudeConfig = process.env.CLAUDE_CONFIG_DIR?.trim();
  const claudeRoot = path.resolve(claudeConfig || path.join(home, '.claude'));
  const report = process.platform === 'linux' ? process.report.getReport() : undefined;
  const machineArch = os.machine();
  const libc: 'glibc' | 'musl' =
    isObject(report) && isObject(report.header) && typeof report.header.glibcVersionRuntime === 'string'
      ? 'glibc'
      : 'musl';
  const abort = new AbortController();
  const stop = () => {
    abort.abort();
  };
  const terminal = argument === undefined ? createTerminal(stop) : undefined;
  const ccw = createCcw({
    machine: createMachine(process.env, process.cwd(), terminal ? work => terminal.handoff(work) : undefined),
    home,
    claudeRoot,
    cclineRoot: path.resolve(process.env.CCLINE_HOME?.trim() || path.join(home, '.claude/ccline')),
    claudeState: path.join(claudeConfig ? claudeRoot : home, '.claude.json'),
    inheritedKeys: Object.keys(process.env),
    ...(process.platform === 'win32' && process.env.LOCALAPPDATA ? { localAppData: process.env.LOCALAPPDATA } : {}),
    ...(process.platform === 'win32' && process.env.SCOOP ? { scoopRoot: process.env.SCOOP } : {}),
    arch: /arm64|aarch64/i.test(machineArch) ? 'arm64' : /x86_64|amd64|x64/i.test(machineArch) ? 'x64' : process.arch,
    ...(process.platform === 'linux' ? { libc } : {}),
    platform: process.platform,
  });
  if (argument === '--inspect') {
    const view = await ccw.inspect();
    process.stdout.write(`${describeInspection(view)}\n`);
    if (view.problems.length || view.items.some(item => item.problem)) process.exitCode = 1;
    return;
  }
  if (!terminal) return;
  process.on('SIGINT', stop);
  try {
    await runTerminal(ccw, terminal, abort.signal);
  } finally {
    process.off('SIGINT', stop);
    await terminal.close();
  }
}

main().catch(error => {
  process.stderr.write(`${startupFailure(errorCode(error), process.argv.slice(2).includes('--details'))}\n`);
  process.exitCode = 1;
});
