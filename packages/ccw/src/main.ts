#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';

import { createCcw } from './ccw.js';
import { collectLogs } from './collect.js';
import { acquireInstance } from './instance.js';
import type { CcwOptions } from './model.js';
import { createMachine, errorCode, isObject } from './machine.js';
import { BRAND, describeInspection, HELP_TEXT, startupFailure } from './render.js';
import { runTerminal } from './terminal.js';
import { createTerminal } from './terminal-view.js';

/** CLI 模式清单单一出处：新增模式仍需人工同步 errors.ts 与 HELP_TEXT 的散文枚举 */
const CLI_MODES = ['--help', '--version', '--inspect', '--collect-logs'] as const;
const CLI_MODE_VALUES: readonly string[] = CLI_MODES;
type Mode = (typeof CLI_MODES)[number] | undefined;
const isMode = (value: string): value is (typeof CLI_MODES)[number] => CLI_MODE_VALUES.includes(value);
function parseArguments(args: readonly string[]): { mode: Mode; hasDetails: boolean } {
  let mode: Mode;
  let hasDetails = false;
  for (const argument of args) {
    if (argument === '--details' && !hasDetails) hasDetails = true;
    else if (isMode(argument) && mode === undefined) mode = argument;
    else throw new Error('unknown-argument');
  }
  return { mode, hasDetails };
}

async function main() {
  const { mode: argument, hasDetails } = parseArguments(process.argv.slice(2));
  if (argument === '--version') {
    process.stdout.write(`${BRAND.versionNumber}\n`);
    return;
  }
  if (argument === '--help') {
    process.stdout.write(HELP_TEXT);
    return;
  }
  const instance = await acquireInstance();
  try {
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
    const options: CcwOptions = {
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
    };
    const ccw = createCcw(options);
    if (argument === '--inspect') {
      const view = await ccw.inspect();
      process.stdout.write(`${describeInspection(view, hasDetails)}\n`);
      if (view.problems.length || view.items.some(item => item.problem)) process.exitCode = 1;
      return;
    }
    if (argument === '--collect-logs') {
      const collected = await collectLogs(ccw, options);
      process.stdout.write(`${collected.summary}\n`);
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
  } finally {
    await instance.release();
  }
}

main().catch(error => {
  process.stderr.write(`${startupFailure(errorCode(error), process.argv.slice(2).includes('--details'))}\n`);
  process.exitCode = 1;
});
