import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';

import { createEnv } from './env.mjs';

async function legacyJournal(f, schema, writes) {
  const journal = path.join(f.home, '.ccw/operation.json');
  const envelope = await f.read(journal);
  assert.ok(envelope.record.operations.every(operation => !Object.hasOwn(operation, 'writes')));
  for (const operation of envelope.record.operations) {
    operation.writes = writes;
    if (schema === 2) operation.payload = { encoding: 'inline', value: operation.payload };
  }
  envelope.schema = schema;
  envelope.checksum = createHash('sha256').update(JSON.stringify(envelope.record)).digest('hex');
  await f.json(journal, envelope);
  return journal;
}

for (const schema of [1, 2]) {
  test(`legacy schema ${schema} writes are discarded when recovery saves the remaining plan`, async t => {
    const f = await createEnv(t, { seed: { settings: { language: 'English', custom: true } } });
    const machine = f.machine();
    await f.ccw(machine).plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
    const journal = await legacyJournal(f, schema, [f.settingsFile]);

    const restarted = f.ccw(machine);
    const recovery = await restarted.recovery();
    assert.equal(recovery.items[0].state, 'pending');
    assert.equal((await f.read(f.settingsFile)).language, 'English');
    assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length, 0);
    assert.ok((await f.read(journal)).record.operations.every(operation => !Object.hasOwn(operation, 'writes')));

    const remaining = await restarted.plan({ resume: recovery.id });
    assert.equal((await restarted.apply(remaining.id)).state, 'done');
    const settings = await f.read(f.settingsFile);
    assert.equal(settings.language, '中文');
    assert.equal(settings.custom, true);
    assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length, 1);
  });

  for (const writes of [null, 'invalid', [42]])
    test(`legacy schema ${schema} rejects malformed writes ${JSON.stringify(writes)} before recovery`, async t => {
      const f = await createEnv(t, { seed: { settings: { language: 'English' } } });
      const machine = f.machine();
      await f.ccw(machine).plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
      const journal = await legacyJournal(f, schema, writes);
      const before = await f.read(journal);

      await assert.rejects(f.ccw(machine).recovery(), /operation-record-invalid/);
      assert.equal((await f.read(f.settingsFile)).language, 'English');
      assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length, 0);
      assert.deepEqual(await f.read(journal), before);
    });

  test(`legacy schema ${schema} checks the original checksum before discarding writes`, async t => {
    const f = await createEnv(t, { seed: { settings: { language: 'English' } } });
    const machine = f.machine();
    await f.ccw(machine).plan({ task: 'install', selected: [{ id: 'settings', fields: { language: '中文' } }] });
    const journal = await legacyJournal(f, schema, [f.settingsFile]);
    const envelope = await f.read(journal);
    envelope.record.operations[0].writes = ['changed after checksum'];
    await f.json(journal, envelope);

    await assert.rejects(f.ccw(machine).recovery(), /operation-record-invalid/);
    assert.equal((await f.read(f.settingsFile)).language, 'English');
    assert.equal(f.calls.filter(call => call.kind === 'editJson' && call.target === f.settingsFile).length, 0);
    assert.deepEqual(await f.read(journal), envelope);
  });
}
