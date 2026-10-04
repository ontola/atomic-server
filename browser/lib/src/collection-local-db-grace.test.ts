import { describe, expect, it, vi } from 'vitest';
import { CollectionBuilder } from './collectionBuilder.js';
import { Store } from './store.js';
import { core } from './ontologies/core.js';
import { collections } from './ontologies/collections.js';
import type { ClientDbWorker } from './client-db.js';

/**
 * A local database that is still becoming ready must not hold a query.
 *
 * `waitForReady` covers the bootstrap seed as well as the worker, and the seed
 * is the whole bundled ontology. Measured with four Playwright workers on a
 * four-core box, that wait reached 91 seconds with the worker already
 * initialized, and an app whose view asked its table for its rows got the
 * answer 98 seconds later: the row was on the server and in the local index
 * the whole time, and the page rendered empty.
 */
const HOME = 'https://app.example.com';
const DRIVE = 'did:ad:drive';
const TABLE = 'did:ad:table';
const ROW = 'did:ad:row';

function setup(clientDb: Partial<ClientDbWorker>) {
  const store = new Store({ serverUrl: HOME, connect: false });
  store.setClientDb(clientDb as unknown as ClientDbWorker);
  const requests: URL[] = [];
  store.injectFetch(async input => {
    const url = new URL(String(input));
    requests.push(url);

    return new Response(
      JSON.stringify({
        '@id': url.href,
        [collections.properties.members]: [ROW],
        [collections.properties.totalMembers]: 1,
      }),
      { status: 200 },
    );
  });
  store.setDrive(DRIVE);
  store.finishDriveSync(DRIVE, 1, Date.now());
  store.setServerConnected(true);

  return { store, requests };
}

function membersOf(store: Store) {
  return new CollectionBuilder(store)
    .setProperty(core.properties.parent)
    .setValue(TABLE)
    .buildAndFetch();
}

describe('a collection query and a local database that is not ready yet', () => {
  it('asks the server rather than waiting on the bootstrap seed forever', async () => {
    const query = vi.fn(async () => ({ subjects: [], count: 0 }));
    const { store, requests } = setup({
      isReady: false,
      // What the seed looks like from here while it is still running.
      waitForReady: () => new Promise<boolean>(() => undefined),
      query,
    });
    vi.useFakeTimers();

    try {
      const pending = membersOf(store);
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;

      expect(query).not.toHaveBeenCalled();
      expect(requests.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps waiting for the local database when there is no server to ask', async () => {
    const clientDb: Partial<ClientDbWorker> = {
      isReady: false,
      waitForReady: async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 8000));
        clientDb.isReady = true;

        return true;
      },
      query: vi.fn(async () => ({ subjects: [ROW], count: 1 })),
    };
    const { store, requests } = setup(clientDb);
    store.setServerConnected(false);
    vi.useFakeTimers();

    try {
      const pending = membersOf(store);
      await vi.advanceTimersByTimeAsync(20_000);
      await pending;

      expect(clientDb.query).toHaveBeenCalledOnce();
      expect(requests).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still uses the local database when it becomes ready inside the grace', async () => {
    const clientDb: Partial<ClientDbWorker> = {
      isReady: false,
      waitForReady: async () => {
        clientDb.isReady = true;

        return true;
      },
      query: vi.fn(async () => ({
        subjects: [ROW],
        count: 1,
      })),
    };
    const { store, requests } = setup(clientDb);
    await membersOf(store);

    expect(clientDb.query).toHaveBeenCalledOnce();
    expect(requests).toEqual([]);
  });
});
