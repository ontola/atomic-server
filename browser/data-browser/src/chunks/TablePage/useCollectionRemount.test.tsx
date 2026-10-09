// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { Collection, Store } from '@tomic/lib';
import { StoreContext, useCollection } from '@tomic/react';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const filter = { property: 'https://x.test/parent', value: 'atomic:parent' };

function fakeRefresh(delayMs: number) {
  vi.spyOn(Collection.prototype, 'refresh').mockImplementation(
    function (this: Collection) {
      const self = this as unknown as { _totalMembers: number };

      return new Promise<void>(resolve =>
        setTimeout(() => {
          self._totalMembers = 4;
          resolve();
        }, delayMs),
      );
    },
  );
}

const wait = (ms: number) =>
  act(async () => {
    await new Promise(r => setTimeout(r, ms));
  });

it('shows the last loaded rows at once when the same query remounts', async () => {
  const store = new Store({ serverUrl: 'http://localhost:9883' });
  // Every new collection starts empty and fills after a delay, like a query
  // that has to go through the worker or the network.
  fakeRefresh(20);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(StoreContext.Provider, { value: store }, children);

  const first = renderHook(() => useCollection(filter), { wrapper });
  expect(first.result.current.ready).toBe(false);
  expect(first.result.current.collection.totalMembers).toBe(0);
  await wait(40);
  expect(first.result.current.ready).toBe(true);
  expect(first.result.current.collection.totalMembers).toBe(4);
  first.unmount();

  const second = renderHook(() => useCollection(filter), { wrapper });
  // Synchronously, before anything has been fetched again.
  expect(second.result.current.ready).toBe(true);
  expect(second.result.current.collection.totalMembers).toBe(4);
  await wait(40);
  expect(second.result.current.collection.totalMembers).toBe(4);
});

it('does not borrow rows from a different query', async () => {
  const store = new Store({ serverUrl: 'http://localhost:9883' });
  fakeRefresh(0);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(StoreContext.Provider, { value: store }, children);

  const first = renderHook(() => useCollection(filter), { wrapper });
  await wait(10);
  first.unmount();

  const other = renderHook(
    () => useCollection({ ...filter, value: 'atomic:other' }),
    { wrapper },
  );
  expect(other.result.current.ready).toBe(false);
});
