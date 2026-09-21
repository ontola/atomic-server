import { describe, it, vi } from 'vitest';
import { core } from './index.js';
import { Store } from './store.js';

/**
 * A destroy is not instantaneous for everyone who can answer a query: the
 * server's `/query` races the local index, and an answer computed before the
 * destroy landed can arrive after it. The store is where "this subject is
 * destroyed" lives, so every reader of such an answer agrees — including one
 * created after the delete.
 */
const SUBJECT = 'did:ad:resource:doomed';
const PARENT = 'did:ad:resource:parent';

const testStore = () => {
  const store = new Store({ serverUrl: 'https://example.com' });
  store.setServerConnected(true);

  return store;
};

describe('destroyed subjects', () => {
  it('does not fetch a subject it destroyed', async ({ expect }) => {
    const store = testStore();
    const fetchSpy = vi.fn(async () => {
      throw new Error('404 not found');
    });
    (
      store as unknown as { client: { fetchResourceHTTP: unknown } }
    ).client.fetchResourceHTTP = fetchSpy;

    store.getResourceLoading(SUBJECT);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetchSpy).toHaveBeenCalled();

    fetchSpy.mockClear();
    store.removeResource(SUBJECT);

    // A view still holding the subject — a row a stale answer put back, a
    // link in a page that has not re-rendered — asks for it again. Answering
    // from the tombstone keeps the round-trip off the wire, and keeps the
    // store from re-creating the entry the destroy removed.
    const resource = store.getResourceLoading(SUBJECT);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(resource.loading).toBe(false);
    expect(resource.error).toBeDefined();
  });

  it('refuses incoming state for a destroyed subject after the ack', async ({
    expect,
  }) => {
    const store = testStore();
    const resource = store.getResourceLoading(SUBJECT);
    await resource.set(core.properties.parent, PARENT, false);

    store.removeResource(SUBJECT);
    // `hasPendingDestroy` covers only the window before the server acks; the
    // stale answer usually arrives after it, with nothing queued.
    expect(store.hasPendingDestroy(SUBJECT)).toBe(false);
    expect(store.isDestroyed(SUBJECT)).toBe(true);

    expect(
      store.applyIncoming({
        subject: SUBJECT,
        resource: store.getResourceLoading(SUBJECT),
        source: 'ws-sub-push',
      }),
    ).toBe('deduped');
  });

  it('lifts the tombstone when the subject is created again', async ({
    expect,
  }) => {
    const store = testStore();
    store.getResourceLoading(SUBJECT);
    store.removeResource(SUBJECT);
    expect(store.isDestroyed(SUBJECT)).toBe(true);

    store.clearDestroyed(SUBJECT);
    expect(store.isDestroyed(SUBJECT)).toBe(false);
  });
});
