import { describe, expect, it } from 'vitest';
import { testStore } from './test-store.js';
import { core } from './ontologies/core.js';
import type { CommitLogEntry, Store } from './store.js';

const outgoing = (store: Store, subject: string): CommitLogEntry[] =>
  store
    .getCommitLog()
    .filter(e => e.subject === subject && e.status === 'sent')
    .reverse();

const changed = (store: Store, entry: CommitLogEntry) =>
  (store.getCommitPropertySummaries(entry) ?? []).map(s => [
    s.property,
    s.changeType,
  ]);

describe('commit log property summaries', () => {
  it('are computed on demand and show only what each commit changed', async () => {
    const { store } = await testStore();
    const drive = await store.createDrive('Home', { personal: true });
    const doc = await store.newResource({
      parent: drive.subject,
      propVals: {
        [core.properties.name]: 'first',
        [core.properties.description]: 'kept',
      },
    });
    await doc.save();
    await doc.set(core.properties.name, 'second', false);
    await doc.save();
    await doc.remove(core.properties.description);
    await doc.save();

    const [genesis, rename, removal] = outgoing(store, doc.subject);

    expect(genesis).toBeDefined();
    expect(changed(store, genesis)).toEqual(
      expect.arrayContaining([
        [core.properties.name, 'changed'],
        [core.properties.description, 'changed'],
      ]),
    );
    expect(changed(store, rename)).toEqual([[core.properties.name, 'changed']]);
    expect(store.getCommitPropertySummaries(rename)?.[0].value).toBe('second');
    expect(changed(store, removal)).toEqual([
      [core.properties.description, 'removed'],
    ]);
    // Asking again returns the same answer.
    expect(changed(store, rename)).toEqual([[core.properties.name, 'changed']]);
  });

  it('keeps no state for commits that left the log', async () => {
    const { store } = await testStore();
    const drive = await store.createDrive('Home', { personal: true });
    const doc = await store.newResource({
      parent: drive.subject,
      propVals: { [core.properties.name]: 'v0' },
    });
    await doc.save();

    for (let i = 1; i <= 60; i++) {
      await doc.set(core.properties.name, `v${i}`, false);
      await doc.save();
    }

    const internals = store as unknown as {
      _commitLogUpdates: Map<string, Uint8Array>;
    };
    const ids = new Set(store.getCommitLog().map(e => e.id));
    expect(store.getCommitLog()).toHaveLength(50);
    expect(
      [...internals._commitLogUpdates.keys()].every(id => ids.has(id)),
    ).toBe(true);
  });
});
