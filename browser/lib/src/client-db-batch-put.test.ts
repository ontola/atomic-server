import { afterEach, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  putResourcesWithSnapshots: vi.fn(),
  outboxWrite: vi.fn(),
  flush: vi.fn(),
}));
vi.mock('./client-db-open.js', () => ({
  openClientDb: async () => ({ db }),
  isStorageBlockedDbError: () => false,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.resetAllMocks();
});

it('writes a batch of resources and their outbox rows with one flush', async () => {
  const responses = new Map<number, (value: Record<string, unknown>) => void>();
  const worker = {
    onmessage: null as unknown as (event: unknown) => void,
    postMessage: (value: Record<string, unknown>) => {
      responses.get(value.id as number)?.(value);
    },
  };
  vi.stubGlobal('self', worker);
  await import('./client-db.worker.js');
  let nextId = 0;

  const send = (request: object) => {
    const id = ++nextId;
    const response = new Promise<Record<string, unknown>>(resolve => {
      responses.set(id, resolve);
    });
    worker.onmessage({ data: { ...request, id } });

    return response;
  };

  await send({
    type: 'init',
    wasmUrl: 'data:text/javascript,export default async function() {}',
  });

  const snapshot = new Uint8Array([1, 2]);
  const reply = await send({
    type: 'putResourcesWithSnapshots',
    items: [
      { jsonAd: '{"@id":"a"}', snapshot },
      {
        jsonAd: '{"@id":"b"}',
        outbox: { agent: 'agent', puts: { b: '{}' }, deletes: [] },
      },
    ],
  });

  expect(reply.type).toBe('ok');
  expect(db.putResourcesWithSnapshots).toHaveBeenCalledWith(
    ['{"@id":"a"}', '{"@id":"b"}'],
    [snapshot, null],
  );
  expect(db.outboxWrite).toHaveBeenCalledTimes(1);
  expect(db.flush).toHaveBeenCalledTimes(1);
});
