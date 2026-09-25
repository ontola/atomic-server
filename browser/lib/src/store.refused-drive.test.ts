import { describe, it, vi } from 'vitest';
import type { Agent } from './agent.js';
import type { ClientDbWorker } from './client-db.js';
import { Store } from './store.js';

const DRIVE = 'did:ad:personal';
const OTHER = 'did:ad:other';
const REFUSAL = `Drive ${DRIVE} is not enrolled for sync on this node.`;

function storeWithLocalCopy() {
  const store = new Store({ serverUrl: 'http://localhost:9883' });
  vi.spyOn(store, 'getAgent').mockReturnValue({} as Agent);
  vi.spyOn(store, 'getClientDb').mockReturnValue({
    isReady: true,
  } as ClientDbWorker);

  return store;
}

describe('a drive the server refuses as not enrolled', () => {
  it('is reported as refused, and only for that drive', ({ expect }) => {
    const store = new Store({ serverUrl: 'http://localhost:9883' });
    expect(store.isDriveRefusedByServer(DRIVE)).toBe(false);

    store.failDriveSync(DRIVE, REFUSAL);

    expect(store.isDriveRefusedByServer(DRIVE)).toBe(true);
    expect(store.isDriveRefusedByServer(OTHER)).toBe(false);
  });

  it('is not refused for any other sync error', ({ expect }) => {
    const store = new Store({ serverUrl: 'http://localhost:9883' });
    store.failDriveSync(
      DRIVE,
      `Drive ${DRIVE} has reached its storage quota on this node.`,
    );

    expect(store.isDriveRefusedByServer(DRIVE)).toBe(false);
  });

  it('can be made local without the server, dropping its refused writes', async ({
    expect,
  }) => {
    const store = storeWithLocalCopy();
    // No websocket and no server inventory: the refused path must not need them.
    vi.spyOn(store, 'getDefaultWebSocket').mockReturnValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outbox = (store as any).outbox;
    outbox.markDirty(DRIVE);
    store.failDriveSync(DRIVE, REFUSAL);

    await store.makeDriveLocal(DRIVE);

    expect(store.isLocalOnlyDrive(DRIVE)).toBe(true);
    expect(store.isDriveRefusedByServer(DRIVE)).toBe(false);
    expect(outbox.size).toBe(0);
    expect(store.getSyncStatus().lastDriveSyncError).toBeUndefined();
  });

  it('still verifies the local copy for a drive the server hosts', async ({
    expect,
  }) => {
    const store = storeWithLocalCopy();
    vi.spyOn(store, 'getDefaultWebSocket').mockReturnValue(undefined);

    await expect(store.makeDriveLocal(DRIVE)).rejects.toThrow(
      'Open this drive with local storage available before disconnecting.',
    );
    expect(store.isLocalOnlyDrive(DRIVE)).toBe(false);
  });
});
