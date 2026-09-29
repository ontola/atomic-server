import { it, expect } from 'vitest';
import { Store } from './store.js';
import { Resource, SYSTEM_COMMIT_ORIGIN } from './resource.js';
import { enableLoro } from './loro-loader.js';
import { core } from './ontologies/core.js';
import { Datatype } from './datatypes.js';
import { IMPORT_RESOLUTION } from './import-resolution.js';
import { testStore } from './test-store.js';
import { LoroLoader } from './loro-loader.js';
import type { Commit } from './commit.js';
it('incremental drain tags a newly added JSON field so it survives materialization', async () => {
  await enableLoro();
  const store = new Store();
  const property = new Resource(IMPORT_RESOLUTION);
  store.addResource(property);
  await property.set(core.properties.datatype, Datatype.JSON, false);
  const row = new Resource('did:ad:row');
  store.addResource(row);
  await row.set(core.properties.name, 'Original', false);
  const initial = row.exportLoroDeltaForDrain(true)!;
  row.markLoroSavedAt(initial.versionAfterExport);
  const value = { version: 1, canonical: 'did:ad:row', members: {} };
  await row.set(IMPORT_RESOLUTION, value, false);
  const update = row.exportLoroDeltaForDrain(false)!;
  const received = new Resource('did:ad:row');
  received.importLoroUpdate(initial.bytes, true);
  received.importLoroUpdate(update.bytes);
  expect(received.get(IMPORT_RESOLUTION)).toEqual(value);
});

it('the drained incremental commit tags properties first set after genesis', async () => {
  const { store, postCommitSpy } = await testStore();
  const JSON_PROP = 'https://example.com/properties/settings';
  const ARRAY_PROP = 'https://example.com/properties/members';

  for (const [subject, datatype] of [
    [JSON_PROP, Datatype.JSON],
    [ARRAY_PROP, Datatype.RESOURCEARRAY],
  ] as const) {
    const property = new Resource(subject);
    store.addResource(property);
    await property.set(core.properties.datatype, datatype, false);
  }

  const doc = await store.newResource({
    isA: 'https://atomicdata.dev/classes/Drive',
    propVals: { [core.properties.name]: 'Tagged later' },
    noParent: true,
  });
  expect(await doc.save()).toBe('persisted');
  // Neither property existed at genesis: the incremental commit the drain
  // signs is the only place their tags can travel.
  await doc.set(JSON_PROP, { theme: 'dark' }, false);
  await doc.set(ARRAY_PROP, ['did:ad:member'], false);
  expect(await doc.save()).toBe('persisted');
  expect(postCommitSpy.mock.calls.length).toBe(2);
  const [genesis, update] = postCommitSpy.mock.calls.map(
    ([commit]) => (commit as Commit).loroUpdate!,
  );
  const { LoroDoc } = LoroLoader.Loro;
  const afterGenesis = new LoroDoc();
  afterGenesis.import(genesis);
  const genesisTags = afterGenesis.getMap('datatypes').toJSON();
  expect(genesisTags[JSON_PROP]).toBeUndefined();
  expect(genesisTags[ARRAY_PROP]).toBeUndefined();
  // What the server sees: the delta applied on top of the genesis snapshot.
  const server = new LoroDoc();
  server.import(genesis);
  server.import(update);
  const tags = server.getMap('datatypes').toJSON();
  expect(tags[JSON_PROP]).toBe('json');
  expect(tags[ARRAY_PROP]).toBe('resourceArray');
  expect(server.getMap('properties').get(JSON_PROP)).toBe(
    JSON.stringify({ theme: 'dark' }),
  );
});

it('the drain seals the edit before tagging, so the edit stays undoable', async () => {
  const { store, postCommitSpy } = await testStore();
  const JSON_PROP = 'https://example.com/properties/settings';
  const property = new Resource(JSON_PROP);
  store.addResource(property);
  await property.set(core.properties.datatype, Datatype.JSON, false);
  const doc = await store.newResource({
    isA: 'https://atomicdata.dev/classes/Drive',
    propVals: { [core.properties.name]: 'Undo me' },
    noParent: true,
  });
  expect(await doc.save()).toBe('persisted');
  // The canvas page's undo stack: it skips `atomic:system` commits.
  doc.ensureUndoManager();
  const origins: string[] = [];
  doc.getLoroDoc()!.subscribe(batch => {
    if (batch.by === 'local') origins.push(batch.origin ?? '');
  });
  // `set()` leaves the op in an open transaction. The drain's first
  // `commit()` seals it — that must be the edit's own commit, not the
  // datatype-tag housekeeping write, or the user's undo skips the edit.
  await doc.set(JSON_PROP, { theme: 'dark' }, false);
  expect(await doc.save()).toBe('persisted');
  expect(origins[0]).not.toBe(SYSTEM_COMMIT_ORIGIN);
  expect(doc.canUndo()).toBe(true);
  // The tags still travel in the same signed commit.
  const { LoroDoc } = LoroLoader.Loro;
  const server = new LoroDoc();

  for (const [commit] of postCommitSpy.mock.calls) {
    server.import((commit as Commit).loroUpdate!);
  }

  expect(server.getMap('datatypes').get(JSON_PROP)).toBe('json');
});
