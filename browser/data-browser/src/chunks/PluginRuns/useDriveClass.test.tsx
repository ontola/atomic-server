// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { StoreContext } from '@tomic/react';
import { server, type Store } from '@tomic/lib';
import { useAppClass } from './useDriveClass';

/**
 * An app rendered as a bare list of its properties. `ResourcePage` only reaches
 * `AppPage` while this hook names the drive's `app` class, and a drive resource
 * that failed to read used to arrive as a confident "there is no app class".
 */
const DRIVE = 'atomic:drive';
const ONTOLOGY = 'atomic:ontology';
const APP_CLASS = 'atomic:class-app';

const findSchema = vi.fn();

vi.mock('@tomic/react', async () => {
  const actual =
    await vi.importActual<typeof import('@tomic/react')>('@tomic/react');

  return { ...actual, findSchema: (...args: unknown[]) => findSchema(...args) };
});

const driveResource = (ontology?: string, error?: Error) => ({
  error,
  get: (prop: string) =>
    prop === server.properties.defaultOntology ? ontology : undefined,
});

function storeWhere(
  read: (subject: string) => Promise<unknown>,
  refetch?: (subject: string) => Promise<unknown>,
): Store {
  return {
    getResource: read,
    fetchResourceFromServer: refetch ?? read,
    subscribe: () => () => undefined,
  } as unknown as Store;
}

const wrapper =
  (store: Store) =>
  ({ children }: { children: React.ReactNode }) =>
    React.createElement(StoreContext.Provider, { value: store }, children);

describe('useAppClass', () => {
  it('goes back to the server when the drive read is an errored resource', async () => {
    findSchema.mockResolvedValue({ classes: { app: APP_CLASS } });
    let cached = 0;
    let fetched = 0;
    const store = storeWhere(
      async () => {
        cached++;

        // What a loaded machine leaves in the cache: a resource that failed
        // once and is handed back unchanged for the life of the tab.
        return driveResource(undefined, new Error('could not read the drive'));
      },
      async () => {
        fetched++;

        return driveResource(ONTOLOGY);
      },
    );

    const { result } = renderHook(() => useAppClass(DRIVE), {
      wrapper: wrapper(store),
    });

    await waitFor(() => expect(result.current).toBe(APP_CLASS));
    expect(cached).toBe(1);
    expect(fetched).toBeGreaterThanOrEqual(1);
  });

  it('asks again when the drive read rejects outright', async () => {
    findSchema.mockResolvedValue({ classes: { app: APP_CLASS } });
    let reads = 0;
    const store = storeWhere(async () => {
      reads++;

      if (reads === 1) throw new Error('Async Request timed out after 10000ms');

      return driveResource(ONTOLOGY);
    });

    const { result } = renderHook(() => useAppClass(DRIVE), {
      wrapper: wrapper(store),
    });

    await waitFor(() => expect(result.current).toBe(APP_CLASS));
  });

  it('lets only the server call an ontology absent, then settles', async () => {
    findSchema.mockResolvedValue({ classes: {} });
    let cached = 0;
    let fetched = 0;
    const store = storeWhere(
      async () => {
        cached++;

        return driveResource(undefined);
      },
      async () => {
        fetched++;

        return driveResource(undefined);
      },
    );

    const { result } = renderHook(() => useAppClass(DRIVE), {
      wrapper: wrapper(store),
    });

    // A cached drive with no ontology may simply be incomplete, so it does not
    // get to answer; the server does.
    await waitFor(() => expect(fetched).toBe(1));
    expect(result.current).toBeUndefined();

    // And then it stops. Most drives have no plugin schema at all, and polling
    // for something absent on purpose would cost every page that might be one.
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(cached).toBe(1);
    expect(fetched).toBe(1);
  });

  it('reports a class the drive does have', async () => {
    findSchema.mockResolvedValue({ classes: { app: APP_CLASS } });
    const store = storeWhere(async () => driveResource(ONTOLOGY));

    const { result } = renderHook(() => useAppClass(DRIVE), {
      wrapper: wrapper(store),
    });

    await waitFor(() => expect(result.current).toBe(APP_CLASS));
  });
});
