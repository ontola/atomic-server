// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { StoreContext } from '@tomic/react';
import { core, type Store } from '@tomic/lib';
import { useWebsiteClass } from './useWebsiteClass';

/**
 * A website rendered as a bare list of its properties: `ResourcePage` only
 * reaches `WebsitePage` while this hook names the class, and one failed read
 * used to be indistinguishable from "this is not a website".
 */
const WEBSITE_CLASS = 'atomic:resource:class-website-project';

const classResource = (shortname?: string, error?: Error) => ({
  error,
  get: (prop: string) =>
    prop === core.properties.shortname ? shortname : undefined,
});

function storeWhere(
  read: (subject: string) => Promise<unknown>,
  listeners: (() => void)[] = [],
  refetch?: (subject: string) => Promise<unknown>,
): Store {
  return {
    getResource: read,
    fetchResourceFromServer: refetch ?? read,
    subscribe: (_subject: string, callback: () => void) => {
      listeners.push(callback);

      return () => undefined;
    },
  } as unknown as Store;
}

const wrapper =
  (store: Store) =>
  ({ children }: { children: React.ReactNode }) =>
    React.createElement(StoreContext.Provider, { value: store }, children);

describe('useWebsiteClass', () => {
  it('asks again when the class read rejects', async () => {
    let reads = 0;
    const store = storeWhere(async () => {
      reads++;

      // What a loaded machine produces: `getResource` rejects after its own
      // 10s settle timeout, or because the request was cancelled.
      if (reads === 1) throw new Error('Async Request timed out after 10000ms');

      return classResource('website-project');
    });

    const { result } = renderHook(() => useWebsiteClass(WEBSITE_CLASS), {
      wrapper: wrapper(store),
    });

    await waitFor(() => expect(result.current).toBe(WEBSITE_CLASS));
  });

  it('asks again when the class comes back as an errored resource', async () => {
    let reads = 0;
    const store = storeWhere(async () => {
      reads++;

      return reads === 1
        ? classResource(undefined, new Error('could not read'))
        : classResource('website-project');
    });

    const { result } = renderHook(() => useWebsiteClass(WEBSITE_CLASS), {
      wrapper: wrapper(store),
    });

    await waitFor(() => expect(result.current).toBe(WEBSITE_CLASS));
  });

  // The first version of this fix tried three times and then stopped for good.
  // Under load that is not enough: each `getResource` can take its own 10s
  // timeout, so three tries are spent inside half a minute and the page stays a
  // bare property list for as long as it is open. `website.spec:10` failed that
  // way at line 101, with the version view rendered as a property list.
  it('keeps asking past the third failure', async () => {
    let reads = 0;
    const store = storeWhere(async () => {
      reads++;

      if (reads <= 5) throw new Error('Async Request timed out after 10000ms');

      return classResource('website-project');
    });

    const { result } = renderHook(() => useWebsiteClass(WEBSITE_CLASS), {
      wrapper: wrapper(store),
    });

    // 150 + 300 + 600 + 1200 + 2400 ms of backoff before the sixth read.
    await waitFor(() => expect(result.current).toBe(WEBSITE_CLASS), {
      timeout: 8000,
    });
    expect(reads).toBe(6);
  }, 12_000);

  // `store.getResource` answers from the cache and returns a resource that
  // once failed unchanged, so asking it again is not asking anyone. Without
  // the refetch this test never resolves, however long the hook keeps trying.
  it('goes back to the server once the cached class is an errored one', async () => {
    let cached = 0;
    let fetched = 0;
    const store = storeWhere(
      async () => {
        cached++;

        return classResource(undefined, new Error('could not read'));
      },
      [],
      async () => {
        fetched++;

        return classResource('website-project');
      },
    );

    const { result } = renderHook(() => useWebsiteClass(WEBSITE_CLASS), {
      wrapper: wrapper(store),
    });

    await waitFor(() => expect(result.current).toBe(WEBSITE_CLASS));
    // The first pass reads the cache; only the retry pays for a roundtrip.
    expect(cached).toBe(1);
    expect(fetched).toBe(1);
  });

  it('settles on a resource that is genuinely not a website, without retrying', async () => {
    let reads = 0;
    const store = storeWhere(async () => {
      reads++;

      return classResource('document');
    });

    const { result } = renderHook(
      () => useWebsiteClass('atomic:resource:class-document'),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => expect(reads).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(reads).toBe(1);
    expect(result.current).toBe(undefined);
  });

  it('keeps the class when a later read no longer sees its shortname', async () => {
    let reads = 0;
    const listeners: (() => void)[] = [];
    const store = storeWhere(async () => {
      reads++;

      // The second read lands while the class resource is being replaced by an
      // incoming snapshot, so its propvals are momentarily not there.
      return classResource(reads === 1 ? 'website-project' : undefined);
    }, listeners);

    const { result } = renderHook(() => useWebsiteClass(WEBSITE_CLASS), {
      wrapper: wrapper(store),
    });

    await waitFor(() => expect(result.current).toBe(WEBSITE_CLASS));

    await act(async () => {
      listeners.forEach(notify => notify());
      await waitFor(() => expect(reads).toBeGreaterThan(1));
    });

    expect(result.current).toBe(WEBSITE_CLASS);
  });
});
