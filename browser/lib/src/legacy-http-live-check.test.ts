import { it, expect } from 'vitest';
import { Store } from './store.js';
import { CollectionBuilder } from './collectionBuilder.js';
import { core } from './ontologies/core.js';
// Opt-in: ATOMIC_LEGACY_LIVE=1 vitest run src/legacy-http-live-check.test.ts
it.runIf(process.env.ATOMIC_LEGACY_LIVE === '1')(
  'reads the live public HTTP drive and children from a nodeless home',
  async () => {
    const store = new Store({
      serverUrl: 'https://app.atomic.place',
      connect: false,
    });
    const drive = 'https://atomicdata.dev/drive/7eqsy7w84eo';
    store.setDrive(drive);
    const resource = await store.getResource(drive);
    expect(resource.error).toBeUndefined();
    expect(resource.subject).toBe(drive);
    const children = await new CollectionBuilder(store)
      .setProperty(core.properties.parent)
      .setValue(drive)
      .setPageSize(500)
      .setSortBy('https://atomicdata.dev/properties/createdAt')
      .setSortDesc(false)
      .buildAndFetch();
    expect(await children.getAllMembers()).toEqual([
      `${drive}/images-folder`,
      `${drive}/site`,
    ]);
  },
  20000,
);
