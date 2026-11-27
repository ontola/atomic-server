import { afterEach, expect, it, vi } from 'vitest';
import { NodeClientDb } from './client-db.node.js';

const db = vi.hoisted(() => ({
  getReplicaIdentity: vi.fn(),
  handlePeerFrame: vi.fn(),
  flush: vi.fn(),
}));
vi.mock('./client-db-open.js', () => ({
  openClientDb: async () => ({ db }),
  isStorageBlockedDbError: () => false,
}));

const identity = { storageId: 'a'.repeat(64), generation: 'b'.repeat(64) };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
  vi.resetAllMocks();
});

async function workerHarness() {
  vi.useFakeTimers();
  const responses = new Map<number, (value: Record<string, unknown>) => void>();
  const worker = {
    onmessage: null as unknown as (event: unknown) => void,
    postMessage: (value: Record<string, unknown>) =>
      responses.get(value.id as number)?.(value),
  };
  vi.stubGlobal('self', worker);
  await import('./client-db.worker.js');
  let nextId = 0;

  const send = (request: object) => {
    const id = ++nextId;
    const response = new Promise<Record<string, unknown>>(resolve =>
      responses.set(id, resolve),
    );
    worker.onmessage({ data: { ...request, id } });

    return response;
  };

  await send({
    type: 'init',
    wasmUrl: 'data:text/javascript,export default async function() {}',
  });

  return send;
}

it('worker asks the persistent backend for a drive-scoped identity', async () => {
  const send = await workerHarness();
  db.getReplicaIdentity.mockReturnValue(identity);
  expect(
    await send({ type: 'getReplicaIdentity', drive: 'atomic:drive' }),
  ).toMatchObject({ type: 'ok', data: identity });
  expect(db.getReplicaIdentity).toHaveBeenCalledWith('atomic:drive');
});

it('worker does not invent an identity for older WASM', async () => {
  const send = await workerHarness();
  const method = db.getReplicaIdentity;
  Object.assign(db, { getReplicaIdentity: undefined });

  try {
    expect(
      await send({ type: 'getReplicaIdentity', drive: 'atomic:drive' }),
    ).toMatchObject({ type: 'ok', data: undefined });
  } finally {
    Object.assign(db, { getReplicaIdentity: method });
  }
});

it('worker reports an identity durability failure instead of fabricating an ID', async () => {
  const send = await workerHarness();
  db.getReplicaIdentity.mockImplementation(() => {
    throw new Error('identity flush failed');
  });
  expect(
    await send({ type: 'getReplicaIdentity', drive: 'atomic:drive' }),
  ).toMatchObject({ type: 'error', message: 'identity flush failed' });
});

it('worker preserves only the authenticated peer agent reported by the backend', async () => {
  const send = await workerHarness();
  db.handlePeerFrame.mockReturnValue({
    frames: [[0x06]],
    changed: [],
    peerAgent: 'atomic:peer',
  });
  expect(
    await send({
      type: 'handlePeerFrame',
      session: 1,
      frame: new Uint8Array([5]),
    }),
  ).toMatchObject({ type: 'ok', data: { peerAgent: 'atomic:peer' } });
  db.handlePeerFrame.mockReturnValue({ frames: [], changed: [] });
  expect(
    (
      await send({
        type: 'handlePeerFrame',
        session: 1,
        frame: new Uint8Array([5]),
      })
    ).data,
  ).not.toHaveProperty('peerAgent');
});

it('Node adapter forwards an identity but leaves memory and older backends unsupported', async () => {
  const adapter = new NodeClientDb({ wasmPath: '/unused.wasm' });
  Object.assign(adapter, { db });
  db.getReplicaIdentity.mockReturnValue(identity);
  expect(await adapter.getReplicaIdentity('atomic:drive')).toEqual(identity);
  expect(db.getReplicaIdentity).toHaveBeenCalledWith('atomic:drive');
  db.getReplicaIdentity.mockReturnValue(null);
  expect(await adapter.getReplicaIdentity('atomic:drive')).toBeUndefined();
  Object.assign(adapter, { db: {} });
  expect(await adapter.getReplicaIdentity('atomic:drive')).toBeUndefined();
});
