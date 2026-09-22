// @vitest-environment jsdom
// @wc-ignore-file
import { describe, it, expect } from 'vitest';
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { StoreContext, useChildren } from '@tomic/react';
import { Store, commits, core, dataBrowser } from '@tomic/lib';

/**
 * Deleting a resource left a "Resource with error" row in the sidebar.
 *
 * The `parent=` query keeps answering with the destroyed child for a moment —
 * the answer was computed before the destroy landed — and every reader that
 * did not itself witness the delete put the row back. Rendering that row is
 * not cosmetic: it asks the store for the resource, which re-created the entry
 * the destroy had removed and showed it as an error.
 *
 * The hook that was mounted when the delete happened always coped. The one
 * mounted afterwards is the case that did not, and in the sidebar those are
 * created constantly — every folder collapsed and expanded makes a new one.
 */
const DRIVE = 'did:ad:resource:drive';
const ALICE = 'did:ad:resource:alice';
const BOB = 'did:ad:resource:bob';

const jsonAd = (subject: string, createdAt: number) =>
  JSON.stringify({
    '@id': subject,
    [core.properties.parent]: DRIVE,
    [core.properties.isA]: [dataBrowser.classes.folder],
    [core.properties.name]: subject.slice('did:ad:resource:'.length),
    [commits.properties.createdAt]: createdAt,
  });

/** A store whose `parent=` query still lists both children, as an answer
 *  produced before the destroy does. */
function staleAnsweringStore() {
  const store = new Store({ serverUrl: 'https://example.com' });
  store.setDrive(DRIVE);
  store.finishDriveSync(DRIVE, 2, Date.now());

  store.setClientDb({
    isReady: true,
    waitForReady: async () => true,
    waitForInit: async () => true,
    query: async () => ({
      subjects: [ALICE, BOB],
      resources: [jsonAd(ALICE, 1000), jsonAd(BOB, 2000)],
      count: 2,
    }),
    flush: async () => undefined,
    putResourceWithSnapshot: async () => undefined,
    removeResource: async () => undefined,
  } as unknown as Parameters<Store['setClientDb']>[0]);

  return store;
}

const wrapper = (store: Store) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      StoreContext.Provider,
      { value: store },
      children,
    );
  };

describe('sidebar children after a delete', () => {
  it('keeps a destroyed child out of a newly mounted list', async () => {
    const store = staleAnsweringStore();
    const mounted = renderHook(() => useChildren(DRIVE), {
      wrapper: wrapper(store),
    });
    await waitFor(() =>
      expect(mounted.result.current.subjects).toEqual([ALICE, BOB]),
    );

    await act(async () => {
      store.removeResource(ALICE);
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    expect(mounted.result.current.subjects).toEqual([BOB]);

    const fresh = renderHook(() => useChildren(DRIVE), {
      wrapper: wrapper(store),
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
    });

    expect(fresh.result.current.subjects).toEqual([BOB]);
    // And the row the sidebar would have rendered never asked the store to
    // re-create the resource.
    expect(store.resources.get(ALICE)).toBeUndefined();
  });

  it('does not re-add a destroyed child that a stale answer hydrates back', async () => {
    const store = staleAnsweringStore();
    const { result } = renderHook(() => useChildren(DRIVE), {
      wrapper: wrapper(store),
    });
    await waitFor(() => expect(result.current.subjects).toEqual([ALICE, BOB]));

    await act(async () => {
      store.removeResource(ALICE);
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    // The listener that adds a child naming this parent — the one that makes
    // a just-created resource appear without re-reading the query — used to
    // take this state at face value.
    await act(async () => {
      store.hydrateResourceFromJsonAd(ALICE, jsonAd(ALICE, 1000));
      await new Promise(resolve => setTimeout(resolve, 300));
    });

    expect(result.current.subjects).toEqual([BOB]);
  });
});
