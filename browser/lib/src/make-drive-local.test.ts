import { describe, it } from 'vitest';
import type { ClientDbWorker } from './client-db.js';
import { Resource } from './resource.js';
import { testStore } from './test-store.js';

const DRIVE = 'https://example.com/drive/abc';

/** Only the two members `makeDriveLocal`'s preconditions read. `setClientDb`
 *  touches nothing else on a store with no pending writes. */
const dbStub = (initialized: boolean) =>
  ({
    isReady: false,
    waitForInit: async () => initialized,
  }) as unknown as ClientDbWorker;

/**
 * Turning workspace sync off has three preconditions, and they used to share
 * one message: "Open this drive with local storage available before
 * disconnecting". Signed out, or on a server this client holds no socket for,
 * that told the user to do something they had already done.
 */
describe('makeDriveLocal preconditions', () => {
  it('asks a signed-out user to sign in', async ({ expect }) => {
    const { store } = await testStore();
    store.setAgent(undefined);

    await expect(store.makeDriveLocal(DRIVE)).rejects.toThrow(/Sign in/);
  });

  it('still asks for local storage when there is no database', async ({
    expect,
  }) => {
    // No `expectClientDb`, so this app has opted out and waiting is pointless.
    const { store } = await testStore();

    await expect(store.makeDriveLocal(DRIVE)).rejects.toThrow(/local storage/);
  });

  it('asks for local storage when the database never initializes', async ({
    expect,
  }) => {
    const { store } = await testStore();
    store.setClientDb(dbStub(false));

    await expect(store.makeDriveLocal(DRIVE)).rejects.toThrow(/local storage/);
  });

  it('asks for a server once the database is there', async ({ expect }) => {
    const { store } = await testStore();
    store.setClientDb(dbStub(true));

    // Past the storage guard, and a test store holds no websocket.
    await expect(store.makeDriveLocal(DRIVE)).rejects.toThrow(
      /Connect to a server/,
    );
  });

  it('waits for a database that attaches after the click', async ({
    expect,
  }) => {
    // The attach lands a few hundred ms after boot and after every agent
    // change. A click inside that window used to be refused outright.
    const { store } = await testStore();
    store.expectClientDb();

    const pending = store.makeDriveLocal(DRIVE);
    store.setClientDb(dbStub(true));

    // Reaching the socket check proves it waited instead of refusing.
    await expect(pending).rejects.toThrow(/Connect to a server/);
  });
});

/** The set is read through `normalizeSubject`, so it has to be written
 *  through it too. */
describe('local-only drive registration', () => {
  it('matches a drive registered with a trailing slash', async ({ expect }) => {
    const { store } = await testStore();
    store.registerLocalOnlyDrive(`${DRIVE}/`);

    expect(store.isLocalOnlyDrive(DRIVE)).toBe(true);
  });

  it('unregisters either spelling', async ({ expect }) => {
    const { store } = await testStore();
    store.registerLocalOnlyDrive(DRIVE);
    store.unregisterLocalOnlyDrive(`${DRIVE}/`);

    expect(store.isLocalOnlyDrive(DRIVE)).toBe(false);
  });

  it('matches a resource whose drive propval uses the legacy scheme', async ({
    expect,
  }) => {
    // A demo workspace registers `did:ad:` and the server writes the same
    // spelling into each resource's `drive`. The set holds the canonical
    // `atomic:` form, so this branch has to canonicalize before it looks.
    const { store } = await testStore();
    store.registerLocalOnlyDrive('did:ad:legacy-drive');

    const child = new Resource('did:ad:legacy-child');
    child.setStore(store);
    child.applyHydratedValues([
      ['https://atomicdata.dev/properties/drive', 'did:ad:legacy-drive'],
    ]);
    child.loading = false;
    store.addResource(child);

    expect(store.isLocalOnlySubject('did:ad:legacy-child')).toBe(true);
  });
});
