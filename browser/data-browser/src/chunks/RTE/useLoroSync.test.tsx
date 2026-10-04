// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook } from '@testing-library/react';
import { StoreContext } from '@tomic/react';
import type { Resource, Store } from '@tomic/lib';
import type { LoroDoc } from 'loro-crdt';
import { useLoroSync } from './useLoroSync';

/**
 * `CursorEphemeralStore` is wasm-backed, so the hook gets a stand-in with the
 * three methods the heartbeat uses. It records what it is asked to encode.
 */
const fakeStore = {
  entries: new Map<string, string>(),
  encoded: [] as string[],
  get(peer: string) {
    return this.entries.get(peer);
  },
  set(peer: string, value: unknown) {
    this.entries.set(peer, value as string);
  },
  encode(peer: string) {
    this.encoded.push(peer);

    return new Uint8Array([1, 2, 3]);
  },
  apply() {},
  subscribeLocalUpdates() {
    return () => undefined;
  },
};

vi.mock('loro-prosemirror', () => ({
  CursorEphemeralStore: class {
    constructor(_peer: string, _timeout: number) {
      return fakeStore as unknown as object;
    }
  },
}));

const PEER = '7';

const doc = {
  peerIdStr: PEER,
  subscribeLocalUpdates: () => () => undefined,
  import: () => undefined,
} as unknown as LoroDoc;

const resource = {
  subject: 'atomic:doc',
  markDirty: () => undefined,
} as unknown as Resource;

function storeSpy() {
  const sent: Uint8Array[] = [];

  return {
    sent,
    store: {
      subscribeLoroSync: () => () => undefined,
      subscribeLoroEphemeral: () => () => undefined,
      broadcastLoroSyncUpdate: () => undefined,
      broadcastLoroEphemeralUpdate: (_subject: string, data: Uint8Array) => {
        sent.push(data);
      },
    } as unknown as Store,
  };
}

const wrapper =
  (store: Store) =>
  ({ children }: { children: React.ReactNode }) =>
    React.createElement(StoreContext.Provider, { value: store }, children);

describe('the collaborative cursor heartbeat', () => {
  beforeEach(() => {
    fakeStore.entries.clear();
    fakeStore.encoded.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A caret move emits exactly one ephemeral frame and nothing replays it, so a
  // frame dropped under load (or discarded because its content had not arrived)
  // used to mean no cursor at all until the collaborator moved again.
  it('re-sends the local cursor while the tab is alive', () => {
    const { sent, store } = storeSpy();
    fakeStore.entries.set(PEER, 'caret');

    renderHook(() => useLoroSync(resource, doc), { wrapper: wrapper(store) });
    expect(sent).toHaveLength(0);

    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(1);
    expect([...sent[0]]).toEqual([1, 2, 3]);
    expect(fakeStore.encoded).toEqual([PEER]);

    vi.advanceTimersByTime(20_000);
    expect(sent).toHaveLength(3);
  });

  // Before the local caret is placed there is no entry to refresh, and sending
  // an empty one would announce a cursor that does not exist.
  it('sends nothing while this tab has no cursor of its own', () => {
    const { sent, store } = storeSpy();

    renderHook(() => useLoroSync(resource, doc), { wrapper: wrapper(store) });
    vi.advanceTimersByTime(30_000);

    expect(sent).toHaveLength(0);
  });

  it('stops when the editor unmounts', () => {
    const { sent, store } = storeSpy();
    fakeStore.entries.set(PEER, 'caret');

    const { unmount } = renderHook(() => useLoroSync(resource, doc), {
      wrapper: wrapper(store),
    });
    vi.advanceTimersByTime(10_000);
    unmount();
    vi.advanceTimersByTime(30_000);

    expect(sent).toHaveLength(1);
  });
});
