import { describe, it } from 'vitest';
import { Resource } from './resource.js';
import { testStore } from './test-store.js';
import { core, commits } from './index.js';
import { LoroLoader } from './loro-loader.js';

const NAME = core.properties.name;
const PARENT = core.properties.parent;
const LORO_UPDATE = commits.properties.loroUpdate;

/**
 * Build the bytes a server would send as `loroUpdate`: a snapshot that
 * knows about `name` but not `parent`.
 */
function snapshotWithName(name: string): Uint8Array {
  const { LoroDoc } = LoroLoader.Loro;
  const doc = new LoroDoc();
  doc.setRecordTimestamp(true);
  doc.getMap('properties').set(NAME, name);
  doc.commit({ timestamp: Date.now() });

  return doc.export({ mode: 'snapshot' });
}

describe('outbox provenance', () => {
  it('a fetched foreign resource never enters the outbox', async ({
    expect,
  }) => {
    const { store } = await testStore();
    // A resource on someone else's drive. We have read access, no write.
    const subject = 'did:ad:foreignResource';

    const resource = new Resource(subject);
    resource.setStore(store);
    // Exactly what the JSON-AD ingest does: propvals from the server's
    // index (which include `parent`) alongside a snapshot that predates it.
    resource.applyHydratedValues([
      [LORO_UPDATE, snapshotWithName('Someone elses table')],
      [PARENT, 'did:ad:foreignDrive'],
    ]);
    resource.loading = false;

    // Materialize Loro — this runs the heal pass that writes `parent`
    // into the doc because the snapshot lacks it.
    const doc = resource.getLoroDoc()!;
    // Flush anything the heal pass left pending, as any later read/export
    // or user edit would.
    doc.commit({ timestamp: Date.now() });
    await Promise.resolve();

    expect(store.outbox.hasPending(subject)).toBe(false);
  });

  it('a user edit on that same resource still enqueues', async ({ expect }) => {
    const { store } = await testStore();
    const subject = 'did:ad:foreignResource';

    const resource = new Resource(subject);
    resource.setStore(store);
    resource.applyHydratedValues([
      [LORO_UPDATE, snapshotWithName('Someone elses table')],
      [PARENT, 'did:ad:foreignDrive'],
    ]);
    resource.loading = false;
    resource.getLoroDoc();

    expect(store.outbox.hasPending(subject)).toBe(false);

    // Now the user actually types something.
    await resource.set(NAME, 'I renamed it', false);
    resource.getLoroDoc()!.commit({ timestamp: Date.now() });

    expect(store.outbox.hasPending(subject)).toBe(true);
  });

  it('marks dirty synchronously on commit, as the drain scheduler assumes', async ({
    expect,
  }) => {
    const { store } = await testStore();
    const subject = 'did:ad:syncTiming';

    const resource = new Resource(subject);
    resource.setStore(store);
    resource.applyHydratedValues([[LORO_UPDATE, snapshotWithName('x')]]);
    resource.loading = false;
    const doc = resource.getLoroDoc()!;

    doc.getMap('properties').set(NAME, 'edited');
    doc.commit({ timestamp: Date.now() });

    // No await between commit() and this read.
    expect(store.outbox.hasPending(subject)).toBe(true);
  });

  it('a server response landing mid-keystroke does not swallow the edit', async ({
    expect,
  }) => {
    const { store } = await testStore();
    const subject = 'did:ad:myResource';

    const resource = new Resource(subject);
    resource.setStore(store);
    resource.applyHydratedValues([[LORO_UPDATE, snapshotWithName('before')]]);
    resource.loading = false;
    resource.getLoroDoc();

    // The user types. `set()` leaves the op in an OPEN Loro transaction —
    // nothing has committed yet.
    await resource.set(NAME, 'user typed this', false);

    // A fetch response for the same resource arrives before the next
    // commit boundary.
    resource.applyHydratedValues([[PARENT, 'did:ad:myDrive']]);

    // The edit must still be queued, and must still be the live value.
    expect(store.outbox.hasPending(subject)).toBe(true);
    expect(resource.get(NAME)).toBe('user typed this');
  });
});
