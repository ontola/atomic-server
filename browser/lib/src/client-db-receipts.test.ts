import { afterEach, expect, it, vi } from 'vitest';
import { NodeClientDb } from './client-db.node.js';

const db = vi.hoisted(() => ({
  getResourceReceipts: vi.fn(),
  putResourceReceipts: vi.fn(),
  getResourceVaultGeneration: vi.fn(),
  clearResourceVaultReceipts: vi.fn(),
  flush: vi.fn(),
}));
vi.mock('./client-db-open.js', () => ({
  openClientDb: async () => ({ db }),
  isStorageBlockedDbError: () => false,
}));
const serverScope = {
  agent: 'atomic:alice',
  serverUrl: 'https://server.example',
};
const vaultScope = {
  managedAccount: 'alice@example.test',
  agent: 'atomic:alice',
  portalUrl: 'https://portal.example/api',
  drive: 'atomic:drive',
  drivePseudonym: 'vault',
  keyEpoch: 1,
};
/** Both destinations share one receipt store and one pair of RPCs. */
const scopes = [
  ['server', { server: serverScope }],
  ['vault', { vault: vaultScope }],
] as const;
const evidence = [
  { subject: 'atomic:test', snapshot: new Uint8Array([1, 2]), receipts: [] },
];

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

it.each(
  scopes.flatMap(([name, scope]) =>
    [false, true].map(fail => [name, scope, fail] as const),
  ),
)(
  'worker evidence crosses the durability barrier (%s, flush fails=%s)',
  async (_, scope, fail) => {
    const send = await workerHarness();
    const order: string[] = [];
    db.getResourceReceipts.mockImplementation(() => {
      order.push('stored bytes');

      return evidence;
    });
    db.flush.mockImplementation(() => {
      order.push('flush');
      if (fail) throw new Error('disk unavailable');
    });
    const result = await send({
      type: 'getResourceReceipts',
      subjects: ['atomic:test'],
      scope,
    });
    expect(order).toEqual(['stored bytes', 'flush']);
    expect(result.type).toBe(fail ? 'error' : 'ok');
    expect(db.getResourceReceipts).toHaveBeenCalledWith(
      '["atomic:test"]',
      JSON.stringify(scope),
    );
  },
);

it.each(scopes)(
  'worker merges %s receipts through the backend and flushes before replying',
  async (_, scope) => {
    const send = await workerHarness();
    const receipts = [
      { subject: 'atomic:test', version: { '1': 3 }, confirmedAt: 10 },
    ];
    const generation = 'vault' in scope ? 0 : undefined;
    const order: string[] = [];
    db.putResourceReceipts.mockImplementation(() => {
      order.push('merge');

      return true;
    });
    db.flush.mockImplementation(() => order.push('flush'));
    expect(
      (await send({ type: 'putResourceReceipts', scope, receipts, generation }))
        .type,
    ).toBe('ok');
    expect(order).toEqual(['merge', 'flush']);
    expect(db.putResourceReceipts).toHaveBeenCalledWith(
      JSON.stringify(scope),
      JSON.stringify(receipts),
      generation,
    );
  },
);

it.each(scopes)(
  'Node adapter forwards the %s scope and stored bytes and rejects a failed flush',
  async (_, scope) => {
    const adapter = new NodeClientDb({ wasmPath: '/unused.wasm' });
    Object.assign(adapter, { db });
    db.getResourceReceipts.mockReturnValue(evidence);
    expect(await adapter.getResourceReceipts(['atomic:test'], scope)).toEqual(
      evidence,
    );
    expect(db.flush).toHaveBeenCalledOnce();
    db.flush.mockImplementation(() => {
      throw new Error('flush failed');
    });
    await expect(
      adapter.getResourceReceipts(['atomic:test'], scope),
    ).rejects.toThrow('flush failed');
  },
);

it('Node adapter reads stored bytes without a scope', async () => {
  const adapter = new NodeClientDb({ wasmPath: '/unused.wasm' });
  Object.assign(adapter, { db });
  db.getResourceReceipts.mockReturnValue(evidence);
  await adapter.getResourceReceipts(['atomic:test']);
  expect(db.getResourceReceipts).toHaveBeenCalledWith(
    '["atomic:test"]',
    undefined,
  );
});

it.each(scopes)(
  'Node adapter treats an older WASM as unsupported for %s, without guessing evidence',
  async (_, scope) => {
    const adapter = new NodeClientDb({ wasmPath: '/unused.wasm' });
    const oldDb = { flush: vi.fn() };
    Object.assign(adapter, { db: oldDb });
    expect(
      await adapter.getResourceReceipts(['atomic:test'], scope),
    ).toBeUndefined();
    expect(await adapter.putResourceReceipts(scope, [], 0)).toBe(false);
    expect(oldDb.flush).not.toHaveBeenCalled();
  },
);

it('worker reports unsupported old WASM without a flush or fallback read', async () => {
  const send = await workerHarness();
  const read = db.getResourceReceipts;
  const write = db.putResourceReceipts;
  Object.assign(db, {
    getResourceReceipts: undefined,
    putResourceReceipts: undefined,
  });

  try {
    const result = await send({
      type: 'getResourceReceipts',
      subjects: ['atomic:test'],
    });
    expect(result).toMatchObject({ type: 'ok', data: undefined });
    expect(
      await send({
        type: 'putResourceReceipts',
        scope: { server: serverScope },
        receipts: [],
      }),
    ).toMatchObject({ type: 'ok', data: false });
    expect(db.flush).not.toHaveBeenCalled();
  } finally {
    Object.assign(db, {
      getResourceReceipts: read,
      putResourceReceipts: write,
    });
  }
});

it('worker retries a backend durability failure without returning false evidence', async () => {
  const send = await workerHarness();
  db.getResourceReceipts.mockImplementation(() => {
    throw new Error('WASM flush failed');
  });
  expect(
    (await send({ type: 'getResourceReceipts', subjects: ['atomic:test'] }))
      .type,
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
  expect(
    (await send({ type: 'clearResourceVaultReceipts', scope: vaultScope }))
      .type,
  ).toBe('ok');
  expect(db.clearResourceVaultReceipts).toHaveBeenCalledWith(
    JSON.stringify(vaultScope),
  );
  expect(order).toEqual(['clear', 'flush']);
});

it('captures a durable generation and returns a stale write rejection separately from storage failure', async () => {
  const send = await workerHarness();
  const scope = { vault: vaultScope };
  db.getResourceVaultGeneration.mockReturnValue(3);
  expect(
    await send({ type: 'getResourceVaultGeneration', scope: vaultScope }),
  ).toMatchObject({ type: 'ok', data: 3 });
  db.putResourceReceipts.mockReturnValue(false);
  expect(
    await send({
      type: 'putResourceReceipts',
      scope,
      receipts: [],
      generation: 2,
    }),
  ).toMatchObject({ type: 'ok', data: false });
  db.putResourceReceipts.mockImplementation(() => {
    throw new Error('disk unavailable');
  });
  expect(
    await send({
      type: 'putResourceReceipts',
      scope,
      receipts: [],
      generation: 3,
    }),
  ).toMatchObject({ type: 'error', message: 'disk unavailable' });
});

it('older Node WASM cannot supply a generation', async () => {
  const adapter = new NodeClientDb({ wasmPath: '/unused.wasm' });
  Object.assign(adapter, { db: { flush: vi.fn() } });
  expect(await adapter.getResourceVaultGeneration(vaultScope)).toBeUndefined();
});
