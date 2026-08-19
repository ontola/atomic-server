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

describe('Collection: local sort matches the server', () => {
  const sortProp = 'https://example.com/prop/when';

  function localDbWith(rows: Array<[string, unknown]>): ClientDbWorker {
    return {
      isReady: true,
      waitForReady: async () => true,
      query: async (): Promise<ClientDbQueryResult> => ({
        // Deliberately NOT in the expected order — the sort must impose it.
        subjects: rows.map(([s]) => s),
        resources: [],
        count: rows.length,
      }),
    } as unknown as ClientDbWorker;
  }

  it('puts rows with no sort value first, then ties by subject', async ({
    expect,
  }) => {
    const rows: Array<[string, unknown]> = [
      ['did:ad:rowC', null],
      ['did:ad:rowA', 5],
      ['did:ad:rowB', null],
      ['did:ad:rowD', 1],
    ];
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setServerConnected(false);
    store.setDrive(DRIVE);
    store.setClientDb(localDbWith(rows));

    for (const [subject, when] of rows) {
      const r = new Resource(subject);
      r.applyHydratedValues(when === null ? [] : [[sortProp, when as never]]);
      r.loading = false;
      store.addResource(r);
    }

    const collection = new Collection(store, 'https://example.com', {
      ...params(),
      sort_by: sortProp,
    });
    await collection.waitForReady();

    const ordered: Array<string | undefined> = [];

    for (let i = 0; i < collection.totalMembers; i++) {
      ordered.push(await collection.getMemberWithIndex(i));
    }

    expect(ordered).toEqual([
      'did:ad:rowB', // no value — first, tie broken by subject
      'did:ad:rowC',
      'did:ad:rowD', // 1
      'did:ad:rowA', // 5
    ]);
  });
});

describe('Collection: local surplus is not "stale"', () => {
  it('does not replace a locally-larger page with the server’s smaller one', async ({
    expect,
  }) => {
    // The local index knows about a row the server has not acknowledged yet —
    // an optimistic add, or a pending write. Repairing here would delete it.
    const local = ['did:ad:row1', 'did:ad:row2', 'did:ad:pending'];
    const server = ['did:ad:row1', 'did:ad:row2'];
    const { store, urls } = storeWithServer(server);
    store.setClientDb(stubClientDb(local));

    const collection = new Collection(store, 'https://example.com', params());
    await collection.waitForReady();
    await new Promise(r => setTimeout(r, 30));

    expect(collection.totalMembers).toBe(local.length);
    const fullFetches = urls.filter(
      u => new URL(u).searchParams.get('page_size') !== '1',
    );
    expect(fullFetches).toEqual([]);
  });
});
