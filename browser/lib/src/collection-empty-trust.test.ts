import { describe, it } from 'vitest';
import { Store } from './store.js';

/**
 * When the local WASM DB answers a collection query with zero rows, that is
 * only meaningful if the drive in question has actually been synced into it.
 * An unsynced drive's index is empty because nothing put anything there, not
 * because the drive has no children.
 *
 * The distinction used to be made with "has ANY drive sync finished this
 * session", which is a different question. Signing in provisions and syncs the
 * user's own (new, tiny) personal drive; that flipped the flag, and from then
 * on an empty local result for ANY other drive was believed. Browsing a large
 * drive that had never been synced locally therefore showed an empty sidebar
 * while signed in, and a full one while signed out — because signed out there
 * is no local DB and the query goes to the server.
 */
describe('empty local-DB results are only trusted for synced drives', () => {
  const DRIVE_A = 'did:ad:resource:drive-a';
  const DRIVE_B = 'did:ad:resource:drive-b';

  it('does not vouch for a drive before any sync', ({ expect }) => {
    const store = new Store({ serverUrl: 'https://example.com' });

    expect(store.hasCompletedDriveSyncFor(DRIVE_A)).toBe(false);
  });

  it('vouches for a drive once its own sync finishes', ({ expect }) => {
    const store = new Store({ serverUrl: 'https://example.com' });
    store.finishDriveSync(DRIVE_A, 12, Date.now());

    expect(store.hasCompletedDriveSyncFor(DRIVE_A)).toBe(true);
  });

  it('does NOT let one synced drive vouch for another', ({ expect }) => {
    const store = new Store({ serverUrl: 'https://example.com' });
    store.finishDriveSync(DRIVE_A, 12, Date.now());

    // The regression: syncing the personal drive must not make an empty
    // result for an unrelated, never-synced drive look authoritative.
    expect(store.hasCompletedDriveSyncFor(DRIVE_B)).toBe(false);
  });

  it('remembers every synced drive, not only the most recent', ({ expect }) => {
    const store = new Store({ serverUrl: 'https://example.com' });
    store.finishDriveSync(DRIVE_A, 12, Date.now());
    store.finishDriveSync(DRIVE_B, 3, Date.now());

    expect(store.hasCompletedDriveSyncFor(DRIVE_A)).toBe(true);
    expect(store.hasCompletedDriveSyncFor(DRIVE_B)).toBe(true);
  });

  it('treats an unknown drive as unsynced, so the caller asks the server', ({
    expect,
  }) => {
    const store = new Store({ serverUrl: 'https://example.com' });
    store.finishDriveSync(DRIVE_A, 12, Date.now());

    expect(store.hasCompletedDriveSyncFor(undefined)).toBe(false);
  });
});
