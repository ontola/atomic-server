/** A real populated WASM index must retain the query's pinned Drive. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { NodeClientDb } from '../src/client-db.node.js';
import type { ClientDbWorker } from '../src/client-db.js';
import { CollectionBuilder } from '../src/collectionBuilder.js';
import { core } from '../src/ontologies/core.js';
import { server } from '../src/ontologies/server.js';
import { Store } from '../src/store.js';

const origin = 'http://localhost:9883';
const driveA = 'atomic:collection-test-drive-a';
const driveB = 'atomic:collection-test-drive-b';
const driveProperty = 'https://atomicdata.dev/properties/drive';
const identity = 'shared-collection-identity';
const rows = [driveA, driveB].flatMap((drive, index) => [
  {
    '@id': `atomic:collection-test-row-${index}-z`,
    [core.properties.parent]: drive,
    [driveProperty]: drive,
    [core.properties.description]: identity,
    [core.properties.localId]: identity,
    [core.properties.name]: 'Zulu',
  },
  {
    '@id': `atomic:collection-test-row-${index}-a`,
    [core.properties.parent]: drive,
    [driveProperty]: drive,
    [core.properties.description]: identity,
    [core.properties.localId]: identity + '-second',
    [core.properties.name]: 'Alpha',
  },
]);
let db: NodeClientDb;

beforeAll(async () => {
  localStorage.setItem('ws-disconnected', '1');
  db = new NodeClientDb({
    wasmPath: fileURLToPath(
      new URL('../../../wasm/pkg/atomic_wasm_bg.wasm', import.meta.url),
    ),
  });
  await db.init(origin);

  for (const drive of [driveA, driveB]) {
    await db.putResource(
      JSON.stringify({
        '@id': drive,
        [core.properties.isA]: [server.classes.drive],
        [core.properties.name]: drive,
      }),
    );
  }

  for (const row of rows) await db.putResource(JSON.stringify(row));
});
afterAll(() => db.destroy());

it.each([core.properties.description, core.properties.localId])(
  'isolates %s lookups and client-side sort on two populated Drives',
  async property => {
    const store = new Store({ serverUrl: origin });
    store.setClientDb(db as unknown as ClientDbWorker);
    vi.spyOn(store, 'hasCompletedDriveSyncFor').mockReturnValue(true);
    const remote = vi
      .spyOn(store, 'fetchResourceFromServer')
      .mockRejectedValue(
        new Error('This test must query the populated local WASM index'),
      );

    for (const [drive, other, index] of [
      [driveA, driveB, 0],
      [driveB, driveA, 1],
    ] as const) {
      store.setDrive(other);
      const collection = new CollectionBuilder(store)
        .setDrive(drive)
        .setProperty(property)
        .setValue(identity)
        .setSortBy(core.properties.name)
        .build();
      const expected =
        property === core.properties.localId
          ? [`atomic:collection-test-row-${index}-z`]
          : [
              `atomic:collection-test-row-${index}-a`,
              `atomic:collection-test-row-${index}-z`,
            ];

      expect(await collection.getAllMembers()).toEqual(expected);
      expect(collection.totalMembers).toBe(expected.length);
    }

    expect(remote).not.toHaveBeenCalled();
  },
);
