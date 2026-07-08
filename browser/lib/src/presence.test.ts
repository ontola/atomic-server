import { describe, it, beforeAll } from 'vitest';
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
