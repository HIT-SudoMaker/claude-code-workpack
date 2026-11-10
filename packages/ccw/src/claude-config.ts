import { prepareSettings } from './settings.js';
export { createSettingsDomain, ENABLED_PLUGINS_KEY } from './settings.js';
import { knownTitle } from './titles.js';
import type { Context, Domain, Inspection, Prepared, Selection } from './model.js';
import { prepareProgram, programs, programHandlers } from './programs.js';
import { composeProgramOperations, programOperation, programPrepared } from './program-operations.js';

export function createClaudeDomain(ctx: Context): Domain {
  return {
    handlers: programHandlers(ctx),
    inspect: () => inspectClaudePrograms(ctx),
    prepare: selection => prepareClaudeProgram(ctx, selection),
  };
}
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
  if (action === 'install' && program && !program.isMissing && programStamp === null)
    throw new Error('program-changed');
  const operation =
    action === 'install' && program && !program.isMissing
      ? programPrepared([
          programOperation(
            id,
            'program-ready',
            'program.ready',
            { kind, binary: program.binary, before: programStamp, version: program.version, keep: true },
            [{ code: 'program-kept' }],
          ),
        ])
      : await prepareProgram(ctx, kind, selection, program);
  if ((action !== 'install' && action !== 'reinstall') || (action === 'install' && program && !program.isMissing))
    return operation;
  const defaults = composeProgramOperations(
    await prepareSettings(ctx, { id: 'settings', action: 'configure' }),
    id,
    'defaults',
    [id + '/program-ready'],
  );
  return programPrepared([...(operation.operations ?? []), ...defaults.operations!]);
}
