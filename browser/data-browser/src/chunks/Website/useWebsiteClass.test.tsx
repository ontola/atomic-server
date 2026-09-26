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
): Store {
  return {
    getResource: read,
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
