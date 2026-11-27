import { afterAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fileClientDb,
  closeFileClientDb,
  disposeFileClientDbs,
  failNextFileCheckpoint,
  readFileCheckpoint,
} from './file-client-db.js';
import { LoroLoader } from '../src/loro-loader.js';
import { core } from '../src/ontologies/core.js';
import { server } from '../src/ontologies/server.js';
import type { ClientDbWorker } from '../src/client-db.js';
import { testStore } from '../src/test-store.js';
import { commitToJsonADObject } from '../src/commit.js';

const options = {
  wasmPath: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../wasm/pkg/atomic_wasm_bg.wasm',
  ),
};
afterAll(disposeFileClientDbs);

it('keeps an atomic snapshot/outbox checkpoint after failed fsync and reopens an independent WASM database', async () => {
  const db = fileClientDb(options);
  await db.init();
  const subject = 'atomic:file-checkpoint-fixture';
  const agent = 'atomic:agent:file-checkpoint-owner';
  const doc = new LoroLoader.Loro.LoroDoc();
  doc.getMap('properties').set(core.properties.name, 'Before');
  doc.commit();
  const entry = { subject, enqueuedAt: 1 };
  await db.putLoroSnapshot(
    subject,
    doc.export({ mode: 'snapshot' }),
    undefined,
    { agent, puts: [{ subject, value: JSON.stringify(entry) }], deletes: [] },
  );
  const hash = async () =>
    createHash('sha256')
      .update(JSON.stringify(await readFileCheckpoint(db)))
      .digest('hex');
  const before = await hash();
  doc.getMap('properties').set(core.properties.name, 'After');
  doc.commit();
  failNextFileCheckpoint(db);
  await expect(
    db.putLoroSnapshot(subject, doc.export({ mode: 'snapshot' }), undefined, {
      agent,
      puts: [],
      deletes: [subject],
    }),
  ).rejects.toThrow('injected checkpoint fsync failure');
  expect(await hash()).toBe(before);
  await closeFileClientDb(db);
  const reopened = fileClientDb(options, db);
  await reopened.init();
  const row = await reopened.getResourceWithSnapshot(subject);
  expect(JSON.parse(row.jsonAd!)[core.properties.name]).toBe('Before');
  const restored = new LoroLoader.Loro.LoroDoc();
  restored.import(row.snapshot!);
  expect(restored.getMap('properties').get(core.properties.name)).toBe(
    'Before',
  );
  expect(await reopened.outboxEntries(agent)).toEqual([JSON.stringify(entry)]);
  expect(await reopened.getReplicaIdentity(subject)).toBeUndefined();
  restored.free();
  doc.free();
  // Successful clear and resource removal are checkpointed too.
  await reopened.outboxWrite({ agent, puts: [], deletes: [subject] }, true);
  await reopened.removeResource(subject);
  await closeFileClientDb(reopened);
  const empty = fileClientDb(options, reopened);
  await empty.init();
  expect(await empty.outboxEntries(agent)).toEqual([]);
  expect((await empty.getResourceWithSnapshot(subject)).jsonAd).toBeNull();
});

it('does not POST a genesis whose required filesystem checkpoint failed', async () => {
  localStorage.setItem('ws-disconnected', '1');
  const db = fileClientDb(options);
  await db.init();
  const { store, postCommitSpy } = await testStore({ connect: false });
  store.setClientDb(db as unknown as ClientDbWorker);
  await store.outbox.whenHydrated();
  const resource = await store.newResource({
    isA: server.classes.drive,
    noParent: true,
    propVals: { [core.properties.name]: 'Must remain queued' },
  });
  failNextFileCheckpoint(db);

  try {
    await expect(resource.save()).rejects.toThrow(
      'injected checkpoint fsync failure',
    );
    expect(postCommitSpy).not.toHaveBeenCalled();
    expect(
      store.outbox.getEntry(resource.subject)?.signedGenesis,
    ).toBeDefined();
  } finally {
    store.setServerConnected(false);
    await store.outbox.flush();
  }
});

it('persists blobs, imported resources and actual envelopes without leaking reader spies into checkpointing', async () => {
  const db = fileClientDb(options);
  await db.init();
  const read = db.getResourceWithSnapshot.bind(db);
  const spy = vi
    .spyOn(db, 'getResourceWithSnapshot')
    .mockImplementation(subject => read(subject));
  const bytes = new Uint8Array([5, 4, 3, 2, 1]);
  const hash = await db.blake3Hash(bytes);
  await db.putBlob(hash, bytes);
  const imported = 'https://example.com/file-checkpoint-import';
  expect(
    await db.importAllResources(
      JSON.stringify([{ '@id': imported, [core.properties.name]: 'Imported' }]),
    ),
  ).toBe(1);
  const { store, posted } = await testStore({ connect: false });
  const resource = await store.newResource({
    isA: server.classes.drive,
    noParent: true,
    propVals: { [core.properties.name]: 'Envelope owner' },
  });
  await resource.save();
  store.setServerConnected(false);
  await db.putLoroSnapshot(
    resource.subject,
    resource.getLoroDoc()!.export({ mode: 'snapshot' }),
  );
  const envelope = JSON.stringify(commitToJsonADObject(posted[0]));
  expect(
    await db.importEnvelopes([{ subject: resource.subject, json: envelope }]),
  ).toBe(1);
  const envelopes = await db.envelopesFor([resource.subject]);
  expect(envelopes[resource.subject]).toHaveLength(1);
  expect(
    JSON.parse((await db.getResourceWithSnapshot(imported)).jsonAd!)[
      core.properties.name
    ],
  ).toBe('Imported');
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
  await closeFileClientDb(db);
  const reopened = fileClientDb(options, db);
  expect(() => fileClientDb(options, db)).toThrow('closed owned checkpoint');
  await reopened.init();
  expect(await reopened.getBlob(hash)).toEqual(bytes);
  expect(
    JSON.parse((await reopened.getResourceWithSnapshot(imported)).jsonAd!)[
      core.properties.name
    ],
  ).toBe('Imported');
  expect(await reopened.envelopesFor([resource.subject])).toEqual(envelopes);
});

it('does not replay a rejected Vault receipt write as an accepted mutation', async () => {
  const db = fileClientDb(options);
  await db.init();
  const scope = {
    managedAccount: 'fixture-account',
    agent: 'atomic:agent:fixture-owner',
    portalUrl: 'https://account.example/api',
    drive: 'atomic:fixture-drive',
    drivePseudonym: 'fixture',
    keyEpoch: 1,
  };
  const generation = await db.getResourceVaultGeneration(scope);
  expect(typeof generation).toBe('number');
  expect(await db.putResourceVaultReceipts(scope, [], generation! + 1)).toBe(
    false,
  );
  expect((await readFileCheckpoint(db)).metadata).toEqual([]);
  expect(await db.putResourceVaultReceipts(scope, [], generation!)).toBe(true);
  expect((await readFileCheckpoint(db)).metadata).toHaveLength(1);
  await closeFileClientDb(db);
  const reopened = fileClientDb(options, db);
  await reopened.init();
  expect(await reopened.getResourceVaultGeneration(scope)).toBe(generation);
});
