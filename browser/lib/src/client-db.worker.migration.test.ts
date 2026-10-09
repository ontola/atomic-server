import { afterEach, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  indexMigrationPending: vi.fn(),
  migrateIndexKeysStep: vi.fn(),
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

it('rebuilds the indexes in slices before init is acknowledged, reporting each one', async () => {
  const steps = [
    { done: 100, total: 250, finished: false },
    { done: 200, total: 250, finished: false },
    { done: 250, total: 250, finished: true },
  ];
  db.indexMigrationPending.mockReturnValue(true);
  db.migrateIndexKeysStep.mockImplementation(() =>
    JSON.stringify(steps.shift()),
  );

  const posted: Array<Record<string, unknown>> = [];
  const worker = {
    onmessage: null as unknown as (event: unknown) => void,
    postMessage: vi.fn((value: Record<string, unknown>) => posted.push(value)),
  };
  vi.stubGlobal('self', worker);
  await import('./client-db.worker.js');

  worker.onmessage({
    data: {
      id: 1,
      type: 'init',
      wasmUrl: 'data:text/javascript,export default async function() {}',
    },
  });
  await vi.waitFor(() => expect(posted.some(m => m.id === 1)).toBe(true));

  const progress = posted
    .filter(m => m.type === 'migration-progress')
    .map(m => [m.done, m.total, m.finished]);
  expect(progress).toEqual([
    [0, 0, false],
    [100, 250, false],
    [200, 250, false],
    [250, 250, true],
  ]);
  // The acknowledgement comes after the last slice.
  expect(posted.at(-1)).toMatchObject({ id: 1, type: 'ok' });
  expect(db.migrateIndexKeysStep).toHaveBeenCalledWith(100);
});

it('does nothing for a database that is already current', async () => {
  db.indexMigrationPending.mockReturnValue(false);
  const posted: Array<Record<string, unknown>> = [];
  const worker = {
    onmessage: null as unknown as (event: unknown) => void,
    postMessage: vi.fn((value: Record<string, unknown>) => posted.push(value)),
  };
  vi.stubGlobal('self', worker);
  await import('./client-db.worker.js');

  worker.onmessage({
    data: {
      id: 1,
      type: 'init',
      wasmUrl: 'data:text/javascript,export default async function() {}',
    },
  });
  await vi.waitFor(() => expect(posted.some(m => m.id === 1)).toBe(true));

  expect(posted.some(m => m.type === 'migration-progress')).toBe(false);
  expect(db.migrateIndexKeysStep).not.toHaveBeenCalled();
});
