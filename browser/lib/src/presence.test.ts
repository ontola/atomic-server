import { describe, it, beforeAll, vi } from 'vitest';
import { enableLoro } from './loro-loader.js';
import { testStore } from './test-store.js';
import type { PresenceItem } from './presence.js';

describe('DrivePresenceManager.injectEntry', () => {
  beforeAll(async () => {
    await enableLoro();
  });

  it('renders injected sessions as remote peers and removes them on removeEntry', async ({
    expect,
  }) => {
    const { store } = await testStore();
    const drive = 'did:ad:test-drive';
    store.registerLocalOnlyDrive(drive);

    const manager = store.getPresence(drive);
    let snapshot: PresenceItem[] = [];
    const unsubscribe = manager.subscribe(() => {
      snapshot = manager.getSnapshot();
    });

    manager.injectEntry('demo-session-mara', {
      agent: 'did:ad:agent:mara',
      resource: 'did:ad:some-doc',
      allowFollow: true,
    });

    // The ephemeral store emits synchronously once Loro is loaded.
    expect(snapshot.map(item => item.sessionId)).toContain('demo-session-mara');
    const mara = snapshot.find(item => item.sessionId === 'demo-session-mara');
    expect(mara?.agent).toBe('did:ad:agent:mara');
    expect(mara?.resource).toBe('did:ad:some-doc');
    expect(mara?.allowFollow).toBe(true);

    manager.removeEntry('demo-session-mara');
    expect(
      snapshot.find(item => item.sessionId === 'demo-session-mara'),
    ).toBeUndefined();

    unsubscribe();
  });

  it('buffers entries injected before a subscriber starts the manager', async ({
    expect,
  }) => {
    const { store } = await testStore();
    const drive = 'did:ad:test-drive-2';
    store.registerLocalOnlyDrive(drive);

    const manager = store.getPresence(drive);
    // No subscriber yet — the ephemeral store doesn't exist. The entry
    // must survive until the first subscriber initializes it.
    manager.injectEntry('early-session', { agent: 'did:ad:agent:pip' });

    const unsubscribe = manager.subscribe(() => {});
    // The first subscriber initializes the ephemeral store, applying the
    // buffered entry before any listener fires — read the snapshot
    // directly, like `useSyncExternalStore` does on mount.
    const snapshot = manager.getSnapshot();

    expect(snapshot.map(item => item.sessionId)).toContain('early-session');
    unsubscribe();
  });
});

describe('announcements Loro cannot store', () => {
  beforeAll(async () => {
    await enableLoro();
  });

  /**
   * A view's payload is typed as whatever that view likes, so a callback can
   * travel in it. Loro does not answer such a value with an error: it panics,
   * which reaches the browser as a bare `RuntimeError: unreachable` and leaves
   * the wasm module unusable. Because the heartbeat re-sends the stored entry
   * every ten seconds, storing one turned into an error on a timer for as long
   * as the tab was open.
   */
  it('refuses a payload carrying a function and keeps the last good entry', async ({
    expect,
  }) => {
    const { store } = await testStore();
    const drive = 'did:ad:test-drive-unstorable';
    store.registerLocalOnlyDrive(drive);

    const manager = store.getPresence(drive);
    const unsubscribe = manager.subscribe(() => {});
    const refusals: unknown[][] = [];
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        refusals.push(args);
      });

    try {
      manager.setLocal({ resource: 'did:ad:a-doc', data: { row: 'row-1' } });
      manager.patchLocal({ data: { onMove: () => undefined } });

      const mine = manager
        .getSnapshot()
        .find(item => item.sessionId === manager.sessionId);

      expect(mine?.resource).toBe('did:ad:a-doc');
      expect(mine?.data).toEqual({ row: 'row-1' });
      expect(refusals.flat().join(' ')).toContain('presence.data.onMove');

      // The store survived, so the heartbeat that re-sends the entry every ten
      // seconds still works. Before the check this threw, on a timer, forever.
      expect(() => manager.rebroadcast()).not.toThrow();
      expect(
        manager.getSnapshot().find(item => item.sessionId === manager.sessionId)
          ?.data,
      ).toEqual({ row: 'row-1' });
    } finally {
      consoleError.mockRestore();
      unsubscribe();
    }
  });

  it('refuses a cyclic payload rather than corrupting the wasm heap', async ({
    expect,
  }) => {
    const { store } = await testStore();
    const drive = 'did:ad:test-drive-cyclic';
    store.registerLocalOnlyDrive(drive);

    const manager = store.getPresence(drive);
    const unsubscribe = manager.subscribe(() => {});
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    try {
      const cyclic: Record<string, unknown> = { row: 'row-1' };
      cyclic.self = cyclic;

      manager.setLocal({ resource: 'did:ad:a-doc', data: cyclic });

      expect(
        manager
          .getSnapshot()
          .find(item => item.sessionId === manager.sessionId),
      ).toBeUndefined();
      expect(consoleError).toHaveBeenCalled();
      expect(() => manager.rebroadcast()).not.toThrow();
    } finally {
      consoleError.mockRestore();
      unsubscribe();
    }
  });
});
