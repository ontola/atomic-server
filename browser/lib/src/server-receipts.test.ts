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
  const store = {
    resources: new Map([[subject, { get: () => drive, getClasses: () => [] }]]),
    getAgent: () => ({ subject: 'atomic:agent:test' }),
    getIdentityGeneration: () => state.identity,
    getClientDbGeneration: () => state.database,
    getClientDb: () => ({ getReplicaIdentity: getSource }),
    getServerReceiptTransport: () => (state.active ? transport : undefined),
    notifyServerReplicaReceipt: emit,
  } as unknown as Store;
  const requests = new ServerReceiptRequests(store);

  return { requests, request, emit, state, getSource, transport };
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

  it('bounds stalled source lookups and releases slots on reset', async () => {
    const h = harness();
    h.getSource.mockImplementation(() => new Promise(() => {}));
    for (let i = 1; i <= 5; i++) h.requests.observe(saved(i));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.getSource).toHaveBeenCalledTimes(4);
    h.requests.reset();
    h.getSource.mockResolvedValue(undefined);
    h.requests.observe(saved(6));
    await vi.advanceTimersByTimeAsync(300);
    expect(h.emit).toHaveBeenCalledOnce();
    expect(h.emit.mock.calls[0][0].observation.barrier.version).toBe(vv(6));
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
