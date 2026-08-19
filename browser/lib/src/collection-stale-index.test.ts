import { describe, it, vi } from 'vitest';
import { Collection, type CollectionParams } from './collection.js';
import { Store } from './store.js';
import type {
  ClientDbQueryOpts,
  ClientDbQueryResult,
  ClientDbWorker,
} from './client-db.js';
import { core, collections } from './index.js';
import { Resource } from './resource.js';

/**
 * A local index that holds only SOME of a parent's members renders those and
 * stops. Nothing re-asks: `refresh()` re-enters the same local path, and OPFS
 * survives reloads, so the wrong count is permanent — and it reads exactly
 * like a sync failure, which is where the debugging goes.
 *
 * The empty case was already guarded (an empty index is only trusted once the
 * drive has synced). These cover the partial one.
 */

const TABLE = 'did:ad:table';
const DRIVE = 'did:ad:drive';

const params = (): CollectionParams => ({
  page_size: '30',
  include_nested: false,
  property: core.properties.parent,
  value: TABLE,
  drive: DRIVE,
});

/** A local DB that knows `localSubjects` and nothing else. */
function stubClientDb(localSubjects: string[]): ClientDbWorker {
  return {
    isReady: true,
    waitForReady: async () => true,
    query: async (_opts: ClientDbQueryOpts): Promise<ClientDbQueryResult> => ({
      subjects: [...localSubjects],
      resources: [],
      count: localSubjects.length,
    }),
  } as unknown as ClientDbWorker;
}

/** Server `/query` responses: a page carrying `totalMembers`.
 *  `total` is passed separately — the probe truncates `members` to one but
 *  must still report the true total, which is the whole point of the probe. */
function serverCollection(
  subject: string,
  members: string[],
  total: number,
): Resource {
  const r = new Resource(subject);
  r.applyHydratedValues([
    [collections.properties.members, members],
    [collections.properties.totalMembers, total],
    [collections.properties.currentPage, 0],
    [collections.properties.totalPages, 1],
  ]);
  r.loading = false;

  return r;
}

function storeWithServer(serverMembers: string[]) {
  const store = new Store({ serverUrl: 'https://example.com' });
  store.setServerConnected(true);
  store.setDrive(DRIVE);

  const urls: string[] = [];
  vi.spyOn(store, 'fetchResourceFromServer').mockImplementation((async (
    subject: string,
  ) => {
    urls.push(subject);
    const pageSize = new URL(subject).searchParams.get('page_size');

    // The probe asks for one member; it only needs the total.
    return serverCollection(
      subject,
      pageSize === '1' ? serverMembers.slice(0, 1) : serverMembers,
      serverMembers.length,
    );
  }) as never);

  return { store, urls };
}

describe('Collection: partial local index', () => {
  it('repairs a page the local index under-reported', async ({ expect }) => {
    const local = ['did:ad:row1', 'did:ad:row2'];
    const server = ['did:ad:row1', 'did:ad:row2', 'did:ad:row3', 'did:ad:row4'];
    const { store } = storeWithServer(server);
    store.setClientDb(stubClientDb(local));

    const collection = new Collection(store, 'https://example.com', params());
    await collection.waitForReady();

    // Let the background count check and its repair settle.
    await vi.waitFor(() => {
      expect(collection.totalMembers).toBe(server.length);
    });
  });

  it('leaves an agreeing local index alone', async ({ expect }) => {
    const members = ['did:ad:row1', 'did:ad:row2'];
    const { store, urls } = storeWithServer(members);
    store.setClientDb(stubClientDb(members));

    const collection = new Collection(store, 'https://example.com', params());
    await collection.waitForReady();
    await new Promise(r => setTimeout(r, 20));

    expect(collection.totalMembers).toBe(members.length);
    // One probe, and no full-page refetch behind it.
    const fullFetches = urls.filter(
      u => new URL(u).searchParams.get('page_size') !== '1',
    );
    expect(fullFetches).toEqual([]);
  });

  it('checks once, not once per page', async ({ expect }) => {
    const local = ['did:ad:row1'];
    const server = ['did:ad:row1', 'did:ad:row2', 'did:ad:row3'];
    const { store, urls } = storeWithServer(server);
    store.setClientDb(stubClientDb(local));

    const collection = new Collection(store, 'https://example.com', params());
    await collection.waitForReady();
    await vi.waitFor(() => {
      expect(collection.totalMembers).toBe(server.length);
    });

    const probes = urls.filter(
      u => new URL(u).searchParams.get('page_size') === '1',
    );
    expect(probes.length).toBe(1);
  });
});
