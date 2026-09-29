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

/**
 * Loro's wasm instance is shared by everything in the tab, so a panic in a
 * document import leaves the presence store trapping too, with a bare
 * `RuntimeError: unreachable` that no value check on our side could have
 * prevented. What made that one panic a permanent error source is Loro's own
 * expiry timer: it lives in the JS wrapper, calls `removeOutdated()` every
 * TTL/2 for as long as the store holds a key, and dropping our reference to
 * the store does not stop it. `destroy()` does, and it only clears the
 * interval, so it works on a module that can no longer be called into.
 */
describe('a poisoned wasm module', () => {
  beforeAll(async () => {
    await enableLoro();
  });

  /** A store whose wasm calls trap, as every call does after a panic. */
  const poisoned = () => {
    const trap = () => {
      throw new Error('unreachable');
    };

    return {
      set: trap,
      delete: trap,
      apply: trap,
      encode: trap,
      getAllStates: trap,
      destroy: vi.fn(),
    };
  };

  const install = (manager: unknown, store: unknown) => {
    (manager as { ephemeral?: unknown }).ephemeral = store;
  };

  const heartbeatOf = (manager: unknown) =>
    (manager as { heartbeat?: unknown }).heartbeat;

  it('stops the expiry timer and the heartbeat on the first trap', async ({
    expect,
  }) => {
    const { store } = await testStore();
    const drive = 'did:ad:test-drive-poisoned';
    store.registerLocalOnlyDrive(drive);

    const manager = store.getPresence(drive);
    const unsubscribe = manager.subscribe(() => {});
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    try {
      manager.setLocal({ resource: 'did:ad:a-doc' });
      expect(heartbeatOf(manager)).toBeDefined();

      const dead = poisoned();
      install(manager, dead);

      expect(() => manager.rebroadcast()).not.toThrow();
      expect(dead.destroy).toHaveBeenCalledOnce();
      expect(heartbeatOf(manager)).toBeUndefined();

      // Nothing calls into the dead store again, so the next heartbeat tick
      // (were one still scheduled) has nothing left to throw from.
      expect(() => manager.rebroadcast()).not.toThrow();
      expect(dead.destroy).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
      unsubscribe();
    }
  });

  it("gives up on a peer's bytes rather than raising them on a timer", async ({
    expect,
  }) => {
    const { store } = await testStore();
    const drive = 'did:ad:test-drive-poisoned-peer';
    store.registerLocalOnlyDrive(drive);

    const manager = store.getPresence(drive);
    const unsubscribe = manager.subscribe(() => {});
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    try {
      const dead = poisoned();
      install(manager, dead);

      // Reading the peer list is what `getSnapshot`'s source does on every
      // ephemeral event, and it traps just like a write.
      expect(() =>
        manager.injectEntry('peer', { agent: 'did:ad:agent:x' }),
      ).not.toThrow();
      expect(dead.destroy).toHaveBeenCalledOnce();
      expect(manager.getSnapshot()).toEqual([]);
    } finally {
      consoleError.mockRestore();
      unsubscribe();
    }
  });

  it('still stops the timer when the departure announcement traps', async ({
    expect,
  }) => {
    const { store } = await testStore();
    const drive = 'did:ad:test-drive-poisoned-leave';
    store.registerLocalOnlyDrive(drive);

    const manager = store.getPresence(drive);
    const unsubscribe = manager.subscribe(() => {});
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const dead = poisoned();
    install(manager, dead);

    try {
      // `stop()` used to announce the departure first and reach `destroy()`
      // only if that call returned.
      expect(() => unsubscribe()).not.toThrow();
      expect(dead.destroy).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
