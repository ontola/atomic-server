import { describe, it } from 'vitest';
import { Collection, type CollectionParams } from './collection.js';
import { Store } from './store.js';
import type { ClientDbQueryResult, ClientDbWorker } from './client-db.js';
import { core } from './index.js';
import { dataBrowser } from './ontologies/dataBrowser.js';
import { Resource } from './resource.js';

/**
 * A table row inserted between two others sorts by a `sortOrder` between theirs.
 * After a reload the local database can lack that row, and a sync pushes it in
 * once the page is up, while the rows around it are still loading. It cannot be
 * compared with rows the store does not hold, so it used to go to the end, and
 * nothing moved it back: the grid showed rowINSERTED below rowB for good
 * (tables.spec "Shift+Enter inserts a row below the current row", red on CI).
 */

const TABLE = 'atomic:table';
const DRIVE = 'atomic:drive';
const SORT_ORDER = dataBrowser.properties.sortOrder;

const params = (): CollectionParams => ({
  page_size: '30',
  include_nested: false,
  property: core.properties.parent,
  value: TABLE,
  drive: DRIVE,
  sort_by: SORT_ORDER,
});

function localDbWith(subjects: string[]): ClientDbWorker {
  return {
    isReady: true,
    waitForReady: async () => true,
    query: async (): Promise<ClientDbQueryResult> => ({
      subjects: [...subjects],
      resources: [],
      count: subjects.length,
    }),
  } as unknown as ClientDbWorker;
}

function row(subject: string, sortOrder: number): Resource {
  const r = new Resource(subject);
  r.applyHydratedValues([
    [core.properties.parent, TABLE],
    [SORT_ORDER, sortOrder],
  ]);
  r.loading = false;

  return r;
}

async function members(collection: Collection): Promise<unknown[]> {
  const out: unknown[] = [];

  for (let i = 0; i < collection.totalMembers; i++) {
    out.push(await collection.getMemberWithIndex(i));
  }

  return out;
}

async function openCollection(hydrate: boolean) {
  const store = new Store({ serverUrl: 'https://example.com' });
  store.setServerConnected(false);
  store.setDrive(DRIVE);
  store.finishDriveSync(DRIVE, 2, Date.now());
  store.setClientDb(localDbWith(['atomic:rowA', 'atomic:rowB']));

  if (hydrate) {
    store.addResource(row('atomic:rowA', 100));
    store.addResource(row('atomic:rowB', 300));
  }

  const collection = new Collection(store, 'https://example.com', params());
  await collection.waitForReady();

  const inserted = row('atomic:rowINSERTED', 200);
  store.addResource(inserted);

  return { collection, inserted };
}

describe('Collection: a member that arrives before its neighbours are loaded', () => {
  it('is placed between them when their sort keys are known', async ({
    expect,
  }) => {
    const { collection, inserted } = await openCollection(true);

    expect(collection.applyResourceChange(inserted.subject, inserted)).toBe(
      'member-added',
    );
    expect(await members(collection)).toEqual([
      'atomic:rowA',
      'atomic:rowINSERTED',
      'atomic:rowB',
    ]);
  });

  it('asks for the order to be read again when it cannot be compared', async ({
    expect,
  }) => {
    const { collection, inserted } = await openCollection(false);

    // Not 'member-added': the position is a guess, so the caller must refresh.
    expect(collection.applyResourceChange(inserted.subject, inserted)).toBe(
      'membership-stale',
    );
    // The row stays on screen until the refresh lands.
    expect(await members(collection)).toContain('atomic:rowINSERTED');
  });
});
