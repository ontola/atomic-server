import { expect, it } from 'vitest';
import { Collection } from './collection.js';
import { Store } from './store.js';
import { LoroLoader } from './loro-loader.js';
import { collections } from './ontologies/collections.js';
import { commits } from './ontologies/commits.js';
import { core } from './ontologies/core.js';

const SERVER = 'https://example.com';
const TABLE = 'atomic:table';
const DRIVE = 'atomic:drive';
const ALPHA = 'atomic:alpha';
const BETA = 'atomic:beta';

function querySnapshot(peer: number, members: string[]) {
  const { LoroDoc, LoroList } = LoroLoader.Loro;
  const doc = new LoroDoc();
  doc.setPeerId(peer);
  const properties = doc.getMap('properties');
  const list = properties.setContainer(
    collections.properties.members,
    new LoroList(),
  );
  for (const member of members) list.push(member);
  properties.set(collections.properties.totalMembers, members.length);
  properties.set(core.properties.isA, [collections.classes.collection]);
  doc.commit();

  return doc;
}

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
