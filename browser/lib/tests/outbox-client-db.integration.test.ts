/**
 * The browser outbox stored in the real WASM client database (`Tree::Outbox`
 * in redb, in memory here), with no server: an offline edit, create and
 * delete survive a "reload" (a second Store on the same database), drain on
 * reconnect, and a queue an older build left in localStorage moves into the
 * database.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Agent } from '../src/agent.js';
import type { ClientDbWorker } from '../src/client-db.js';
import { NodeClientDb } from '../src/client-db.node.js';
import type { Commit } from '../src/commit.js';
import { JSCryptoProvider } from '../src/CryptoProvider.js';
import { core } from '../src/ontologies/core.js';
import { server } from '../src/ontologies/server.js';
import { Store } from '../src/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '../../../wasm/pkg/atomic_wasm_bg.wasm');
const SERVER = 'http://localhost:9883';

let db: NodeClientDb;

beforeAll(async () => {
  // No server in these tests: keep the Store from opening a socket.
  localStorage.setItem('ws-disconnected', '1');
  db = new NodeClientDb({ wasmPath });
  await db.init(SERVER);
});

afterAll(() => db.destroy());

async function newAgent(): Promise<Agent> {
  const keys = await Agent.generateKeyPair();

  return new Agent(
    new JSCryptoProvider(keys.privateKey),
    `did:ad:agent:${keys.publicKey}`,
  );
}

/** A tab signed in as `agent` on the shared database; commits go to a spy. */
async function tab(agent: Agent, connected: boolean) {
  const store = new Store({ serverUrl: SERVER });
  store.setServerConnected(connected);
  store.setAgent(agent);

  const posted: Commit[] = [];

  (
    store as unknown as {
      sendCommit: (c: Commit) => Promise<Commit>;
    }
  ).sendCommit = async (commit: Commit) => {
    const created = {
      ...commit,
      id: `${SERVER}/commits/${commit.signature}`,
    } as Commit;
    posted.push(created);

    return created;
  };

  vi.spyOn(store, 'getProperty').mockRejectedValue(
    new Error('property validation skipped'),
  );
  store.injectFetch(async () => {
    throw new Error('network disabled');
  });
  store.setClientDb(db as unknown as ClientDbWorker);
  await store.outbox.whenHydrated();

  return { store, posted };
}

async function queued(agent: Agent): Promise<Array<Record<string, unknown>>> {
  const rows = await db.outboxEntries(agent.subject!);

  return rows.map(r => JSON.parse(r));
}

describe('outbox in the WASM client database', () => {
  it('an offline edit survives a reload and drains on reconnect', async () => {
    const agent = await newAgent();
    const first = await tab(agent, true);
    expect(first.store.outbox.isStoredIn(db)).toBe(true);

    const doc = await first.store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'Before' },
    });
    await expect(doc.save()).resolves.toBe('persisted');
    await first.store.outbox.flush();
    expect(await queued(agent)).toEqual([]);

    first.store.setServerConnected(false);
    await doc.set(core.properties.name, 'Edited offline');
    await expect(doc.save()).resolves.toBe('offline');

    const rows = await queued(agent);
    expect(rows.map(r => r.subject)).toEqual([doc.subject]);
    expect(typeof rows[0].baseVersion).toBe('string');

    const second = await tab(agent, false);
    expect(second.store.outbox.getEntry(doc.subject)?.baseVersion).toBe(
      rows[0].baseVersion,
    );

    second.store.setServerConnected(true);
    await second.store.syncDirtyResources();

    expect(second.posted).toHaveLength(1);
    expect(second.posted[0].subject).toBe(doc.subject);
    expect(second.posted[0].isGenesis).toBeFalsy();
    expect(second.posted[0].loroUpdate).toBeTruthy();
    expect(second.store.outbox.hasPending(doc.subject)).toBe(false);
    await second.store.outbox.flush();
    expect(await queued(agent)).toEqual([]);
    second.store.setServerConnected(false);
    first.store.setServerConnected(false);
  });

  it('an offline create and an offline delete survive a reload', async () => {
    const agent = await newAgent();
    const first = await tab(agent, true);
    const doomed = await first.store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'Doomed' },
    });
    await doomed.save();
    first.store.setServerConnected(false);

    const created = await first.store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'Made offline' },
    });
    await expect(created.save()).resolves.toBe('offline');
    await doomed.destroy();

    const rows = await queued(agent);
    const bySubject = new Map(rows.map(r => [r.subject, r]));
    expect(bySubject.get(created.subject)?.signedGenesis).toBeTruthy();
    expect(bySubject.get(doomed.subject)?.signedDestroy).toBeTruthy();

    const second = await tab(agent, true);
    expect(
      second.store.outbox.getEntry(created.subject)?.signedGenesis,
    ).toBeTruthy();
    expect(second.store.hasPendingDestroy(doomed.subject)).toBe(true);
    await second.store.syncDirtyResources();

    const sent = second.posted.map(c => ({
      subject: c.subject,
      genesis: !!c.isGenesis,
      destroy: !!c.destroy,
    }));
    expect(sent).toContainEqual({
      subject: created.subject,
      genesis: true,
      destroy: false,
    });
    expect(sent).toContainEqual({
      subject: doomed.subject,
      genesis: false,
      destroy: true,
    });
    expect(second.store.outbox.size).toBe(0);
    await second.store.outbox.flush();
    expect(await queued(agent)).toEqual([]);
    second.store.setServerConnected(false);
  });

  it('moves a localStorage queue into the database and removes the key', async () => {
    const agent = await newAgent();
    const key = `atomic.outbox.${agent.subject}`;
    localStorage.setItem(
      key,
      JSON.stringify([
        { subject: 'did:ad:left-by-an-older-build', enqueuedAt: 3 },
      ]),
    );

    const { store } = await tab(agent, false);

    expect(store.outbox.hasPending('did:ad:left-by-an-older-build')).toBe(true);
    expect(localStorage.getItem(key)).toBeNull();
    expect(await queued(agent)).toEqual([
      { subject: 'did:ad:left-by-an-older-build', enqueuedAt: 3 },
    ]);

    // A reload finds it in the database alone.
    const again = await tab(agent, false);
    expect(again.store.outbox.hasPending('did:ad:left-by-an-older-build')).toBe(
      true,
    );
  });

  it("keeps each agent's rows apart in one database", async () => {
    const alice = await newAgent();
    const bob = await newAgent();
    const a = await tab(alice, false);
    a.store.outbox.markDirty('did:ad:alices');
    await a.store.outbox.flush();

    const b = await tab(bob, false);
    expect(b.store.outbox.size).toBe(0);
    expect(await queued(bob)).toEqual([]);
    expect((await queued(alice)).map(r => r.subject)).toEqual([
      'did:ad:alices',
    ]);
  });
});
