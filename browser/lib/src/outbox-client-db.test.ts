import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from './agent.js';
import type { ClientDbOutboxWrite, ClientDbWorker } from './client-db.js';
import type { Commit } from './commit.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { Store } from './store.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  localStorage.setItem('ws-disconnected', '1');
});

/**
 * The client database a tab talks to, reduced to what saving, reloading and
 * draining touch: resource rows with their snapshots, and the outbox rows.
 * Shared between two `Store`s to stand in for a reload.
 */
class FakeClientDb {
  isReady = true;
  isInitialized = true;
  initError = undefined;
  unsupportedEnvironment = false;
  rows = new Map<string, { jsonAd: string; snapshot: Uint8Array | null }>();
  outbox = new Map<string, Map<string, string>>();
  /** Every outbox write, and whether it was made durable before resolving. */
  outboxWrites: Array<{ write: ClientDbOutboxWrite; durable: boolean }> = [];
  putCalls: Array<{ subject: string; outbox?: ClientDbOutboxWrite }> = [];

  async waitForReady() {
    return true;
  }

  async waitForInit() {
    return true;
  }

  async flush() {}

  async putResourceWithSnapshot(
    subject: string,
    jsonAd: string,
    snapshot?: Uint8Array,
    outbox?: ClientDbOutboxWrite,
  ) {
    this.putCalls.push({ subject, outbox });
    this.rows.set(subject, { jsonAd, snapshot: snapshot ?? null });
    if (outbox) this.applyOutbox(outbox, true);
  }

  async getResourceWithSnapshot(subject: string) {
    return this.rows.get(subject) ?? { jsonAd: null, snapshot: null };
  }

  async getResourcesWithSnapshots(subjects: string[]) {
    return Promise.all(subjects.map(s => this.getResourceWithSnapshot(s)));
  }

  async removeResource(subject: string) {
    this.rows.delete(subject);
  }

  async outboxEntries(agent: string) {
    return [...(this.outbox.get(agent)?.values() ?? [])];
  }

  async outboxWrite(write: ClientDbOutboxWrite, durable: boolean) {
    this.applyOutbox(write, durable);
  }

  private applyOutbox(write: ClientDbOutboxWrite, durable: boolean) {
    this.outboxWrites.push({ write, durable });
    const rows = this.outbox.get(write.agent) ?? new Map<string, string>();
    for (const subject of write.deletes) rows.delete(subject);
    for (const { subject, value } of write.puts) rows.set(subject, value);
    this.outbox.set(write.agent, rows);
  }

  queued(agent: string): Array<Record<string, unknown>> {
    return [...(this.outbox.get(agent)?.values() ?? [])].map(v =>
      JSON.parse(v),
    );
  }
}

/** A tab: a Store signed in as `agent`, its commits posted to a spy. */
async function tab(agent: Agent, db: FakeClientDb, connected: boolean) {
  const store = new Store({ serverUrl: 'https://example.com' });
  store.setServerConnected(connected);
  store.setAgent(agent);

  const posted: Commit[] = [];
  const postCommitSpy = vi.fn(async (commit: Commit) => {
    const created = {
      ...commit,
      id: `https://example.com/commits/${commit.signature}`,
    } as Commit;
    posted.push(created);

    return created;
  });
  (
    store as unknown as { client: { postCommit: typeof postCommitSpy } }
  ).client.postCommit = postCommitSpy;
  vi.spyOn(store, 'getProperty').mockRejectedValue(
    new Error('property validation skipped'),
  );
  store.injectFetch(async () => {
    throw new Error('network disabled');
  });

  store.setClientDb(db as unknown as ClientDbWorker);
  await store.outbox.whenHydrated();

  return { store, posted, postCommitSpy };
}

async function newAgent(): Promise<Agent> {
  const keys = await Agent.generateKeyPair();

  return new Agent(
    new JSCryptoProvider(keys.privateKey),
    `did:ad:agent:${keys.publicKey}`,
  );
}

describe('the outbox in the client database', () => {
  it('an offline edit survives a reload and drains on reconnect', async () => {
    const agent = await newAgent();
    const db = new FakeClientDb();
    const first = await tab(agent, db, true);
    expect(first.store.outbox.isStoredIn(db)).toBe(true);

    const doc = await first.store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'Before' },
    });
    await expect(doc.save()).resolves.toBe('persisted');
    expect(first.posted).toHaveLength(1);
    await Promise.resolve();
    expect(db.queued(agent.subject!)).toEqual([]);

    first.store.setServerConnected(false);
    await doc.set(core.properties.name, 'Edited offline');
    await expect(doc.save()).resolves.toBe('offline');

    // The snapshot and its outbox row went in the same write.
    const offlinePut = db.putCalls.at(-1)!;
    expect(offlinePut.subject).toBe(doc.subject);
    expect(offlinePut.outbox?.puts.map(p => p.subject)).toEqual([doc.subject]);
    const [row] = db.queued(agent.subject!);
    expect(row.subject).toBe(doc.subject);
    expect(typeof row.baseVersion).toBe('string');
    expect(first.store.getSyncStatus().pendingDirtyCount).toBe(1);
    expect(localStorage.getItem(`atomic.outbox.${agent.subject}`)).toBeNull();

    // Reload: a new tab starts with nothing in memory and reads the queue
    // from the database.
    const second = await tab(agent, db, false);
    expect(second.store.outbox.getEntry(doc.subject)?.baseVersion).toBe(
      row.baseVersion,
    );
    // The Sync page lists the restored entry as pending.
    expect(
      second.store
        .getCommitLog()
        .some(e => e.subject === doc.subject && e.status === 'pending'),
    ).toBe(true);

    second.store.setServerConnected(true);
    await second.store.syncDirtyResources();

    expect(second.posted).toHaveLength(1);
    const commit = second.posted[0];
    expect(commit.subject).toBe(doc.subject);
    expect(commit.isGenesis).toBeFalsy();
    expect(commit.loroUpdate).toBeTruthy();
    expect(second.store.outbox.hasPending(doc.subject)).toBe(false);
    await Promise.resolve();
    expect(db.queued(agent.subject!)).toEqual([]);
    second.store.setServerConnected(false);
  });

  it('an offline create keeps its signed genesis across a reload', async () => {
    const agent = await newAgent();
    const db = new FakeClientDb();
    const first = await tab(agent, db, false);

    const doc = await first.store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'Made offline' },
    });
    await expect(doc.save()).resolves.toBe('offline');

    const [row] = db.queued(agent.subject!);
    expect(row.subject).toBe(doc.subject);
    expect(row.signedGenesis).toBeTruthy();
    // Written durably: a genesis cannot be signed again after a crash.
    expect(db.outboxWrites.every(w => w.durable)).toBe(true);

    const second = await tab(agent, db, true);
    expect(
      second.store.outbox.getEntry(doc.subject)?.signedGenesis,
    ).toBeTruthy();
    await second.store.syncDirtyResources();

    expect(second.posted[0]?.subject).toBe(doc.subject);
    expect(second.posted[0]?.isGenesis).toBe(true);
    expect(second.store.outbox.hasPending(doc.subject)).toBe(false);
    second.store.setServerConnected(false);
  });

  it('an offline delete is on disk before destroy() resolves', async () => {
    const agent = await newAgent();
    const db = new FakeClientDb();
    const first = await tab(agent, db, true);
    const doc = await first.store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'Doomed' },
    });
    await doc.save();
    first.store.setServerConnected(false);

    await doc.destroy();

    const rows = db.queued(agent.subject!);
    expect(rows.map(r => r.subject)).toEqual([doc.subject]);
    expect(rows[0].signedDestroy).toBeTruthy();
    expect(db.outboxWrites.at(-1)?.durable).toBe(true);

    const second = await tab(agent, db, true);
    expect(second.store.hasPendingDestroy(doc.subject)).toBe(true);
    await second.store.syncDirtyResources();
    expect(second.posted.map(c => c.destroy)).toEqual([true]);
    expect(second.store.outbox.hasPending(doc.subject)).toBe(false);
    second.store.setServerConnected(false);
  });

  it('moves a queue an older build kept in localStorage into the database', async () => {
    const agent = await newAgent();
    localStorage.setItem(
      `atomic.outbox.${agent.subject}`,
      JSON.stringify([
        { subject: 'did:ad:pending-edit', enqueuedAt: 3, baseVersion: 'AAEC' },
      ]),
    );
    const db = new FakeClientDb();
    const { store } = await tab(agent, db, false);

    expect(store.outbox.getEntry('did:ad:pending-edit')?.baseVersion).toBe(
      'AAEC',
    );
    expect(db.queued(agent.subject!)).toEqual([
      { subject: 'did:ad:pending-edit', enqueuedAt: 3, baseVersion: 'AAEC' },
    ]);
    expect(localStorage.getItem(`atomic.outbox.${agent.subject}`)).toBeNull();
  });

  it('keeps using localStorage with a database that has no outbox', async () => {
    const agent = await newAgent();
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setAgent(agent);
    store.setClientDb({
      isReady: true,
      putResourceWithSnapshot: async () => undefined,
    } as unknown as ClientDbWorker);
    await store.outbox.whenHydrated();

    store.outbox.markDirty('did:ad:x');
    await store.outbox.flush();

    expect(localStorage.getItem(`atomic.outbox.${agent.subject}`)).toContain(
      'did:ad:x',
    );
  });
});
