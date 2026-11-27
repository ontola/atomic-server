import { rowFromLoroSnapshot } from './test-client-db-row.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from './agent.js';
import type { ClientDbOutboxWrite, ClientDbWorker } from './client-db.js';
import type { Commit } from './commit.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { Resource } from './resource.js';
import { Store } from './store.js';
import { LoroLoader } from './loro-loader.js';

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
  supportsDurablePersistence = true;
  /** False while the database is still opening: writes reject until
   *  {@link finishOpening}, as the real one does once it is parked. */
  isOpen = true;
  private openWaiters: Array<(open: boolean) => void> = [];
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

  whenOpen(_timeoutMs: number): Promise<boolean> {
    if (this.isOpen) return Promise.resolve(true);

    return new Promise(resolve => this.openWaiters.push(resolve));
  }

  finishOpening() {
    this.isOpen = true;
    this.openWaiters.splice(0).forEach(resolve => resolve(true));
  }

  async waitForInit() {
    return true;
  }

  async flush() {}

  async putLoroSnapshot(
    subject: string,
    snapshot: Uint8Array,
    lastCommit?: string,
    outbox?: ClientDbOutboxWrite,
  ) {
    if (!this.isOpen) throw new Error('ClientDb unavailable: still opening');
    this.putCalls.push({ subject, outbox });
    this.rows.set(subject, {
      jsonAd: rowFromLoroSnapshot(subject, snapshot, lastCommit),
      snapshot,
    });
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
  const store = new Store({ serverUrl: 'https://example.com', connect: false });
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
  it.each([false, true])(
    'keeps private drafts across reload (local-only: %s)',
    async localOnly => {
      const agent = await newAgent();
      const db = new FakeClientDb();
      const first = await tab(agent, db, true);
      const parent = await first.store.newResource({
        isA: server.classes.drive,
        noParent: true,
        deferGenesis: true,
        propVals: { [core.properties.name]: 'Unsaved parent' },
      });
      if (localOnly) first.store.registerLocalOnlyDrive(parent.subject);
      const child = await first.store.newResource({
        parent: parent.subject,
        deferGenesis: true,
        propVals: { [core.properties.name]: 'Saved child' },
      });
      const receipt = await child.saveWithReceipt();
      expect(receipt.status).toBe('queued');
      expect(receipt.local?.version).toBeTruthy();
      const privateRow = db
        .queued(agent.subject!)
        .find(
          row =>
            (row.privateDraftV1 as { subject?: string } | undefined)
              ?.subject === child.subject,
        );
      expect(privateRow?.subject).toBeUndefined();
      expect(
        (privateRow?.privateDraftV1 as { draft?: unknown })?.draft,
      ).toBeDefined();
      expect(db.rows.has(child.subject)).toBe(false);
      await first.store.syncDirtyResources();
      expect(first.posted).toHaveLength(0);
      first.store.setServerConnected(false);
      const second = await tab(agent, db, false);
      if (localOnly) second.store.registerLocalOnlyDrive(parent.subject);
      const restored = await second.store.getResource(parent.subject);
      expect(restored.get(core.properties.name)).toBe('Unsaved parent');
      second.store.setServerConnected(true);
      await second.store.syncDirtyResources();
      expect(second.posted).toHaveLength(0);
      await restored.save();
      if (localOnly) {
        expect(second.posted).toHaveLength(0);
        expect(db.rows.has(child.subject)).toBe(true);
      } else
        expect(
          second.posted.some(commit => commit.subject === child.subject),
        ).toBe(true);
      expect(second.store.outbox.hasPending(child.subject)).toBe(false);
      second.store.setServerConnected(false);
    },
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'recovers nested drafts (local-only: %s, parent already saved: %s)',
    async (localOnly, saveParentFirst) => {
      const agent = await newAgent();
      const db = new FakeClientDb();
      const first = await tab(agent, db, false);
      const grandparent = await first.store.newResource({
        isA: server.classes.drive,
        noParent: true,
        deferGenesis: true,
        propVals: { [core.properties.name]: 'Grandparent draft' },
      });
      if (localOnly) first.store.registerLocalOnlyDrive(grandparent.subject);
      const parent = await first.store.newResource({
        parent: grandparent.subject,
        deferGenesis: true,
      });
      if (saveParentFirst) await parent.save();
      const child = await first.store.newResource({
        parent: parent.subject,
        deferGenesis: true,
      });
      await child.save();
      expect(
        first.store.outbox.getEntry(parent.subject)?.draft?.waitingForParent,
      ).toBe(grandparent.subject);
      expect(
        first.store.outbox.getEntry(grandparent.subject)?.draft?.held,
      ).toBe(true);
      expect(first.posted).toHaveLength(0);
      const second = await tab(agent, db, false);
      if (localOnly) second.store.registerLocalOnlyDrive(grandparent.subject);
      const restored = await second.store.getResource(grandparent.subject);
      expect(restored.get(core.properties.name)).toBe('Grandparent draft');
      second.store.setServerConnected(true);
      await second.store.syncDirtyResources();
      expect(second.posted).toHaveLength(0);
      await restored.save();

      for (const subject of [parent.subject, child.subject]) {
        expect(second.store.outbox.hasPending(subject)).toBe(false);
        if (localOnly) expect(db.rows.has(subject)).toBe(true);
        else
          expect(second.posted.some(commit => commit.subject === subject)).toBe(
            true,
          );
      }

      second.store.setServerConnected(false);
    },
  );

  it('does not confirm a child when its ancestor checkpoint fails', async () => {
    const agent = await newAgent();
    const db = new FakeClientDb();
    const { store } = await tab(agent, db, false);
    const parent = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
      deferGenesis: true,
    });
    const child = await store.newResource({
      parent: parent.subject,
      deferGenesis: true,
    });
    const write = vi
      .spyOn(db, 'outboxWrite')
      .mockRejectedValue(new Error('Disk full'));
    await expect(child.saveWithReceipt()).rejects.toThrow('Disk full');
    expect(store.outbox.getEntry(child.subject)).toBeUndefined();
    write.mockRestore();
    const receipt = await child.saveWithReceipt();
    expect(receipt.local?.version).toBeTruthy();
    expect(receipt.status).toBe('queued');
  });

  it('rejects cyclic draft ancestry without writing or publishing it', async () => {
    const agent = await newAgent();
    const db = new FakeClientDb();
    const { store, posted } = await tab(agent, db, false);
    const parent = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
      deferGenesis: true,
    });
    const child = await store.newResource({
      parent: parent.subject,
      deferGenesis: true,
    });
    await parent.set(core.properties.parent, child.subject, false);
    await expect(child.save()).rejects.toThrow('cyclic draft parent chain');
    expect(db.queued(agent.subject!)).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('recovers an offline edit before overwriting its checkpoint on reconnect', async () => {
    const agent = await newAgent();
    const db = new FakeClientDb();
    const first = await tab(agent, db, true);
    const resource = await first.store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'Server title' },
    });
    await resource.save();
    const subject = resource.subject;
    const serverSnapshot = resource.getLoroDoc()!.export({ mode: 'snapshot' });
    const lastCommit = resource.getLastCommitForChain();
    first.store.setServerConnected(false);
    await resource.set(core.properties.name, 'Offline title', false);
    await resource.save();
    expect(JSON.parse(db.rows.get(subject)!.jsonAd)[core.properties.name]).toBe(
      'Offline title',
    );

    const second = await tab(agent, db, false);
    const stale = new Resource(subject);
    stale.setStore(second.store);
    stale.importLoroUpdate(serverSnapshot, true);
    if (lastCommit) stale.setLastCommitValue(lastCommit);
    stale.loading = false;
    second.store.addResource(stale);
    expect(second.store.outbox.hasPending(subject)).toBe(true);
    expect(JSON.parse(db.rows.get(subject)!.jsonAd)[core.properties.name]).toBe(
      'Offline title',
    );
    second.store.setServerConnected(true);
    await second.store.syncDirtyResources();
    second.store.setServerConnected(false);

    expect({
      title: JSON.parse(db.rows.get(subject)!.jsonAd)[core.properties.name],
      posted: second.posted.length,
      pending: second.store.outbox.hasPending(subject),
    }).toEqual({ title: 'Offline title', posted: 1, pending: false });
  });

  it('merges an offline checkpoint without discarding edits made during the read', async () => {
    const agent = await newAgent();
    const db = new FakeClientDb();
    const { store } = await tab(agent, db, true);
    const resource = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'Initial title' },
    });
    await resource.save();
    store.setServerConnected(false);
    await resource.set(core.properties.name, 'Offline edit', false);
    await resource.save();

    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => {
      enter = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const original = db.getResourceWithSnapshot.bind(db);
    vi.spyOn(db, 'getResourceWithSnapshot').mockImplementationOnce(
      async subject => {
        const row = await original(subject);
        enter();
        await gate;

        return row;
      },
    );
    store.setServerConnected(true);
    const syncing = store.syncDirtyResources();
    await entered;

    try {
      await resource.set(
        core.properties.name,
        'Edit made during recovery',
        false,
      );
      resource.getLoroDoc()!.commit();
    } finally {
      release();
    }

    await syncing;
    store.setServerConnected(false);
    expect(resource.get(core.properties.name)).toBe(
      'Edit made during recovery',
    );
    expect(
      JSON.parse(db.rows.get(resource.subject)!.jsonAd)[core.properties.name],
    ).toBe('Edit made during recovery');
  });

  it('keeps a newer online edit that arrives during the pre-delivery write', async () => {
    const agent = await newAgent();
    const db = new FakeClientDb();
    const { store } = await tab(agent, db, true);
    const resource = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'Initial title' },
    });
    await resource.save();

    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => {
      enter = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const write = db.putLoroSnapshot.bind(db);
    vi.spyOn(db, 'putLoroSnapshot').mockImplementationOnce(async (...args) => {
      enter();
      await gate;
      await write(...args);
    });

    await resource.set(core.properties.name, 'First edit', false);
    const saving = resource.save();
    await entered;

    try {
      await resource.set(core.properties.name, 'Later edit', false);
      resource.getLoroDoc()!.commit();
    } finally {
      release();
    }

    await saving;
    await store.syncDirtyResources();
    store.setServerConnected(false);
    expect(resource.get(core.properties.name)).toBe('Later edit');
    expect(
      JSON.parse(db.rows.get(resource.subject)!.jsonAd)[core.properties.name],
    ).toBe('Later edit');
  });

  it('stores the snapshot and replay cursor before the first online POST', async () => {
    const agent = await newAgent();
    const db = new FakeClientDb();
    const { store, postCommitSpy } = await tab(agent, db, true);
    const resource = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'Online edit' },
    });
    postCommitSpy.mockImplementation(async commit => {
      expect(db.rows.get(resource.subject)?.snapshot).toBeDefined();
      expect(
        db.queued(agent.subject!).find(row => row.subject === resource.subject)
          ?.baseVersion,
      ).toBeDefined();

      return commit;
    });
    await resource.save();
    expect(postCommitSpy).toHaveBeenCalled();
    store.setServerConnected(false);
  });

  it('automatically keeps an existing offline edit without publishing it', async () => {
    const agent = await newAgent();
    const db = new FakeClientDb();
    const { store, posted } = await tab(agent, db, false);
    const resource = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
    });
    await resource.save();
    await resource.set(core.properties.name, 'Automatic local edit', false);
    resource.sealPendingEdits();
    await vi.waitFor(() => {
      const bytes = db.rows.get(resource.subject)?.snapshot;
      const doc = new LoroLoader.Loro.LoroDoc();
      if (bytes) doc.import(bytes);
      expect(doc.getMap('properties').get(core.properties.name)).toBe(
        'Automatic local edit',
      );
      doc.free();
    });
    expect(posted).toHaveLength(0);
  });

  it.each([false, true])(
    'replays edits after an offline genesis on a cold reload (legacy queue: %s)',
    async legacy => {
      const agent = await newAgent();
      const db = new FakeClientDb();
      const first = await tab(agent, db, false);
      const doc = await first.store.newResource({
        isA: server.classes.drive,
        noParent: true,
        propVals: { [core.properties.name]: 'Genesis' },
      });
      await doc.save();
      await doc.set(core.properties.name, 'Later offline edit');
      await doc.save();

      if (legacy) {
        const rows = db.outbox.get(agent.subject!)!;
        const row = JSON.parse(rows.get(doc.subject)!);
        delete row.baseVersion;
        rows.set(doc.subject, JSON.stringify(row));
      }

      const second = await tab(agent, db, false);
      expect(second.store.resources.has(doc.subject)).toBe(false);
      second.store.setServerConnected(true);
      await second.store.syncDirtyResources();
      second.store.setServerConnected(false);
      const remote = new LoroLoader.Loro.LoroDoc();
      for (const commit of second.posted) remote.import(commit.loroUpdate!);
      expect(remote.getMap('properties').get(core.properties.name)).toBe(
        'Later offline edit',
      );
      expect(second.store.outbox.hasPending(doc.subject)).toBe(false);
    },
  );

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

  it('an offline save waits for a database that is still opening', async () => {
    const agent = await newAgent();
    const db = new FakeClientDb();
    db.isOpen = false;
    const { store } = await tab(agent, db, false);

    const doc = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'Made while opening' },
    });
    let outcome: string | undefined;
    const saving = doc.save().then(
      result => (outcome = result),
      e => (outcome = `threw: ${e.message}`),
    );

    // The write has nowhere else to go, so it must not fail while the open
    // is merely slow.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(outcome).toBeUndefined();
    expect(db.putCalls).toHaveLength(0);

    db.finishOpening();
    await saving;
    expect(outcome).toBe('offline');
    expect(db.putCalls.at(-1)?.subject).toBe(doc.subject);
    expect(db.queued(agent.subject!).map(r => r.subject)).toEqual([
      doc.subject,
    ]);
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
    const store = new Store({
      serverUrl: 'https://example.com',
      connect: false,
    });
    store.setAgent(agent);
    store.setClientDb({
      isReady: true,
      putResourceWithSnapshot: async () => undefined,
      putLoroSnapshot: async () => undefined,
    } as unknown as ClientDbWorker);
    await store.outbox.whenHydrated();

    store.outbox.markDirty('did:ad:x');
    await store.outbox.flush();

    expect(localStorage.getItem(`atomic.outbox.${agent.subject}`)).toContain(
      'did:ad:x',
    );
  });
});
