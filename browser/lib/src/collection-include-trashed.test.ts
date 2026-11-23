import { describe, it, vi } from 'vitest';
import { Collection, CollectionParams } from './collection.js';
import { buildSearchSubject } from './search.js';
import { Store } from './store.js';
import type {
  ClientDbQueryOpts,
  ClientDbQueryResult,
  ClientDbWorker,
} from './client-db.js';
import { core, dataBrowser } from './index.js';
import { Resource } from './resource.js';

const DRIVE = 'atomic:query-drive';
const TRASH = 'atomic:trash';
const APP = 'atomic:app';
const TABLE = 'atomic:table';
const ROW = 'atomic:row';
const LOGICAL_OWNER = 'atomic:property:logical-owner';

async function liveCollection(
  includeTrashed = false,
  initial: string[] = [],
  extra: Partial<CollectionParams> = {},
) {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });
  store.setDrive(DRIVE);
  store.setServerConnected(false);
  let members = initial;
  store.finishDriveSync(DRIVE, initial.length, Date.now());
  store.setClientDb({
    isReady: true,
    waitForReady: async () => true,
    query: async () => ({ subjects: [...members], count: members.length }),
    removeResource: async () => undefined,
  } as unknown as ClientDbWorker);

  const node = (subject: string, values: Record<string, string>) => {
    const row = new Resource(subject);
    row.applyHydratedValues(Object.entries(values));
    row.loading = false;
    store.resources.set(store.normalizeSubject(subject), row);

    return row;
  };

  node(DRIVE, { [dataBrowser.properties.trashFolder]: TRASH });
  node(TRASH, { [core.properties.parent]: DRIVE });
  const app = node(APP, { [core.properties.parent]: DRIVE });
  node(TABLE, { [core.properties.parent]: APP });
  const row = node(ROW, {
    [core.properties.parent]: TABLE,
    [LOGICAL_OWNER]: TABLE,
  });
  const collection = new Collection(store, 'https://example.com', {
    page_size: '30',
    include_nested: false,
    property: LOGICAL_OWNER,
    value: TABLE,
    drive: DRIVE,
    include_trashed: includeTrashed,
    ...extra,
  });
  await collection.waitForReady();

  return {
    store,
    collection,
    row,
    app,
    node,
    members: (next: string[]) => {
      members = next;
    },
  };
}

/**
 * The server hides trashed members unless `include_trashed=true`. The local
 * WASM query must make the same choice or counts and pages disagree.
 */
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

      return { subjects: [], resources: [], count: 0 };
    },
  };

  return { clientDb: stub as unknown as ClientDbWorker, calls };
}

const params = (extra: Partial<CollectionParams> = {}): CollectionParams => ({
  page_size: '30',
  include_nested: false,
  property: core.properties.parent,
  value: 'did:ad:drive:test',
  filters: [
    { property: core.properties.isA, value: dataBrowser.classes.message },
  ],
  drive: 'did:ad:drive:test',
  ...extra,
});

async function localCalls(
  extra: Partial<CollectionParams>,
): Promise<ClientDbQueryOpts[]> {
  const store = new Store({ serverUrl: 'https://example.com' });
  const { clientDb, calls } = fakeClientDb();
  store.setClientDb(clientDb);
  store.setDrive('did:ad:drive:test');
  const collection = new Collection(
    store,
    'https://example.com',
    params(extra),
  );
  await collection.waitForReady();

  return calls;
}

describe('include_trashed', () => {
  it('does not revive a retained row under a trashed ancestor when a direct GET hydrates it', async ({
    expect,
  }) => {
    const { collection, row, app, store } = await liveCollection();
    app.applyHydratedValues([[core.properties.parent, TRASH]]);
    store.setDrive('atomic:another-drive');
    expect(collection.applyResourceChange(ROW, row)).toBe('unchanged');
    expect(collection.totalMembers).toBe(0);
    expect(await collection.getAllMembers()).toEqual([]);
  });

  it('rechecks a logical collection when only its ancestor moves to Trash', async ({
    expect,
  }) => {
    const { collection, app, members } = await liveCollection(false, [ROW]);
    members([]);
    app.applyHydratedValues([[core.properties.parent, TRASH]]);
    expect(collection.applyResourceChange(APP, app)).toBe('membership-stale');
    await collection.refresh();
    expect(collection.totalMembers).toBe(0);
  });

  it('tracks a member moved to another visible folder before that folder enters Trash', async ({
    expect,
  }) => {
    const { collection, row, node, members } = await liveCollection(false, [
      ROW,
    ]);
    const folder = node('atomic:new-folder', {
      [core.properties.parent]: DRIVE,
    });
    row.applyHydratedValues([[core.properties.parent, folder.subject]]);
    expect(collection.applyResourceChange(ROW, row)).toBe('membership-stale');
    await collection.refresh();
    folder.applyHydratedValues([[core.properties.parent, TRASH]]);
    members([]);
    expect(collection.applyResourceChange(folder.subject, folder)).toBe(
      'membership-stale',
    );
    await collection.refresh();
    expect(collection.totalMembers).toBe(0);
  });

  it('includes retained rows only when requested and admits genuinely visible rows', async ({
    expect,
  }) => {
    const { collection, row, app } = await liveCollection(true);
    app.applyHydratedValues([[core.properties.parent, TRASH]]);
    expect(collection.applyResourceChange(ROW, row)).toBe('member-added');
    expect(await collection.getAllMembers()).toEqual([ROW]);
    const visible = await liveCollection();
    expect(visible.collection.applyResourceChange(ROW, visible.row)).toBe(
      'member-added',
    );
  });

  it('does not fetch missing ancestry or react to unrelated ancestor fields', async ({
    expect,
  }) => {
    const { collection, app, row, store } = await liveCollection();
    const fetch = vi.spyOn(store, 'getResourceLoading');
    app.applyHydratedValues([[core.properties.name, 'Renamed']]);
    expect(collection.applyResourceChange(APP, app)).toBe('unchanged');
    store.resources.delete(store.normalizeSubject(APP));
    collection.applyResourceChange(ROW, row);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not merge a now-hidden optimistic row back into a refreshed empty page', async ({
    expect,
  }) => {
    const { collection, row, app } = await liveCollection();
    expect(collection.applyResourceChange(ROW, row)).toBe('member-added');
    collection['clearPages']();
    app.applyHydratedValues([[core.properties.parent, TRASH]]);
    collection.applyResourceChange(ROW, row);
    await collection.refresh();
    expect(collection.totalMembers).toBe(0);
    expect(await collection.getAllMembers()).toEqual([]);
  });

  it('still excludes destroyed rows when include_trashed is requested', async ({
    expect,
  }) => {
    const { collection, row, store } = await liveCollection(true);
    store.removeResource(ROW, false);
    expect(collection.applyResourceChange(ROW, row)).toBe('unchanged');
    expect(collection.totalMembers).toBe(0);
  });

  it('keeps explicit parent listings inside Trash visible, including additional equality filters', async ({
    expect,
  }) => {
    for (const extra of [
      { property: core.properties.parent },
      {
        filters: [
          {
            property: core.properties.parent,
            value: TABLE,
            operator: 'eq' as const,
          },
        ],
      },
    ]) {
      const { collection, app, row } = await liveCollection(false, [], extra);
      app.applyHydratedValues([[core.properties.parent, TRASH]]);
      expect(collection.applyResourceChange(ROW, row)).toBe('member-added');
      expect(await collection.getAllMembers()).toEqual([ROW]);
    }
  });

  it('hides trashed members locally by default', async ({ expect }) => {
    const calls = await localCalls({});

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => !c.includeTrashed)).toBe(true);
  });

  it('forwards include_trashed to the local query', async ({ expect }) => {
    const calls = await localCalls({ include_trashed: true });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c.includeTrashed === true)).toBe(true);
  });

  it('puts include_trashed on the server URL only when set', ({ expect }) => {
    const store = new Store({ serverUrl: 'https://example.com' });
    const url = (extra: Partial<CollectionParams>) =>
      new URL(
        new Collection(store, 'https://example.com', params(extra))[
          'buildSubject'
        ](0),
      );

    expect(url({}).searchParams.has('include_trashed')).toBe(false);
    expect(
      url({ include_trashed: true }).searchParams.get('include_trashed'),
    ).toBe('true');
  });

  it('adds include_trashed to the search URL only when set', ({ expect }) => {
    const base = buildSearchSubject('https://example.com', 'x');
    const on = buildSearchSubject('https://example.com', 'x', {
      includeTrashed: true,
    });

    expect(new URL(base).searchParams.has('include_trashed')).toBe(false);
    expect(new URL(on).searchParams.get('include_trashed')).toBe('true');
  });
});
