import { randomUUID } from 'node:crypto';

import { createEffectScope } from './effect-machine.js';
import { errorCode } from './machine.js';
import type { Machine } from './machine.js';
import { cancelled } from './model.js';
import type {
  Assessment,
  Context,
  ItemResult,
  JsonObject,
  OperationDefinition,
  OperationFact,
  OperationHandler,
  OperationRecord,
  Plan,
  Prepared,
  Progress,
  Recovery,
  Request,
  RunResult,
} from './model.js';
import { clearOperation, readOperation, writeOperation } from './operation-storage.js';
import { writeLastRun } from './storage.js';

const terminal = (fact: OperationFact | undefined) => fact?.status === 'confirmed' || fact?.status === 'unneeded';
function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** 唯一任务记录拥有派发、验收、依赖及恢复；领域只返回一次操作的事实。 */
export function createOperationController(ctx: Context, machine: Machine, handlers: Map<string, OperationHandler>) {
  let record: OperationRecord | undefined;
  let busy = false;
  let editable: string | undefined;
  let approval: string | undefined;
  let active: string | undefined;
  const scope = createEffectScope(machine, () => active !== undefined);
  const inputs: Record<string, Readonly<Record<string, string>>> = {};
  const identity: JsonObject = {
    home: ctx.home,
    claudeRoot: ctx.claudeRoot,
    stateFile: ctx.stateFile,
    cclineRoot: ctx.cclineRoot,
    platform: ctx.platform,
  };
  const load = async () => {
    record = frozen(await readOperation(machine, ctx));
    return record;
  };
  const save = async (next: OperationRecord) => {
    await writeOperation(machine, ctx, next);
    record = frozen(structuredClone(next));
  };
  const fact = (definition: OperationDefinition) => record!.facts[definition.id]!;
  const update = async (definition: OperationDefinition, next: OperationFact) => {
    await save({ ...record!, facts: { ...record!.facts, [definition.id]: next } });
  };
  const sameContext = () => JSON.stringify(record?.intent.context) === JSON.stringify(identity);
  const assess = async (definition: OperationDefinition): Promise<Assessment> => {
    if (!sameContext()) return { state: 'unknown', problem: 'operation-context-changed' };
    const previous = fact(definition);
    if (
      !previous.attemptId &&
      !previous.confirmed &&
      !definition.dependsOn.every(id => record!.facts[id]?.status === 'confirmed')
    )
      return { state: 'blocked', problem: 'dependency-not-ready' };
    const handler = handlers.get(definition.handler);
    if (!handler) return { state: 'blocked', problem: 'repreview-required' };
    try {
      return await handler.assess(definition, fact(definition), record!.facts);
    } catch (error) {
      return { state: 'unknown', problem: errorCode(error) };
    }
  };
  const registerAssessment = async (definition: OperationDefinition, assessment: Assessment) => {
    const previous = fact(definition);
    const retained = { ...previous };
    delete retained.problem;
    switch (assessment.state) {
      case 'complete':
        await update(definition, {
          ...retained,
          status: 'confirmed',
          confirmed: true,
          evidence: assessment.evidence,
          effects: assessment.effects ?? previous.effects,
        });
        break;
      case 'unneeded':
        await update(definition, {
          ...retained,
          status: 'unneeded',
          effects: [{ state: 'skipped', code: assessment.reason }],
        });
        break;
      case 'ready':
        // 已确认目标丢失不允许借由 ready 重新派发。
        await update(
          definition,
          previous.confirmed
            ? { ...previous, status: 'checking', problem: 'target-changed' }
            : { ...retained, status: 'pending', ...(assessment.dispatch ? { dispatch: assessment.dispatch } : {}) },
        );
        break;
      case 'unknown':
      case 'blocked':
        await update(definition, {
          ...previous,
          status: assessment.state === 'unknown' ? 'checking' : 'failed',
          problem: assessment.problem,
        });
    }
  };
  const currentPlan = (): Plan => ({
    id: record!.planId,
    items: record!.items.flatMap(item => {
      const operations = record!.operations.filter(operation => operation.itemId === item.id);
      const pending = operations.filter(operation => !terminal(fact(operation)));
      if (operations.length && !pending.length) return [];
      return [
        {
          ...item,
          changes: operations.length
            ? pending.flatMap(operation =>
                fact(operation).status === 'issued' || fact(operation).status === 'checking'
                  ? [
                      {
                        code: 'operation-result-check',
                        ...(operation.changes[0]?.detail ? { detail: operation.changes[0].detail } : {}),
                      },
                    ]
                  : operation.changes,
              )
            : item.changes,
        },
      ];
    }),
    problem: record!.items.length ? null : 'empty-selection',
  });
  const missingInputs = () =>
    record!.operations.flatMap(operation =>
      terminal(fact(operation))
        ? []
        : (operation.requiresInput ?? [])
            .filter(field => !inputs[operation.id]?.[field])
            .map(field => ({ operationId: operation.id, itemId: operation.itemId, field })),
    );
  const recovery = (): Recovery => ({
    id: record!.id,
    phase: record!.phase,
    intent: record!.intent,
    items: record!.items.map(item => {
      const facts = record!.operations
        .filter(operation => operation.itemId === item.id)
        .map(operation => fact(operation));
      const state =
        facts.length && facts.every(terminal)
          ? 'done'
          : facts.some(value => value.status === 'checking' || value.status === 'issued')
            ? 'unknown'
            : item.problem ||
                facts.some(
                  value =>
                    value.status === 'failed' &&
                    (value.attemptId !== undefined || value.problem !== 'dependency-not-ready'),
                )
              ? 'failed'
              : 'pending';
      const problem =
        item.problem ??
        facts.find(
          value => value.problem && (value.attemptId !== undefined || value.problem !== 'dependency-not-ready'),
        )?.problem;
      return { id: item.id, title: item.title, state, ...(problem ? { problem } : {}) };
    }),
    inputs: missingInputs(),
  });
  const invalid = (problem: string): RunResult => ({
    state: 'failed',
    items: [{ id: 'plan', title: '操作计划', state: 'failed', effects: [{ state: 'failed', code: problem }] }],
  });

  return {
    effects: scope.machine,
    async recovery(): Promise<Recovery | undefined> {
      if (busy) throw new Error('operation-in-progress');
      busy = true;
      try {
        await load();
        if (!record || record.phase === 'completed') return undefined;
        approval = undefined;
        for (const operation of record.operations) await registerAssessment(operation, await assess(operation));
        await save({ ...record, planId: randomUUID(), phase: 'awaiting-confirmation' });
        return structuredClone(recovery());
      } finally {
        busy = false;
      }
    },
    async abandon(id: string) {
      if (busy) throw new Error('operation-in-progress');
      await load();
      if (!record || record.id !== id) throw new Error('plan-unavailable');
      await clearOperation(machine, ctx);
      record = undefined;
      editable = undefined;
      approval = undefined;
      for (const key of Object.keys(inputs)) delete inputs[key];
    },
    async plan(
      input: Request,
      prepare: () => Promise<{ plan: Plan; work: ReadonlyMap<string, Prepared> }>,
    ): Promise<Plan> {
      if (busy) throw new Error('operation-in-progress');
      busy = true;
      try {
        await load();
        approval = undefined;
        if ('resume' in input) {
          if (!record || record.id !== input.resume || record.phase === 'completed')
            throw new Error('plan-unavailable');
          const missing = missingInputs();
          for (const [operationId, fields] of Object.entries(input.inputs ?? {})) {
            for (const [field, value] of Object.entries(fields)) {
              if (!missing.some(entry => entry.operationId === operationId && entry.field === field))
                throw new Error('input-unavailable');
              inputs[operationId] = { ...inputs[operationId], [field]: value };
            }
          }
          await save({ ...record, phase: 'preparing' });
          for (const operation of record.operations) await registerAssessment(operation, await assess(operation));
          await save({ ...record, planId: randomUUID(), phase: 'awaiting-confirmation' });
          approval = record.planId;
          return structuredClone(currentPlan());
        }
        if (
          record &&
          record.phase !== 'completed' &&
          !(
            editable === record.id &&
            record.intent.task === input.task &&
            record.phase === 'awaiting-confirmation' &&
            record.operations.every(operation => !fact(operation).attemptId)
          )
        )
          throw new Error('unfinished-operation');
        const prepared = await prepare();
        for (const key of Object.keys(inputs)) delete inputs[key];
        const operations: OperationDefinition[] = [];
        for (const item of prepared.plan.items) {
          const work = prepared.work.get(item.id);
          if (!work) continue;
          if (work.inputs) Object.assign(inputs, work.inputs);
          operations.push(...work.operations);
        }
        const id = randomUUID();
        await save({
          schema: 1,
          id,
          phase: 'awaiting-confirmation',
          planId: prepared.plan.id,
          intent: {
            task: input.task,
            context: identity,
            selected: input.selected.map(pick => ({
              id: pick.id,
              ...(pick.maintenance ? { maintenance: pick.maintenance } : {}),
              ...(pick.removal ? { removal: pick.removal } : {}),
            })),
            ...('removeData' in input ? { removeData: input.removeData ?? false } : {}),
          },
          items: prepared.plan.items,
          operations,
          facts: Object.fromEntries(operations.map(operation => [operation.id, { status: 'pending', effects: [] }])),
        });
        editable = id;
        approval = prepared.plan.id;
        return structuredClone(prepared.plan);
      } finally {
        busy = false;
      }
    },
    async apply(
      planId: string,
      signal?: AbortSignal,
      progress?: (event: Progress) => void | Promise<void>,
    ): Promise<RunResult> {
      if (busy) return invalid('operation-in-progress');
      busy = true;
      let observer = progress;
      const notify = (event: Progress) => {
        if (!observer) return;
        try {
          void Promise.resolve(observer(structuredClone(event))).catch(() => {
            observer = undefined;
          });
        } catch {
          observer = undefined;
        }
      };
      try {
        await load();
        if (!record || record.phase !== 'awaiting-confirmation' || record.planId !== planId || approval !== planId)
          return invalid('plan-unavailable');
        approval = undefined;
        const plan: Plan = { ...currentPlan(), items: record.items };
        await save({ ...record, phase: 'executing' });
        const attempted = new Set<string>();
        let storageProblem: string | undefined;
        let wasCancelled = false;
        try {
          for (;;) {
            let advanced = false;
            for (const operation of record.operations) {
              if (terminal(fact(operation)) || attempted.has(operation.id)) continue;
              if (!operation.dependsOn.every(id => record!.facts[id]?.status === 'confirmed')) continue;
              cancelled(signal);
              // 依赖资格来自同一账本；已成功依赖在下一次变更前重新验收。
              let dependencyReady = true;
              for (const id of operation.dependsOn) {
                const dependency = record.operations.find(value => value.id === id)!;
                const assessment = await assess(dependency);
                await registerAssessment(dependency, assessment);
                if (fact(dependency).status !== 'confirmed') dependencyReady = false;
              }
              if (!dependencyReady) continue;
              const assessment = await assess(operation);
              await registerAssessment(operation, assessment);
              if (assessment.state === 'complete')
                for (const effect of assessment.effects ?? []) notify({ kind: 'effect', id: operation.itemId, effect });
              attempted.add(operation.id);
              if (terminal(fact(operation))) {
                advanced = true;
                continue;
              }
              if (assessment.state !== 'ready' || fact(operation).status !== 'pending') continue;
              if (missingInputs().some(entry => entry.operationId === operation.id)) {
                await update(operation, { ...fact(operation), status: 'failed', problem: 'credential-required' });
                continue;
              }
              const issued: OperationFact = {
                ...fact(operation),
                status: 'issued',
                attemptId: randomUUID(),
                effects: [],
              };
              await update(operation, issued);
              notify({ kind: 'started', id: operation.itemId });
              let outcome;
              try {
                active = operation.id;
                outcome = await scope.run(() =>
                  handlers.get(operation.handler)!.execute(operation, issued, inputs[operation.id] ?? {}, signal),
                );
              } catch (error) {
                outcome = { receipt: { kind: 'unknown' as const, failure: errorCode(error) } };
              } finally {
                active = undefined;
              }
              await update(operation, {
                ...issued,
                receipt: outcome.receipt,
                ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
                effects: outcome.effects ?? [],
              });
              for (const effect of outcome.effects ?? []) notify({ kind: 'effect', id: operation.itemId, effect });
              if (outcome.receipt.failure) {
                if (outcome.receipt.failure === 'credential-required') delete inputs[operation.id];
                await update(operation, {
                  ...fact(operation),
                  status: outcome.receipt.kind === 'unknown' ? 'checking' : 'failed',
                  problem: outcome.receipt.failure,
                });
              }
              const verified = await assess(operation);
              if (verified.state === 'ready')
                await update(operation, {
                  ...fact(operation),
                  status: outcome.receipt.kind === 'unknown' ? 'checking' : 'failed',
                  problem: outcome.receipt.failure ?? 'operation-unconfirmed',
                });
              else {
                await registerAssessment(operation, verified);
                if (verified.state === 'complete')
                  for (const effect of verified.effects ?? [])
                    if (
                      !(outcome.effects ?? []).some(
                        previous =>
                          previous.code === effect.code &&
                          previous.state === effect.state &&
                          previous.detail === effect.detail,
                      )
                    )
                      notify({ kind: 'effect', id: operation.itemId, effect });
              }
              advanced = true;
            }
            if (!advanced) break;
          }
        } catch (error) {
          if (errorCode(error) === 'cancelled') wasCancelled = true;
          else storageProblem = errorCode(error);
        }
        wasCancelled ||= signal?.aborted === true;
        if (!storageProblem) {
          try {
            for (const operation of record.operations)
              if (fact(operation).status === 'confirmed') await registerAssessment(operation, await assess(operation));
          } catch (error) {
            storageProblem = errorCode(error);
          }
        }
        const complete =
          record.items.every(item => !item.problem) && record.operations.every(operation => terminal(fact(operation)));
        if (!storageProblem) await save({ ...record, phase: complete ? 'completed' : 'paused' });
        const results: ItemResult[] = plan.items.map(item => {
          const facts = record!.operations
            .filter(operation => operation.itemId === item.id)
            .map(operation => fact(operation));
          const done = !item.problem && facts.length > 0 && facts.every(terminal);
          const effects = facts.flatMap(value => value.effects);
          const problems = new Set([
            ...(storageProblem ? [storageProblem] : []),
            ...(item.problem ? [item.problem] : []),
            ...facts.flatMap(value => (value.problem ? [value.problem] : [])),
            ...(wasCancelled ? ['cancelled'] : []),
          ]);
          if (!done && !problems.size) problems.add('dependency-not-ready');
          for (const problem of [...problems].reverse())
            if (!effects.some(effect => effect.code === problem))
              effects.push({
                state: problem === 'cancelled' || problem === 'dependency-not-ready' ? 'skipped' : 'failed',
                code: problem,
              });
          const result: ItemResult = {
            id: item.id,
            title: item.title,
            state:
              done && !storageProblem
                ? 'done'
                : wasCancelled
                  ? 'cancelled'
                  : effects.some(effect => effect.state === 'done' || effect.state === 'kept')
                    ? 'partial'
                    : 'failed',
            effects,
            isPending: !done,
          };
          notify({ kind: 'finished', id: item.id, result });
          return result;
        });
        const result: RunResult = {
          state: wasCancelled
            ? 'cancelled'
            : complete && !storageProblem
              ? 'done'
              : results.some(item => item.state === 'done' || item.state === 'partial')
                ? 'partial'
                : 'failed',
          items: results,
          ...(!complete || storageProblem ? { remaining: record.id } : {}),
        };
        await writeLastRun({ ...ctx, effects: machine }, plan, result, result.remaining);
        return result;
      } catch (error) {
        return invalid(errorCode(error));
      } finally {
        active = undefined;
        busy = false;
      }
    },
  };
}
