import { describe, expect, it, vi } from 'vitest';
import { Resource } from './resource.js';
import { Store, StoreEvents } from './store.js';

describe('complete-copy confirmation invalidation events', () => {
  it('notifies when unhydrated bulk resources arrive', () => {
    const store = new Store({
      serverUrl: 'https://example.com',
      connect: false,
    });
    const changed = vi.fn();
    store.on(StoreEvents.SyncStatusChanged, changed);
    store.notifyBulkApplied();
    expect(changed).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    'notifies when blob delivery settles (success=%s)',
    async success => {
      const store = new Store({
        serverUrl: 'https://example.com',
        connect: false,
      });
      const resource = new Resource('atomic:resource:file');
      const changed = vi.fn();
      store.on(StoreEvents.SyncStatusChanged, changed);
      vi.spyOn(store, 'maybePushBlobForResource').mockImplementation(
        async () => {
          if (!success) throw new Error('upload failed');
        },
      );
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(store, 'notifyErrorOnce').mockImplementation(() => {});
      await (
        store as unknown as { pushBlobOrNotify: (r: Resource) => Promise<void> }
      ).pushBlobOrNotify(resource);
      expect(changed).toHaveBeenCalledOnce();
      vi.restoreAllMocks();
    },
  );
});
