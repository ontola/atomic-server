import { expect, it } from 'vitest';
import { Collection } from './collection.js';
import { Store } from './store.js';
import { LoroLoader } from './loro-loader.js';
import { collections } from './ontologies/collections.js';
import { commits } from './ontologies/commits.js';
import { core } from './ontologies/core.js';
import { dataBrowser } from './ontologies/dataBrowser.js';
import { Resource } from './resource.js';
import type { ClientDbWorker } from './client-db.js';

const SERVER = 'https://example.com';
const TABLE = 'atomic:table';
const DRIVE = 'atomic:drive';
const ALPHA = 'atomic:alpha';
const BETA = 'atomic:beta';

function querySnapshot(
  peer: number,
  members: string[],
  total = members.length,
) {
  const { LoroDoc, LoroList } = LoroLoader.Loro;
  const doc = new LoroDoc();
  doc.setPeerId(peer);
  const properties = doc.getMap('properties');
  const list = properties.setContainer(
    collections.properties.members,
    new LoroList(),
  );
  for (const member of members) list.push(member);
  properties.set(collections.properties.totalMembers, total);
  properties.set(core.properties.isA, [collections.classes.collection]);
  doc.commit();

  return doc;
}

function localMembership(subjects: string[]): ClientDbWorker {
  return {
    isReady: true,
    waitForReady: async () => true,
    query: async () => ({ subjects, count: subjects.length }),
  } as unknown as ClientDbWorker;
}

async function pagedServerCollection(initial: string[], local?: string[]) {
  const store = new Store({ serverUrl: SERVER, connect: false });
  store.setServerConnected(true);
  store.setDrive(DRIVE);

  // Positive optimistic additions have a cached, visible Drive ancestry.
  for (const [subject, values] of [
    [DRIVE, [[dataBrowser.properties.trashFolder, 'atomic:trash']]],
    [TABLE, [[core.properties.parent, DRIVE]]],
  ] as [string, [string, string][]][]) {
    const resource = new Resource(subject);
    resource.applyHydratedValues(values);
    resource.loading = false;
    store.resources.set(store.normalizeSubject(subject), resource);
  }

  if (local) store.setClientDb(localMembership(local));
  let members = initial;
  let peer = 1;
  store.injectFetch(async input => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get('current_page'));
    const size = Number(url.searchParams.get('page_size'));

    return response(
      url.href,
      querySnapshot(
        peer++,
        members.slice(page * size, (page + 1) * size),
        members.length,
      ),
    );
  });
  const collection = new Collection(
    store,
    SERVER,
    {
      page_size: '30',
      include_nested: false,
      property: core.properties.parent,
      value: TABLE,
      drive: DRIVE,
    },
    true,
    { preferServer: false },
  );
  await collection.refresh();

  return {
    store,
    collection,
    replace: (next: string[]) => {
      members = next;
    },
    row: (subject: string, parent = TABLE) => {
      const resource = new Resource(subject);
      resource.applyHydratedValues([[core.properties.parent, parent]]);
      resource.loading = false;

      return resource;
    },
  };
}

it('does not trust uncached ancestry of HTTP query rows when WebSocket is disconnected', async () => {
  const { collection, store, row } = await pagedServerCollection([]);
  store.setServerConnected(false);
  store.resources.delete(store.normalizeSubject(TABLE));
  expect(collection.applyResourceChange(ALPHA, row(ALPHA))).toBe(
    'membership-stale',
  );
  expect(collection.totalMembers).toBe(0);
  expect(await collection.getAllMembers()).toEqual([]);
});

it('shares server page authority with clones after a complete local answer', async () => {
  const { collection, store, row } = await pagedServerCollection([]);
  store.setServerConnected(false);
  store.setClientDb(localMembership([]));
  store.finishDriveSync(DRIVE, 0, Date.now());
  await collection.refresh();
  const clone = collection.clone();
  await clone.waitForReady();
  await collection['fetchPageFromServer'](0);
  store.resources.delete(store.normalizeSubject(TABLE));
  expect(clone.applyResourceChange(ALPHA, row(ALPHA))).toBe('membership-stale');
  expect(clone.totalMembers).toBe(0);
});

it('revalidates existing off-page updates without counting the same server members twice', async () => {
  const members = Array.from({ length: 90 }, (_, i) => 'atomic:row-' + i);
  const { collection, row } = await pagedServerCollection(members);

  for (const subject of members.slice(30)) {
    expect(collection.applyResourceChange(subject, row(subject))).toBe(
      'membership-stale',
    );
    expect(collection.totalMembers).toBe(90);
  }

  await collection.refresh();
  expect(collection.totalMembers).toBe(90);
  expect(await collection.getAllMembers()).toEqual(members);
});

it('requeries a genuine add and keeps known removals and moves visible with accurate server totals', async () => {
  const members = Array.from({ length: 90 }, (_, i) => 'atomic:row-' + i);
  const { collection, row, replace } = await pagedServerCollection(members);
  const added = 'atomic:new-row';
  replace([...members, added]);
  expect(collection.applyResourceChange(added, row(added))).toBe(
    'membership-stale',
  );
  await collection.refresh();
  expect(collection.totalMembers).toBe(91);
  expect(await collection.getAllMembers()).toContain(added);

  replace(members.filter(subject => subject !== members[0]));
  expect(collection.applyResourceChange(added, undefined)).toBe(
    'member-removed',
  );
  expect(
    collection.applyResourceChange(
      members[0],
      row(members[0], 'atomic:elsewhere'),
    ),
  ).toBe('member-removed');
  expect(collection.totalMembers).toBe(89);
  await collection.refresh();
  expect(collection.totalMembers).toBe(89);
  expect(await collection.getAllMembers()).toEqual(members.slice(1));

  replace(members);
  expect(collection.applyResourceChange(members[0], row(members[0]))).toBe(
    'membership-stale',
  );
  await collection.refresh();
  expect(collection.totalMembers).toBe(90);
  expect(await collection.getAllMembers()).toEqual(members);
});

it('does not add optimistic off-page rows on top of an authoritative partial-server count', async () => {
  const members = Array.from({ length: 90 }, (_, i) => 'atomic:row-' + i);
  const { collection, row, replace } = await pagedServerCollection(
    members.slice(0, 2),
  );
  expect(collection.applyResourceChange(members[60], row(members[60]))).toBe(
    'member-added',
  );
  expect(collection.totalMembers).toBe(3);
  replace(members);
  await collection.refresh();
  expect(collection.totalMembers).toBe(90);
  expect(await collection.getAllMembers()).toEqual(members);
});

it('rechecks explicit off-page removals rather than leaving a partial-server count stale', async () => {
  const members = Array.from({ length: 90 }, (_, i) => 'atomic:row-' + i);
  const { collection, replace } = await pagedServerCollection(members);
  replace(members.filter(subject => subject !== members[60]));
  expect(collection.applyResourceChange(members[60], undefined)).toBe(
    'membership-stale',
  );
  await collection.refresh();
  expect(collection.totalMembers).toBe(89);
  expect(await collection.getAllMembers()).not.toContain(members[60]);
});

it('keeps optimistic additions when a complete small-server query is temporarily stale and empty', async () => {
  const { collection, row } = await pagedServerCollection([]);
  expect(collection.applyResourceChange(ALPHA, row(ALPHA))).toBe(
    'member-added',
  );
  await collection.refresh();
  expect(collection.totalMembers).toBe(1);
  expect(await collection.getAllMembers()).toEqual([ALPHA]);
});

it('does not mistake a partially cached local page for members absent from the complete server count', async () => {
  const members = Array.from({ length: 90 }, (_, i) => 'atomic:row-' + i);
  const { collection } = await pagedServerCollection(
    members,
    members.slice(60, 62),
  );
  expect(collection.totalMembers).toBe(90);
  expect(await collection.getAllMembers()).toEqual(members);
});

it('restores proven optimistic additions when a complete local query replaces the partial server page', async () => {
  const members = Array.from({ length: 90 }, (_, i) => 'atomic:row-' + i);
  const { collection, store, row } = await pagedServerCollection(members);
  store.setServerConnected(false);
  store.setClientDb(localMembership(members));
  store.finishDriveSync(DRIVE, members.length, Date.now());
  await collection.refresh();
  expect(collection.totalMembers).toBe(90);
  expect(
    collection.applyResourceChange(
      'atomic:new-local-row',
      row('atomic:new-local-row'),
    ),
  ).toBe('member-added');
  expect(collection.totalMembers).toBe(91);
  members.push('atomic:new-local-row');
  expect(await collection.getAllMembers()).toContain('atomic:new-local-row');
});

function response(
  subject: string,
  doc: InstanceType<typeof LoroLoader.Loro.LoroDoc>,
) {
  return new Response(
    JSON.stringify({
      '@id': subject,
      ...doc.getMap('properties').toJSON(),
      [commits.properties.loroUpdate]: Buffer.from(
        doc.export({ mode: 'snapshot' }),
      ).toString('base64'),
    }),
    { status: 200, headers: { 'Content-Type': 'application/ad+json' } },
  );
}

it('refreshes independent query snapshots through empty, additions, removal and empty without mixing members and count', async () => {
  const snapshots = [
    querySnapshot(100, []),
    querySnapshot(1, [ALPHA, BETA]),
    querySnapshot(2, [BETA]),
    querySnapshot(3, []),
  ];
  const merged = new LoroLoader.Loro.LoroDoc();
  merged.import(snapshots[0].export({ mode: 'snapshot' }));
  merged.import(snapshots[1].export({ mode: 'snapshot' }));
  // The real failure: map conflict resolution chooses an old empty container,
  // while the independently generated newer count wins another map entry.
  expect(merged.getMap('properties').toJSON()).toMatchObject({
    [collections.properties.totalMembers]: 2,
    [collections.properties.members]: [],
  });
  const store = new Store({ serverUrl: SERVER, connect: false });
  store.setServerConnected(true);
  store.setDrive(DRIVE);
  const urls: string[] = [];
  store.injectFetch(async input => {
    const url = String(input);
    expect(new URL(url).pathname).toBe('/query');
    const snapshot = snapshots[urls.length];
    urls.push(url);

    return response(url, snapshot);
  });
  const collection = new Collection(
    store,
    SERVER,
    {
      page_size: '30',
      include_nested: false,
      property: core.properties.parent,
      value: TABLE,
      drive: DRIVE,
    },
    true,
    { preferServer: true },
  );

  for (const members of [[], [ALPHA, BETA], [BETA], []]) {
    await collection.refresh();
    expect(collection.totalMembers).toBe(members.length);
    expect(await collection.getAllMembers()).toEqual(members);
    const cached = store.resources.get(urls.at(-1)!);
    expect(cached?.get(collections.properties.totalMembers)).toBe(
      members.length,
    );
    expect(cached?.getSubjects(collections.properties.members)).toEqual(
      members,
    );
  }

  expect(urls).toHaveLength(4);
  expect(new Set(urls).size).toBe(1);
});

it('preserves ordinary resource CRDT merges across independent HTTP snapshots', async () => {
  const { LoroDoc } = LoroLoader.Loro;
  const first = new LoroDoc();
  first.getMap('properties').set(core.properties.name, 'Original title');
  first.commit();
  const second = new LoroDoc();
  second
    .getMap('properties')
    .set(core.properties.description, 'Remote description');
  second.commit();
  const store = new Store({ serverUrl: SERVER, connect: false });
  const subject = SERVER + '/document';
  let requests = 0;
  store.injectFetch(async input =>
    response(String(input), [first, second][requests++]),
  );
  const resource = await store.fetchResourceFromServer(subject);
  resource.applyHydratedValues([
    ['https://example.com/local-note', 'Retain local note'],
  ]);
  await store.fetchResourceFromServer(subject);
  expect(resource.get(core.properties.name)).toBe('Original title');
  expect(resource.get(core.properties.description)).toBe('Remote description');
  expect(resource.get('https://example.com/local-note')).toBe(
    'Retain local note',
  );
});
