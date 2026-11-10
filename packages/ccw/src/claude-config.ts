import { prepareSettings } from './settings.js';
export { createSettingsDomain, ENABLED_PLUGINS_KEY } from './settings.js';
import { knownTitle } from './titles.js';
import { errorCode } from './machine.js';
import { sequence } from './model.js';
import type { Context, Domain, Effect, Inspection, Prepared, Selection } from './model.js';
import { prepareProgram, programs } from './programs.js';

/** 程序步骤失败：保留原错误的续办语义，同时撤回本次依赖执行资格。 */
export class ClaudeProgramVerificationError extends Error {
  constructor(cause: unknown) {
    super(errorCode(cause), { cause });
  }
}

/** 程序步骤单独拥有失败标签；默认设置失败不撤回已经确认的程序资格。 */
function verifiedClaudeProgram(initial: Prepared): Prepared {
  let current = initial;
  const operation: Prepared = {
    ...(initial.writes === undefined ? {} : { writes: initial.writes }),
    get changes() {
      return current.changes;
    },
    async run(report, signal) {
      try {
        await current.run?.(report, signal);
      } catch (error) {
        throw new ClaudeProgramVerificationError(error);
      }
    },
    remaining() {
      const rest = current.remaining ? current.remaining() : current;
      if (rest === undefined) return undefined;
      current = rest;
      return operation;
    },
    async verify() {
      try {
        await current.verify?.();
      } catch (error) {
        throw new ClaudeProgramVerificationError(error);
      }
    },
  };
  return operation;
}

/** 创建 Claude 程序域渠道：裸 id 与 claude: 余段 id 都归本域 */
export function createClaudeDomain(ctx: Context): Domain {
  return {
    inspect: () => inspectClaudePrograms(ctx),
    prepare: selection => prepareClaudeProgram(ctx, selection),
  };
}

/** 检查 Claude 程序：实际副本，或无副本时的同形方案壳 */
async function inspectClaudePrograms(ctx: Context): Promise<Inspection> {
  const found = await programs(ctx, 'claude');
  return {
    items: found.items.length
      ? found.items
      : [
          {
            id: 'claude',
            title: knownTitle('claude'),
            kind: 'claude',
            canInstall: true,
            facts: [{ code: found.problems.length ? 'inspection-incomplete' : 'not-installed' }],
            actions: ['install'],
          },
        ],
    problems: found.problems.map(code => ({ code, detail: 'claude' })),
  };
}

/** 编排 Claude 程序准备：实例解析、保留分支复核与默认偏好合并 */
async function prepareClaudeProgram(ctx: Context, selection: Selection): Promise<Prepared> {
  const { id, action } = selection;
  const kind = 'claude';
  const found = await programs(ctx, kind);
  const program =
    found.values.get(id) ?? (id === kind && found.values.size === 1 ? [...found.values.values()][0] : undefined);
  if (id !== kind && program === undefined) throw new Error('program-changed');
  if (id === kind && found.values.size > 1) throw new Error('program-selection-required');
  if (found.problems.length && !(action === 'uninstall' && program && program.channel !== 'npm'))
    throw new Error('installation-state-unconfirmed');
  if (action === 'detach') throw new Error('action-unavailable');
  const programStamp = program ? await ctx.machine.treeStamp(program.binary) : null;
  // 两次读取之间二进制消失时不允许"保留程序"空转通过
  if (action === 'install' && program && !program.isMissing && programStamp === null)
    throw new Error('program-changed');
  const operation =
    action === 'install' && program && !program.isMissing
      ? {
          targetVersion: program.version,
          changes: [{ code: 'program-kept' }],
          async run(report: (effect: Effect) => void) {
            if ((await ctx.machine.treeStamp(program.binary)) !== programStamp) throw new Error('program-changed');
            report({ state: 'kept', code: 'program-kept' });
          },
          async verify() {
            if ((await ctx.machine.treeStamp(program.binary)) !== programStamp) throw new Error('program-changed');
          },
        }
      : await prepareProgram(ctx, kind, selection, program);
  if ((action !== 'install' && action !== 'reinstall') || (action === 'install' && program && !program.isMissing))
    return operation;
  const programStep = verifiedClaudeProgram(operation);
  const defaults = await prepareSettings(ctx, { id: 'settings', action: 'configure' });
  const assess = async () => {
    await programStep.verify?.();
    await defaults.verify?.();
  };
  return sequence([programStep, defaults, { changes: [], run: assess, verify: assess }]);
}
