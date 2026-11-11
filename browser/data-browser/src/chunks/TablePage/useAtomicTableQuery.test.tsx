// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { unknownSubject } from '@tomic/lib';
import type { TableQuery } from '@tomic/table';
import { useAtomicTableQuery } from './useAtomicTableQuery';

const backend = vi.hoisted(() => ({
  useCollection: vi.fn(),
  refresh: vi.fn(async () => {}),
  collection: { totalMembers: 250 },
}));
vi.mock('@tomic/react', async () => ({
  unknownSubject: (await import('@tomic/lib')).unknownSubject,
  useCollection: backend.useCollection,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('keeps stale collections unready until class scope is known, then delegates paging and refresh', () => {
  backend.useCollection.mockReturnValue({
    collection: backend.collection,
    ready: true,
    invalidateCollection: backend.refresh,
    mapAll: () => [],
  });
  const initial: TableQuery = {
    scope: { table: 'table:one' },
    filters: [],
    expressionFilters: [],
    pageSize: 30,
  };
  const { result, rerender } = renderHook(
    ({ query }) => useAtomicTableQuery(query, 'https://host.example'),
    { initialProps: { query: initial } },
  );
  expect(result.current.ready).toBe(false);
  expect(backend.useCollection.mock.lastCall?.[0].value).toBeUndefined();
  rerender({
    query: {
      ...initial,
      scope: { table: 'table:one', rowClass: unknownSubject },
    },
  });
  expect(result.current.ready).toBe(false);
  rerender({
    query: {
      ...initial,
      scope: { table: 'table:two', rowClass: 'class:row', drive: 'drive:two' },
      pageSize: 100,
    },
  });
  expect(result.current.ready).toBe(true);
  expect(result.current.collection).toBe(backend.collection);
  expect(result.current.invalidateCollection).toBe(backend.refresh);
  expect(backend.useCollection.mock.lastCall?.[0]).toMatchObject({
    value: 'table:two',
    drive: 'drive:two',
  });
  expect(backend.useCollection.mock.lastCall?.[1]).toEqual({
    pageSize: 100,
    server: 'https://host.example',
  });
});
