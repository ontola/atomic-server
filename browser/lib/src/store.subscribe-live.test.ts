import { describe, expect, it, vi } from 'vitest';
import { Store } from './store.js';
import type { WSClient } from './websockets.js';

/**
 * Something shared with you out of a drive you can't open only reaches you
 * through a subscription on the thing itself. Several parts of the app may
 * hold one; the server hears one `SUB` and one `UNSUB`.
 */
describe('Store.subscribeLive', () => {
  const ROOM = 'did:ad:room';

  function setup() {
    const store = new Store({
      serverUrl: 'https://example.com',
      connect: false,
    });
    const ws = {
      subscribeResource: vi.fn(),
      unsubscribeResource: vi.fn(),
    };
    vi.spyOn(store, 'getWebSocketForSubject').mockReturnValue(
      ws as unknown as WSClient,
    );

    return { store, ws };
  }

  it('subscribes once and lets go when the last holder does', () => {
    const { store, ws } = setup();
    const first = store.subscribeLive(ROOM);
    const second = store.subscribeLive(ROOM);

    expect(ws.subscribeResource).toHaveBeenCalledOnce();

    first();
    expect(ws.unsubscribeResource).not.toHaveBeenCalled();
    expect(store.liveSubjects.has(store.normalizeSubject(ROOM))).toBe(true);

    second();
    expect(ws.unsubscribeResource).toHaveBeenCalledOnce();
    expect(store.liveSubjects.has(store.normalizeSubject(ROOM))).toBe(false);
  });
});
