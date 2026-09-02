import { describe, it } from 'vitest';
import { Collection, CollectionParams } from './collection.js';
import { Store } from './store.js';
import type {
  ClientDbQueryOpts,
  ClientDbQueryResult,
  ClientDbWorker,
} from './client-db.js';
import { core, dataBrowser } from './index.js';

/**
 * A Collection whose `filters` are non-empty routes through the WASM DB's
 * indexed path (`query_complex`), which is keyed by drive and therefore
 * REQUIRES a drive scope. A drive-less indexed query can only come back as
 * "Indexed queries require a drive scope", so it must never be issued.
 *
 * Regression guard for the four-per-page-load `[ClientDb] query failed`
 * console errors: `CollectionBuilder` snapshots `store.getDrive()` at
 * construction time, so any collection built before the drive was known kept
 * `drive: undefined` forever and asked the worker anyway.
 */

/** A ClientDb stub that records every query and rejects drive-less indexed
 *  queries exactly like the WASM DB's `QueryFilter::try_from_query` does. */
function fakeClientDb(): {
  clientDb: ClientDbWorker;
  calls: ClientDbQueryOpts[];
} {
  const calls: ClientDbQueryOpts[] = [];

  const stub = {
    isReady: true,
    waitForReady: async () => true,
    query: async (opts: ClientDbQueryOpts): Promise<ClientDbQueryResult> => {
      calls.push(opts);

      if (opts.filters && opts.filters.length > 0 && !opts.drive) {
        throw new Error(
          'Indexed queries require a drive scope. Set Query::drive to the drive Subject.',
        );
      }

      return { subjects: [], resources: [], count: 0 };
    },
  };

  return { clientDb: stub as unknown as ClientDbWorker, calls };
}

const filteredParams = (): CollectionParams => ({
  page_size: '30',
  include_nested: false,
  property: dataBrowser.properties.about,
  value: 'did:ad:resource:xyz',
  filters: [
    { property: core.properties.isA, value: dataBrowser.classes.message },
  ],
  // No drive: what `CollectionBuilder` produces when it is constructed
  // before `store.setDrive` has run (cold start, or a deep-link session
  // whose drive is adopted asynchronously).
  drive: undefined,
});

describe('Collection local-DB drive scope', () => {
  it('does not issue a drive-less indexed query when no drive is known', async ({
    expect,
  }) => {
    const store = new Store({ serverUrl: 'https://example.com' });
    const { clientDb, calls } = fakeClientDb();
    store.setClientDb(clientDb);

    const collection = new Collection(
      store,
      'https://example.com',
      filteredParams(),
    );
    await collection.waitForReady();

    const invalid = calls.filter(
      c => c.filters && c.filters.length > 0 && !c.drive,
    );

    expect(invalid).toEqual([]);
  });

  it('scopes the indexed query to the store drive set after construction', async ({
    expect,
  }) => {
    const store = new Store({ serverUrl: 'https://example.com' });
    const { clientDb, calls } = fakeClientDb();
    store.setClientDb(clientDb);
    store.setDrive('did:ad:drive:test');

    const collection = new Collection(
      store,
      'https://example.com',
      filteredParams(),
    );
    await collection.waitForReady();

    const indexed = calls.filter(c => c.filters && c.filters.length > 0);

    expect(indexed).toHaveLength(1);
    expect(indexed[0]!.drive).toBe('did:ad:drive:test');
  });
});
