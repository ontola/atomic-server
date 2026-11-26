import { afterEach, expect, it, vi } from 'vitest';
import { NodeClientDb } from './client-db.node.js';

const db = vi.hoisted(() => ({
  getResourceVaultEvidence: vi.fn(),
  getResourceVaultGeneration: vi.fn(),
  putResourceVaultReceipts: vi.fn(),
  clearResourceVaultReceipts: vi.fn(),
  flush: vi.fn(),
}));
vi.mock('./client-db-open.js', () => ({
  openClientDb: async () => ({ db }),
  isStorageBlockedDbError: () => false,
}));
const scope = {
  managedAccount: 'alice@example.test',
  agent: 'atomic:alice',
  portalUrl: 'https://portal.example/api',
  drive: 'atomic:drive',
  drivePseudonym: 'vault',
  keyEpoch: 1,
};
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
    db.getResourceVaultEvidence.mockImplementation(() => {
      order.push('stored bytes');

      return evidence;
    });
    db.flush.mockImplementation(() => {
      order.push('flush');
      if (fail) throw new Error('disk unavailable');
    });
    const result = await send({
      type: 'getResourceVaultEvidence',
      subjects: ['atomic:test'],
      scope,
    });
    expect(order).toEqual(['stored bytes', 'flush']);
    expect(result.type).toBe(fail ? 'error' : 'ok');
    expect(db.getResourceVaultEvidence).toHaveBeenCalledWith(
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
  db.putResourceVaultReceipts.mockImplementation(() => {
    order.push('merge');

    return true;
  });
  db.flush.mockImplementation(() => order.push('flush'));
  expect(
    (
      await send({
        type: 'putResourceVaultReceipts',
        scope,
        generation: 0,
        receipts,
      })
    ).type,
  ).toBe('ok');
  expect(order).toEqual(['merge', 'flush']);
  expect(db.putResourceVaultReceipts).toHaveBeenCalledWith(
    JSON.stringify(scope),
    JSON.stringify(receipts),
    0,
  );
});

it('Node adapter forwards scope and stored bytes and rejects a failed flush', async () => {
  const adapter = new NodeClientDb({ wasmPath: '/unused.wasm' });
  Object.assign(adapter, { db });
  db.getResourceVaultEvidence.mockReturnValue(evidence);
  expect(
    await adapter.getResourceVaultEvidence(['atomic:test'], scope),
  ).toEqual(evidence);
  expect(db.flush).toHaveBeenCalledOnce();
  db.flush.mockImplementation(() => {
    throw new Error('flush failed');
  });
  await expect(
    adapter.getResourceVaultEvidence(['atomic:test'], scope),
  ).rejects.toThrow('flush failed');
});

it('Node adapter treats an older WASM as unsupported, without guessing evidence', async () => {
  const adapter = new NodeClientDb({ wasmPath: '/unused.wasm' });
  const oldDb = { flush: vi.fn() };
  Object.assign(adapter, { db: oldDb });
  expect(
    await adapter.getResourceVaultEvidence(['atomic:test'], scope),
  ).toBeUndefined();
  await adapter.putResourceVaultReceipts(scope, [], 0);
  expect(oldDb.flush).not.toHaveBeenCalled();
});

it('worker reports unsupported old WASM without a flush or fallback read', async () => {
  const send = await workerHarness();
  const read = db.getResourceVaultEvidence;
  const write = db.putResourceVaultReceipts;
  Object.assign(db, {
    getResourceVaultEvidence: undefined,
    putResourceVaultReceipts: undefined,
  });

  try {
    const result = await send({
      type: 'getResourceVaultEvidence',
      subjects: ['atomic:test'],
      scope,
    });
    expect(result).toMatchObject({ type: 'ok', data: undefined });
    expect(
      (
        await send({
          type: 'putResourceVaultReceipts',
          scope,
          generation: 0,
          receipts: [],
        })
      ).type,
    ).toBe('ok');
    expect(db.flush).not.toHaveBeenCalled();
  } finally {
    Object.assign(db, {
      getResourceVaultEvidence: read,
      putResourceVaultReceipts: write,
    });
  }
});

it('worker retries a backend durability failure without returning false evidence', async () => {
  const send = await workerHarness();
  db.getResourceVaultEvidence.mockImplementation(() => {
    throw new Error('WASM flush failed');
  });
  expect(
    (
      await send({
        type: 'getResourceVaultEvidence',
        subjects: ['atomic:test'],
      })
    ).type,
  ).toBe('error');
  expect(db.flush).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(db.flush).toHaveBeenCalledOnce();
});

it('clears a disabled vault scope durably before replying', async () => {
  const send = await workerHarness();
  const order: string[] = [];
  db.clearResourceVaultReceipts.mockImplementation(() => order.push('clear'));
  db.flush.mockImplementation(() => order.push('flush'));
  expect((await send({ type: 'clearResourceVaultReceipts', scope })).type).toBe(
    'ok',
  );
  expect(db.clearResourceVaultReceipts).toHaveBeenCalledWith(
    JSON.stringify(scope),
  );
  expect(order).toEqual(['clear', 'flush']);
});

it('captures a durable generation and returns a stale write rejection separately from storage failure', async () => {
  const send = await workerHarness();
  db.getResourceVaultGeneration.mockReturnValue(3);
  expect(
    await send({ type: 'getResourceVaultGeneration', scope }),
  ).toMatchObject({ type: 'ok', data: 3 });
  db.putResourceVaultReceipts.mockReturnValue(false);
  expect(
    await send({
      type: 'putResourceVaultReceipts',
      scope,
      receipts: [],
      generation: 2,
    }),
  ).toMatchObject({ type: 'ok', data: false });
  db.putResourceVaultReceipts.mockImplementation(() => {
    throw new Error('disk unavailable');
  });
  expect(
    await send({
      type: 'putResourceVaultReceipts',
      scope,
      receipts: [],
      generation: 3,
    }),
  ).toMatchObject({ type: 'error', message: 'disk unavailable' });
});

it('older Node WASM cannot supply a generation or accept receipt writes', async () => {
  const adapter = new NodeClientDb({ wasmPath: '/unused.wasm' });
  Object.assign(adapter, { db: { flush: vi.fn() } });
  expect(await adapter.getResourceVaultGeneration(scope)).toBeUndefined();
  expect(await adapter.putResourceVaultReceipts(scope, [], 0)).toBe(false);
});
