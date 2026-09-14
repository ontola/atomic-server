import { it, expect, vi } from 'vitest';
import { continueBrowserSync, type SyncSession } from './browser-sync';
const initial = (): SyncSession => ({
  proposal: {},
  connection: { revision: 0, records: {}, cursor: null },
});
it('persists uncertainty before dispatch and refuses to replay a lost response', async () => {
  let saved = initial();
  const host = {
    save: (s: SyncSession) => {
      saved = structuredClone(s);
    },
    step: vi.fn(
      async () =>
        ({
          kind: 'effect',
          cursor: 1,
          effect: {
            kind: 'external',
            id: 'create',
            request: {
              id: 'create',
              operation: 'create',
              method: 'POST',
              url: 'https://example.com/items',
            },
          },
        }) as const,
    ),
    external: vi.fn(async () => {
      expect(saved.pending?.id).toBe('create');
      throw Error('Lost response');
    }),
    atomic: vi.fn(),
  };
  await expect(continueBrowserSync(initial(), host)).rejects.toThrow(
    'Lost response',
  );
  await expect(continueBrowserSync(saved, host)).rejects.toThrow('uncertain');
  expect(host.external).toHaveBeenCalledTimes(1);
});
it('checkpoints only converged projections and retains prior bindings', async () => {
  const state = initial();
  state.connection.records.old = { local: 'old', baseline: {} };
  const host = {
    save: vi.fn(),
    external: vi.fn(),
    atomic: vi.fn(),
    step: vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'effect',
        cursor: 1,
        effect: {
          kind: 'checkpoint',
          id: 'checkpoint',
          records: [
            {
              remote: 'new',
              local: 'row',
              local_projection: { a: 1 },
              remote_projection: { a: 1 },
            },
          ],
        },
      })
      .mockResolvedValue({ kind: 'complete' }),
  };
  const result = await continueBrowserSync(state, host);
  expect(result.complete).toBe(true);
  expect(result.connection.revision).toBe(1);
  expect(Object.keys(result.connection.records)).toEqual(['old', 'new']);
  host.step.mockReset().mockResolvedValue({
    kind: 'effect',
    cursor: 1,
    effect: {
      kind: 'checkpoint',
      id: 'checkpoint',
      records: [
        {
          remote: 'new',
          local: 'row',
          local_projection: { a: 1 },
          remote_projection: { a: 2 },
        },
      ],
    },
  });
  await expect(continueBrowserSync(state, host)).rejects.toThrow('converged');
});
