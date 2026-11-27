import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeServerReceipt,
  ServerReceiptRequests,
  type ServerReceiptRequest,
  type ServerReceiptTransport,
  type ServerReceiptWire,
} from './server-receipts.js';
import { LoroLoader } from './loro-loader.js';
import { encodeB64 } from './base64.js';
import { PEER_STORAGE_BARRIER } from './ws-v2.js';
import { StoreEvents, type Store } from './store.js';
import { testStore } from './test-store.js';

const drive = 'atomic:receipt-drive';
const subject = 'atomic:receipt-resource';
const replica = { storageId: 'a'.repeat(64), generation: 'b'.repeat(64) };
const vv = (counter = 1) =>
  encodeB64(
    new LoroLoader.Loro.VersionVector(new Map([['1', counter]])).encode(),
  );
const reply = (request: ServerReceiptRequest): ServerReceiptWire => ({
  ...request,
  replica,
  barrier: PEER_STORAGE_BARRIER,
});
const saved = (counter = 1) => ({
  status: 'persisted' as const,
  subject,
  server: {
    endpoint: 'https://server.test/commit',
    commit: `atomic:commit-${counter}`,
    version: vv(counter),
  },
});

function harness(kind: 'http' | 'websocket' = 'http') {
  const state = { identity: 1, database: 1, active: true };
  const getSource = vi
    .fn<() => Promise<typeof replica | undefined>>()
    .mockResolvedValue(undefined);
  const request = vi
    .fn<ServerReceiptTransport['request']>()
    .mockImplementation(async r => reply(r));
  const emit = vi.fn();
  const transport: ServerReceiptTransport = {
    endpoint: 'https://server.test/storage-receipt',
    transport: kind,
    connectionId: 'session-1',
    current: () => state.active,
    request,
  };
  const snapshots = new Map<string, Uint8Array>();
  const getDriveSubjects = vi.fn(async () => [...snapshots.keys()]);
  const getResourceWithSnapshot = vi.fn(async (resource: string) => ({
    jsonAd: null,
    snapshot: snapshots.get(resource),
  }));
  const db = {
    getReplicaIdentity: getSource,
    getDriveSubjects,
    getResourceWithSnapshot,
  };
  let currentDb = db;
  const store = {
    resources: new Map([[subject, { get: () => drive, getClasses: () => [] }]]),
    getAgent: () => ({ subject: 'atomic:agent:test' }),
    getIdentityGeneration: () => state.identity,
    getClientDbGeneration: () => state.database,
    getClientDb: () => currentDb,
    getServerReceiptTransport: () => (state.active ? transport : undefined),
    notifyServerReplicaReceipt: emit,
  } as unknown as Store;
  const requests = new ServerReceiptRequests(store);

  return {
    requests,
    request,
    emit,
    state,
    getSource,
    transport,
    snapshots,
    getDriveSubjects,
    getResourceWithSnapshot,
    db,
    setDb: (next: typeof db) => {
      currentDb = next;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('automatic server receipts', () => {
  it('emits frozen remote evidence without inventing a memory source identity', async () => {
    const h = harness();
    h.requests.observe(saved());
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request).toHaveBeenCalledOnce();
    const event = h.emit.mock.calls[0][0];
    expect(event.source).toBeUndefined();
    expect(event.observation.barrier.version).toBe(vv());
    expect(event.serverOrigin).toBe('https://server.test');
    expect(event.transport).toBe('http');
    for (const value of [
      event,
      event.observation,
      event.observation.replica,
      event.observation.barrier,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    h.requests.reset();
  });

  it('retains C1 while C2 completes first', async () => {
    const h = harness();
    let release!: () => void;
    h.request.mockImplementationOnce(
      r =>
        new Promise(resolve => {
          release = () => resolve(reply(r));
        }),
    );
    h.requests.observe(saved(1));
    await vi.advanceTimersByTimeAsync(1);
    h.requests.observe(saved(2));
    await vi.advanceTimersByTimeAsync(300);
    expect(h.emit.mock.calls[0][0].observation.barrier.version).toBe(vv(2));
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.emit.mock.calls[1][0].observation.barrier.version).toBe(vv(1));
    h.requests.reset();
  });

  it.each(['nonce', 'drive', 'subject', 'version'] as const)(
    'rejects changed correlated %s',
    async field => {
      const h = harness();
      h.request.mockImplementation(async r => ({
        ...reply(r),
        [field]: field === 'version' ? vv(2) : 'changed',
      }));
      h.requests.observe(saved());
      await vi.advanceTimersByTimeAsync(1);
      expect(h.emit).not.toHaveBeenCalled();
      h.requests.reset();
    },
  );

  it.each(['nonce', 'storageId', 'generation'])(
    'rejects array-coerced %s and incomplete barriers',
    field => {
      const data = reply({
        nonce: 'c'.repeat(64),
        drive,
        subject,
        version: vv(),
      });
      const malformed =
        field === 'nonce'
          ? { ...data, nonce: [data.nonce] }
          : {
              ...data,
              replica: {
                ...replica,
                [field]: [replica[field as keyof typeof replica]],
              },
            };
      expect(decodeServerReceipt(JSON.stringify(malformed))).toBeUndefined();
      expect(
        decodeServerReceipt(JSON.stringify({ ...data, barrier: 'accepted' })),
      ).toBeUndefined();
      expect(decodeServerReceipt(JSON.stringify(data))).toBeDefined();
    },
  );

  it('fences away/back identities, database changes, and replaced sessions after awaits', async () => {
    for (const change of ['identity', 'database', 'session']) {
      const h = harness();
      let release!: () => void;
      h.request.mockImplementationOnce(
        r =>
          new Promise(resolve => {
            release = () => resolve(reply(r));
          }),
      );
      h.requests.observe(saved());
      await vi.advanceTimersByTimeAsync(1);
      if (change === 'identity') h.state.identity += 2;
      else if (change === 'database') h.state.database += 2;
      else h.state.active = false;
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.emit).not.toHaveBeenCalled();
      h.requests.reset();
    }
  });

  it('bounds unresolved identity calls across timeouts and same-database resets', async () => {
    const h = harness();
    h.getSource.mockImplementation(() => new Promise(() => {}));
    for (let i = 1; i <= 12; i++) h.requests.observe(saved(i));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.getSource).toHaveBeenCalledTimes(4);
    h.requests.reset();
    h.requests.observe(saved(13));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.getSource).toHaveBeenCalledTimes(4);

    h.requests.reset();
    h.state.database++;
    h.setDb({
      ...h.db,
      getReplicaIdentity: vi.fn().mockResolvedValue(undefined),
    });
    h.requests.observe(saved(14));
    await vi.advanceTimersByTimeAsync(300);
    expect(h.emit).toHaveBeenCalledOnce();
    expect(h.emit.mock.calls[0][0].observation.barrier.version).toBe(vv(14));
    h.requests.reset();
  });

  it('bounds failed attempts and rotates reconciliation beyond the first32 targets', async () => {
    const failing = harness();
    failing.request.mockResolvedValue(undefined);
    failing.requests.observe(saved());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failing.request).toHaveBeenCalledTimes(3);
    failing.requests.reset();
    const h = harness('websocket');
    const resources = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [
        `atomic:resource-${i.toString().padStart(3, '0')}`,
        [1],
      ]),
    );
    const doc = new LoroLoader.Loro.LoroDoc();
    doc.setPeerId('1');
    doc.getMap('properties').set('name', 'stored');
    for (const resource of Object.keys(resources))
      h.snapshots.set(resource, doc.export({ mode: 'snapshot' }));
    h.requests.seed('https://server.test/commit', {
      drive,
      driveHash: '',
      peers: ['1'],
      resources,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      new Set(h.emit.mock.calls.map(([e]) => e.observation.barrier.subject))
        .size,
    ).toBe(300);
    h.requests.reset();
  });

  it('refreshes stored frontiers after imports without observing a save', async () => {
    const h = harness('websocket');
    const doc = new LoroLoader.Loro.LoroDoc();
    doc.setPeerId('1');
    doc.getMap('properties').set('name', 'C1');
    doc.commit();
    h.snapshots.set(subject, doc.export({ mode: 'snapshot' }));
    h.requests.seed('https://server.test/commit', {
      drive,
      driveHash: '',
      peers: ['1'],
      resources: { [subject]: [1] },
    });
    await vi.advanceTimersByTimeAsync(1000);
    doc.getMap('properties').set('name', 'C2');
    doc.commit();
    const expected = encodeB64(doc.version().encode());
    h.snapshots.set(subject, doc.export({ mode: 'snapshot' }));
    await vi.advanceTimersByTimeAsync(31_000);
    expect(
      h.emit.mock.calls.some(
        ([event]) => event.observation.barrier.version === expected,
      ),
    ).toBe(true);
    h.requests.reset();
  });

  it('uses stored applied state instead of supplied inventory or unsaved memory', async () => {
    const h = harness('websocket');
    const doc = new LoroLoader.Loro.LoroDoc();
    doc.setPeerId('1');
    doc.getMap('properties').set('name', 'stored');
    const stored = doc.export({ mode: 'snapshot' });
    const expected = encodeB64(doc.version().encode());
    h.snapshots.set(subject, stored);
    doc.getMap('properties').set('name', 'not stored');
    doc.commit();
    h.requests.seed('https://server.test/commit', {
      drive,
      driveHash: '',
      peers: ['1'],
      resources: { [subject]: [999] },
    });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.request.mock.calls[0][0].version).toBe(expected);
    expect(h.request.mock.calls[0][0].version).not.toBe(
      encodeB64(doc.version().encode()),
    );
    doc.free();
    h.requests.reset();
  });

  it('does not probe an update whose dependencies have not been applied', async () => {
    const h = harness('websocket');
    const doc = new LoroLoader.Loro.LoroDoc();
    doc.setPeerId('1');
    doc.getMap('properties').set('name', 'base');
    doc.commit();
    const base = doc.version();
    doc.getMap('properties').set('name', 'depends on base');
    doc.commit();
    const missingDependencies = doc.export({ mode: 'update', from: base });
    expect(
      LoroLoader.Loro.decodeImportBlobMeta(
        missingDependencies,
        false,
      ).partialEndVersionVector.toJSON().size,
    ).toBeGreaterThan(0);
    h.snapshots.set(subject, missingDependencies);
    h.requests.follow('https://server.test/commit', drive, () => true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.request).not.toHaveBeenCalled();
    h.snapshots.set(subject, doc.export({ mode: 'snapshot' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.request.mock.calls[0][0].version).toBe(
      encodeB64(doc.version().encode()),
    );
    doc.free();
    h.requests.reset();
  });

  it('bounds a hung inventory read and resumes a replacement database without stale work', async () => {
    const h = harness('websocket');
    let release!: (subjects: string[]) => void;
    h.getDriveSubjects.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    h.requests.follow('https://server.test/commit', drive, () => true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.getDriveSubjects).toHaveBeenCalledOnce();
    h.requests.reset(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.getDriveSubjects).toHaveBeenCalledOnce();
    const doc = new LoroLoader.Loro.LoroDoc();
    doc.setPeerId('2');
    doc.getMap('properties').set('name', 'replacement database');
    const next = {
      getReplicaIdentity: vi.fn().mockResolvedValue(undefined),
      getDriveSubjects: vi.fn().mockResolvedValue([subject]),
      getResourceWithSnapshot: vi.fn().mockResolvedValue({
        jsonAd: null,
        snapshot: doc.export({ mode: 'snapshot' }),
      }),
    };
    h.state.database++;
    h.setDb(next);
    h.requests.reset(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.emit).toHaveBeenCalledOnce();
    expect(h.emit.mock.calls[0][0].databaseGeneration).toBe(h.state.database);
    release(['atomic:stale-subject']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.getResourceWithSnapshot).not.toHaveBeenCalled();
    expect(
      h.request.mock.calls.every(([request]) => request.subject === subject),
    ).toBe(true);
    doc.free();
    h.requests.reset();
  });

  it('drops a delayed snapshot and its targets when its drive is no longer followed', async () => {
    const h = harness('websocket');
    const doc = new LoroLoader.Loro.LoroDoc();
    doc.getMap('properties').set('name', 'stored');
    const snapshot = doc.export({ mode: 'snapshot' });
    h.snapshots.set(subject, snapshot);
    let followed = true;
    let release!: () => void;
    h.getResourceWithSnapshot.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = () => resolve({ jsonAd: null, snapshot });
        }),
    );
    h.requests.follow('https://server.test/commit', drive, () => followed);
    await vi.advanceTimersByTimeAsync(1);
    followed = false;
    release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.getResourceWithSnapshot).toHaveBeenCalledOnce();
    doc.free();
    h.requests.reset();
  });

  it.each(['identity', 'database', 'session'] as const)(
    'does not rebind an accepted background target after %s replacement',
    async changed => {
      const h = harness();
      const accepted = h.requests.captureAccepted(
        'https://server.test/commit',
        drive,
        subject,
        vv(),
      );
      if (changed === 'identity') h.state.identity += 2;
      else if (changed === 'database') h.state.database += 2;
      else h.state.active = false;
      accepted();
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.request).not.toHaveBeenCalled();
      h.requests.reset();
    },
  );

  it('pauses a saturated inventory and eventually reaches later stored subjects', async () => {
    const h = harness('websocket');
    const doc = new LoroLoader.Loro.LoroDoc();
    doc.getMap('properties').set('name', 'stored');
    const snapshot = doc.export({ mode: 'snapshot' });
    for (let i = 0; i < 300; i++)
      h.snapshots.set(`atomic:item-${String(i).padStart(3, '0')}`, snapshot);
    h.request.mockImplementation(() => new Promise(() => {}));
    h.requests.follow('https://server.test/commit', drive, () => true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.getResourceWithSnapshot.mock.calls.length).toBeLessThanOrEqual(
      132,
    );
    h.request.mockImplementation(async request => reply(request));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(
      new Set(
        h.emit.mock.calls.map(([event]) => event.observation.barrier.subject),
      ).size,
    ).toBe(300);
    doc.free();
    h.requests.reset();
  });

  it('captures save context before a SaveReceipt listener switches away and back', async () => {
    vi.useRealTimers();
    const { store } = await testStore();
    const resource = await store.newResource({ noParent: true });
    vi.spyOn(resource, 'get').mockReturnValue(drive);
    const send = vi
      .fn<ServerReceiptTransport['request']>()
      .mockImplementation(async r => reply(r));
    vi.spyOn(store, 'getServerReceiptTransport').mockReturnValue({
      endpoint: 'https://server.test/storage-receipt',
      transport: 'http',
      connectionId: 'session',
      current: () => true,
      request: send,
    });
    const agent = store.getAgent();
    store.on(StoreEvents.SaveReceipt, () => {
      store.setAgent(undefined);
      store.setAgent(agent);
    });
    vi.useFakeTimers();
    store.notifySaveReceipt({ ...saved(), subject: resource.subject });
    await vi.advanceTimersByTimeAsync(500);
    expect(send).not.toHaveBeenCalled();
    store.disconnect();
    store.setServerConnected(false);
  });
});
