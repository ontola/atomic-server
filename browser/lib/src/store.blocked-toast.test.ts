import { describe, it, vi, expect as assert } from 'vitest';
import { LocalOutbox, BLOCK_AFTER_FAILURES } from './local-outbox.js';
import { StoreEvents, type Store } from './store.js';
import { testStore } from './test-store.js';

const NO_RIGHT =
  'Unauthorized. No https://atomicdata.dev/properties/write right has been found for did:ad:agent:x=';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('announcing a write that stays blocked', () => {
  async function blockedStore(message: string) {
    const { store, postCommitSpy, agentDID } = await testStore();
    const drive = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      noParent: true,
    });
    postCommitSpy.mockRejectedValue(new Error(message));
    const errors: string[] = [];
    store.on(StoreEvents.Error, e => {
      errors.push(e.message);
    });
    await drive.save().catch(() => undefined);

    return { store, drive, agentDID, errors };
  }

  async function drainUntilBlocked(store: Store, subject: string) {
    for (let i = 0; i < BLOCK_AFTER_FAILURES + 2; i++) {
      const entry = store.outbox.getEntry(subject);
      if (entry) entry.lastAttemptAt = 0;
      await store.syncDirtyResources();
      await settle();
    }
  }

  /** A page reload: the entry comes back from storage, with only what is
   *  persisted, and the store has forgotten what it announced. */
  async function reload(store: Store, subject: string, agentDID: string) {
    await store.outbox.flush();
    const stored = new LocalOutbox();
    stored.rebind(agentDID);
    const persisted = stored.getEntry(subject);
    const live = store.outbox.getEntry(subject)!;
    live.blocked = false;
    live.failures = 0;
    live.lastAttemptAt = 0;
    live.blockedNotified = persisted?.blockedNotified;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any)._notifiedNoRightSubjects.clear();
  }

  it.each([
    ['missing right', NO_RIGHT],
    [
      'quota refusal',
      'Drive did:ad:q has reached its storage quota on this node.',
    ],
  ])(
    'tells the person once across reloads (%s), and again after a new edit',
    async (_, message) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { store, drive, agentDID, errors } = await blockedStore(message);
      const subject = drive.subject;

      await drainUntilBlocked(store, subject);
      assert(store.outbox.getEntry(subject)?.blocked).toBe(true);
      assert(errors).toHaveLength(1);

      await reload(store, subject, agentDID);
      await drainUntilBlocked(store, subject);
      assert(store.outbox.getEntry(subject)?.blocked).toBe(true);
      assert(errors).toHaveLength(1);

      store.outbox.markDirty(subject);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (store as any)._notifiedNoRightSubjects.clear();
      await drainUntilBlocked(store, subject);
      assert(errors).toHaveLength(2);
    },
  );
});
