import { afterEach, expect, it, vi } from 'vitest';
import { NodeClientDb } from './client-db.node.js';

const db = vi.hoisted(() => ({
  getResourceSyncEvidence: vi.fn(),
  putResourceSyncReceipts: vi.fn(),
  flush: vi.fn(),
}));
vi.mock('./client-db-open.js', () => ({
  openClientDb: async () => ({ db }),
  isStorageBlockedDbError: () => false,
}));
const scope = { agent: 'atomic:alice', serverUrl: 'https://server.example' };
const evidence = [{ subject: 'atomic:test', snapshot: new Uint8Array([1, 2]) }];

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

it.each([false, true])(
  'worker evidence crosses the durability barrier (flush fails=%s)',
  async fail => {
    const send = await workerHarness();
    const order: string[] = [];
    db.getResourceSyncEvidence.mockImplementation(() => {
      order.push('stored bytes');

      return evidence;
    });
    db.flush.mockImplementation(() => {
      order.push('flush');
      if (fail) throw new Error('disk unavailable');
    });
    const result = await send({
      type: 'getResourceSyncEvidence',
      subjects: ['atomic:test'],
      scope,
    });
    expect(order).toEqual(['stored bytes', 'flush']);
    expect(result.type).toBe(fail ? 'error' : 'ok');
    expect(db.getResourceSyncEvidence).toHaveBeenCalledWith(
      '["atomic:test"]',
      JSON.stringify(scope),
    );
  },
);

it('worker merges receipts through the backend and flushes before replying', async () => {
  const send = await workerHarness();
  const receipts = [
    { subject: 'atomic:test', version: { '1': 3 }, confirmedAt: 10 },
  ];
  const order: string[] = [];
  db.putResourceSyncReceipts.mockImplementation(() => order.push('merge'));
  db.flush.mockImplementation(() => order.push('flush'));
  expect(
    (await send({ type: 'putResourceSyncReceipts', scope, receipts })).type,
  ).toBe('ok');
  expect(order).toEqual(['merge', 'flush']);
  expect(db.putResourceSyncReceipts).toHaveBeenCalledWith(
    JSON.stringify(scope),
    JSON.stringify(receipts),
  );
});

it('Node adapter forwards scope and stored bytes and rejects a failed flush', async () => {
  const adapter = new NodeClientDb({ wasmPath: '/unused.wasm' });
  Object.assign(adapter, { db });
  db.getResourceSyncEvidence.mockReturnValue(evidence);
  expect(await adapter.getResourceSyncEvidence(['atomic:test'], scope)).toEqual(
    evidence,
  );
  expect(db.flush).toHaveBeenCalledOnce();
  db.flush.mockImplementation(() => {
    throw new Error('flush failed');
  });
  await expect(
    adapter.getResourceSyncEvidence(['atomic:test']),
  ).rejects.toThrow('flush failed');
});

it('Node adapter treats an older WASM as unsupported, without guessing evidence', async () => {
  const adapter = new NodeClientDb({ wasmPath: '/unused.wasm' });
  const oldDb = { flush: vi.fn() };
  Object.assign(adapter, { db: oldDb });
  expect(
    await adapter.getResourceSyncEvidence(['atomic:test']),
  ).toBeUndefined();
  await adapter.putResourceSyncReceipts(scope, []);
  expect(oldDb.flush).not.toHaveBeenCalled();
});

it('worker reports unsupported old WASM without a flush or fallback read', async () => {
  const send = await workerHarness();
  const read = db.getResourceSyncEvidence;
  const write = db.putResourceSyncReceipts;
  Object.assign(db, {
    getResourceSyncEvidence: undefined,
    putResourceSyncReceipts: undefined,
  });

  try {
    const result = await send({
      type: 'getResourceSyncEvidence',
      subjects: ['atomic:test'],
    });
    expect(result).toMatchObject({ type: 'ok', data: undefined });
    expect(
      (await send({ type: 'putResourceSyncReceipts', scope, receipts: [] }))
        .type,
    ).toBe('ok');
    expect(db.flush).not.toHaveBeenCalled();
  } finally {
    Object.assign(db, {
      getResourceSyncEvidence: read,
      putResourceSyncReceipts: write,
    });
  }
});

it('worker retries a backend durability failure without returning false evidence', async () => {
  const send = await workerHarness();
  db.getResourceSyncEvidence.mockImplementation(() => {
    throw new Error('WASM flush failed');
  });
  expect(
    (await send({ type: 'getResourceSyncEvidence', subjects: ['atomic:test'] }))
      .type,
  ).toBe('error');
  expect(db.flush).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(db.flush).toHaveBeenCalledOnce();
});
