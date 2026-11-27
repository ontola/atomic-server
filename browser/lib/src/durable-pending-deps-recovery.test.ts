import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientDbOutboxWrite, ClientDbWorker } from './client-db.js';
import { core } from './ontologies/core.js';
import { Resource } from './resource.js';
import type { Store } from './store.js';
import { testStore } from './test-store.js';
import { rowFromLoroSnapshot } from './test-client-db-row.js';

/** An attached worker boundary, including the durable snapshot/outbox pair. */
class DurableDatabase {
  isReady = true;
  isOpen = true;
  isInitialized = true;
  unsupportedEnvironment = false;
  supportsDurablePersistence = true;
  rows = new Map<string, { jsonAd: string; snapshot: Uint8Array }>();
  queues = new Map<string, Map<string, string>>();

  async waitForInit() {
    return true;
  }
  async whenOpen() {
    return true;
  }
  async flush() {}
  async getResourceWithSnapshot(subject: string) {
    return this.rows.get(subject) ?? { jsonAd: null, snapshot: null };
  }
  async getResourcesWithSnapshots(subjects: string[]) {
    return Promise.all(
      subjects.map(subject => this.getResourceWithSnapshot(subject)),
    );
  }
  async putLoroSnapshot(
    subject: string,
    snapshot: Uint8Array,
    lastCommit?: string,
    outbox?: ClientDbOutboxWrite,
  ) {
    this.rows.set(subject, {
      jsonAd: rowFromLoroSnapshot(subject, snapshot, lastCommit),
      snapshot,
    });
    if (outbox) await this.outboxWrite(outbox);
  }
  async outboxEntries(agent: string) {
    return [...(this.queues.get(agent)?.values() ?? [])];
  }
  async outboxWrite(write: ClientDbOutboxWrite) {
    const queue = this.queues.get(write.agent) ?? new Map<string, string>();
    for (const subject of write.deletes) queue.delete(subject);
    for (const { subject, value } of write.puts) queue.set(subject, value);
    this.queues.set(write.agent, queue);
  }
}

function manualDrain(store: Store) {
  // Isolate the refusal/retry boundary from background scheduling.
  vi.spyOn(
    store as unknown as { scheduleOutboxDrain(): void },
    'scheduleOutboxDrain',
  ).mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  localStorage.setItem('ws-disconnected', '1');
});

describe('pending-dependency recovery with durable online checkpoints', () => {
  it.each([false, true])(
    'rewinds the persisted replay cursor before retry (reload: %s)',
    async reload => {
      const initial = await testStore({ connect: false });
      manualDrain(initial.store);
      const resource = await initial.store.newResource({
        isA: core.classes.Folder,
        parent: 'https://example.com/drive',
        propVals: { [core.properties.name]: 'Before' },
      });
      await resource.save();
      const subject = resource.subject;
      const db = new DurableDatabase();
      initial.store.setClientDb(db as unknown as ClientDbWorker);
      await initial.store.outbox.whenHydrated();
      await resource.persistToClientDb(undefined, { required: true });

      // The server lost a previously acknowledged range. Recovery must resend
      // that range, rather than replaying the same rejected causal delta.
      await resource.set(
        core.properties.description,
        'Lost server range',
        false,
      );
      resource.getLoroDoc()!.commit();
      resource.markLoroSavedAt(resource.getLoroDoc()!.oplogVersion());
      await resource.set(core.properties.name, 'After', false);
      initial.postCommitSpy.mockImplementationOnce(async () => {
        throw new Error(
          "Commit's Loro update depends on ops the server does not have — the update was parked as pending and none of its changes could be applied.",
        );
      });

      await expect(resource.save()).rejects.toThrow('parked as pending');
      expect(initial.store.outbox.hasPending(subject)).toBe(true);
      expect(db.rows.has(subject)).toBe(true);
      await initial.store.outbox.flush();

      initial.store.setServerConnected(false);
      const retry = reload ? await testStore({ connect: false }) : initial;

      if (reload) {
        manualDrain(retry.store);
        retry.store.setAgent(initial.store.getAgent()!);
        retry.store.setClientDb(db as unknown as ClientDbWorker);
        await retry.store.outbox.whenHydrated();
      }

      retry.store.setServerConnected(true);
      const entry = retry.store.outbox.getEntry(subject)!;
      entry.failures = 0;
      entry.lastAttemptAt = undefined;
      const count = retry.posted.length;
      await retry.store.syncDirtyResources();
      expect(retry.posted).toHaveLength(count + 1);

      // The resend must import without pending dependencies into a receiver
      // with no history. Both the missing old range and new edit survive.
      const receiver = new Resource(subject);
      expect(
        receiver.importLoroUpdate(retry.posted.at(-1)!.loroUpdate!).complete,
      ).toBe(true);
      expect(receiver.get(core.properties.name)).toBe('After');
      expect(receiver.get(core.properties.description)).toBe(
        'Lost server range',
      );
      expect(retry.store.outbox.hasPending(subject)).toBe(false);
      retry.store.setServerConnected(false);
    },
  );
});
