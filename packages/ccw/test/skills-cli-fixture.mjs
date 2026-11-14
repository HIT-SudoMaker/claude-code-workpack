import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ok, fail } from './test-environment.mjs';

const CLI_PREFIX = ['exec', '--yes', '--package=skills@1.8.1', '--', 'skills'];
const REMOVE_FLAGS = ['--global', '--agent', 'claude-code', '--yes'];
const INSTALL_FLAGS = ['--agent', 'claude-code', '--global', '--yes', '--copy', '--json'];

// 模拟官方 CLI 接口，使用独立测试数据构造安装内容
export function createSkillsCliFixture(workspace) {
  const state = {
    names: { mattpocock: ['tdd', 'code-review'], ssre2: ['ssre2-design', 'ssre2-review'], bundled: ['amirc-research'] },
    failSource: false,
    failAfter: Infinity,
    removeAfter: Infinity,
    generation: 'first',
    afterWrite: undefined,
  };
  async function npm(args, options) {
    assert.deepEqual(args.slice(0, CLI_PREFIX.length), CLI_PREFIX);
    const [operation, source] = args.slice(CLI_PREFIX.length);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, workspace.claudeRoot);
    assert.equal(options.env.XDG_STATE_HOME, path.join(workspace.home, '.ccw'));
    if (operation === 'remove') {
      assert.equal(options.env.HOME, path.join(workspace.home, '.ccw/skills-cli'));
      assert.equal(options.env.USERPROFILE, options.env.HOME);
      assert.deepEqual(args.slice(-REMOVE_FLAGS.length), REMOVE_FLAGS);
      const names = args.slice(CLI_PREFIX.length + 1, -REMOVE_FLAGS.length);
      for (const [index, name] of names.entries()) {
        if (index >= state.removeAfter) return fail();
        await fs.rm(path.join(workspace.claudeRoot, 'skills', name), { recursive: true, force: true });
      }
      const lockFile = path.join(options.env.XDG_STATE_HOME, 'skills/.skill-lock.json');
      const lock = await fs.readFile(lockFile, 'utf8').then(JSON.parse, () => ({ version: 3, skills: {} }));
      for (const name of names) delete lock.skills[name];
      await workspace.json(lockFile, lock);
      return ok();
    }
    assert.equal(operation, 'a');
    assert.equal(options.env.HOME, undefined);
    const group = source.includes('mattpocock') ? 'mattpocock' : source.includes('ssre2-skills') ? 'ssre2' : 'bundled';
    if (group !== 'bundled') assert.match(source, /\/tree\/[a-f0-9]{40}\//);
    const selectedFolder = path.posix.basename(source.replaceAll('\\', '/'));
    let names = [...state.names[group]];
    if (names.includes(selectedFolder)) names = [selectedFolder];
    if (args.at(-1) === '--list') {
      if (state.failSource) return fail();
      return ok(
        '│\n◇  Available Skills\n' +
          names.map(name => `│    ${name}\n│      Fixture description`).join('\n') +
          '\n└  Use --skill <name> to install specific skills\n',
      );
    }
    assert.deepEqual(args.slice(-INSTALL_FLAGS.length), INSTALL_FLAGS);
    assert.ok(args.includes('--skill'));
    assert.ok(!args.includes('--all'));
    const selection = args.slice(args.indexOf('--skill') + 1, args.indexOf('--agent'));
    if (!selection.includes('*')) names = names.filter(name => selection.includes(name));
    const results = [];
    for (const [index, name] of names.entries()) {
      if (index >= state.failAfter) {
        results.push({ name, status: 'failed', error: 'fixture failure' });
        continue;
      }
      const directory = path.join(workspace.claudeRoot, 'skills', name.toLowerCase().replaceAll(' ', '-'));
      await workspace.write(
        path.join(directory, 'SKILL.md'),
        `---\nname: ${name}\ndescription: fixture\n---\n${state.generation}\n`,
      );
      await workspace.write(path.join(directory, 'assets/icon.bin'), Buffer.from([0, 128, 255]));
      results.push({
        name,
        status: 'installed',
        path: directory,
        scope: 'global',
        mode: 'copy',
        agents: ['Claude Code'],
      });
      await state.afterWrite?.(name);
    }
    const lockFile = path.join(options.env.XDG_STATE_HOME, 'skills/.skill-lock.json');
    const lock = await fs.readFile(lockFile, 'utf8').then(JSON.parse, () => ({ version: 3, skills: {} }));
    for (const item of results.filter(item => item.status === 'installed'))
      lock.skills[item.name] = {
        source:
          group === 'mattpocock' ? 'mattpocock/skills' : group === 'ssre2' ? 'HIT-SudoMaker/ssre2-skills' : source,
        sourceType: group === 'bundled' ? 'local' : 'github',
      };
    await workspace.json(lockFile, lock);
    return { ...ok(JSON.stringify(results)), code: results.some(result => result.status === 'failed') ? 1 : 0 };
  }
  return { state, npm };
}
