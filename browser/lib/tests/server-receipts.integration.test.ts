import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type ServerHandle } from './server-fixture.js';
import { Agent } from '../src/agent.js';
import { Store, StoreEvents } from '../src/store.js';
import { core } from '../src/ontologies/core.js';
import type { ServerReplicaReceipt } from '../src/server-receipts.js';
import {
  fileClientDb,
  closeFileClientDb,
  disposeFileClientDbs,
} from './file-client-db.js';
import type { ClientDbWorker } from '../src/client-db.js';
import { decodeB64 } from '../src/base64.js';
import { LoroLoader } from '../src/loro-loader.js';

async function until(check: () => boolean, timeout = 25_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await delay(25);
  expect(check()).toBe(true);
}

describe('automatic storage receipts against a real server', () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await startServer();
  }, 120_000);

  afterAll(async () => {
    localStorage.removeItem('ws-disconnected');
    await server?.stop();
  });

  it.each(['http', 'websocket'] as const)(
    'observes consecutive exact save versions over %s without application probes',
    async transport => {
      if (transport === 'http') localStorage.setItem('ws-disconnected', '1');
      else localStorage.removeItem('ws-disconnected');
      const agent = await Agent.fromSecret(server.agentSecret);
      // No local database: remote storage evidence is still useful, but must
      // not invent a persistent source identity for this memory-only client.
      const store = new Store({ serverUrl: server.serverUrl, agent });
      const observed: ServerReplicaReceipt[] = [];
      const off = store.on(StoreEvents.ServerReplicaReceipt, receipt => {
        observed.push(receipt);
      });
      let heldSubject = '';
      let held = false;
      let release!: () => void;
      const responseGate = new Promise<void>(resolve => {
        release = resolve;
      });
      let httpProbes = 0;
      store.injectFetch(async (input, init) => {
        const response = await fetch(input, init);

        if (String(input).endsWith('/storage-receipt')) {
          httpProbes++;
          const request = JSON.parse(String(init?.body));

          if (request.subject === heldSubject && !held) {
            held = true;
            // The server has already flushed C1; delay only its response so
            // C2 can complete before the C1 evidence reaches the observer.
            await responseGate;
          }
        }

        return response;
      });

      try {
        if (transport === 'websocket') await until(() => store.serverConnected);
        else store.setServerConnected(true);
        const drive = await store.ensurePrivateDrive();
        const resource = await store.newResource({
          parent: drive.subject,
          propVals: { [core.properties.name]: `Receipt ${transport} C1` },
        });
        heldSubject = resource.subject;
        const c1 = await resource.saveWithReceipt();
        expect(c1.server?.version).toBeTruthy();
        if (transport === 'http') await until(() => held);
        await resource.set(core.properties.name, `Receipt ${transport} C2`);
        const c2 = await resource.saveWithReceipt();
        expect(c2.server?.version).toBeTruthy();
        expect(c2.server!.version).not.toBe(c1.server!.version);
        release();

        const matching = (version: string | null) =>
          observed.find(
            receipt =>
              receipt.observation.barrier?.subject === resource.subject &&
              receipt.observation.barrier.version === version &&
              receipt.transport === transport,
          );
        await until(
          () =>
            !!matching(c1.server!.version) && !!matching(c2.server!.version),
        );
        const first = matching(c1.server!.version)!;
        const second = matching(c2.server!.version)!;
        expect(first.observation.replica).toEqual(second.observation.replica);
        expect(first.observation.replica?.storageId).toMatch(/^[0-9a-f]{64}$/);
        expect(first.observation.replica?.generation).toMatch(/^[0-9a-f]{64}$/);
        expect(first.observation.barrier).toMatchObject({
          name: 'atomic-redb-flush-v1',
          storage: 'persistent',
          state: 'completed',
        });
        expect(first.source).toBeUndefined();
        expect(first.clientAgent).toBe(agent.subject);
        expect(first.serverOrigin).toBe(server.serverUrl);
        expect(first.endpoint).toBe(`${server.serverUrl}/storage-receipt`);
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(first.observation)).toBe(true);
        expect(Object.isFrozen(first.observation.barrier)).toBe(true);
        expect(Object.isFrozen(first.observation.replica)).toBe(true);
        if (transport === 'http') expect(httpProbes).toBeGreaterThanOrEqual(2);
        else expect(httpProbes).toBe(0);
      } finally {
        release();
        off();
        store.disconnect();
        store.setServerConnected(false);
        localStorage.removeItem('ws-disconnected');
      }
    },
    60_000,
  );

  it.each(['genesis', 'update'] as const)(
    'observes a cold %s outbox acceptance without an active save call',
    async kind => {
      localStorage.setItem('ws-disconnected', '1');
      const wasmPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../wasm/pkg/atomic_wasm_bg.wasm',
      );
      let db = fileClientDb({ wasmPath, baseUrl: server.serverUrl });
      await db.init();
      const agent = await Agent.fromSecret(server.agentSecret);
      const first = new Store({ serverUrl: server.serverUrl, agent });
      first.setClientDb(db as unknown as ClientDbWorker);
      first.setServerConnected(true);
      let second: Store | undefined;

      try {
        const drive = await first.ensurePrivateDrive();
        if (kind === 'genesis') first.setServerConnected(false);
        const resource = await first.newResource({
          parent: drive.subject,
          propVals: { [core.properties.name]: `Cold ${kind}` },
        });
        if (kind === 'update') await resource.save();
        first.setServerConnected(false);
        if (kind === 'update')
          await resource.set(core.properties.name, `Queued ${kind}`);
        expect(await resource.save()).toBe('offline');
        await first.outbox.flush();
        await db.flush();
        const queuedSnapshot = await db.getResourceWithSnapshot(
          resource.subject,
        );
        const queuedDoc = new LoroLoader.Loro.LoroDoc();
        queuedDoc.import(queuedSnapshot.snapshot!);
        const queuedVersion = queuedDoc.version().toJSON();
        queuedDoc.free();
        first.disconnect();
        first.setServerConnected(false);
        await closeFileClientDb(db);
        db = fileClientDb({ wasmPath, baseUrl: server.serverUrl }, db);
        await db.init();

        second = new Store({ serverUrl: server.serverUrl, agent });
        second.setClientDb(db as unknown as ClientDbWorker);
        await second.outbox.whenHydrated();
        expect(second.resources.has(resource.subject)).toBe(false);
        const observed: ServerReplicaReceipt[] = [];
        const saves: unknown[] = [];
        const sentVersions: Map<string, number>[] = [];
        const postCommit = second.postCommit.bind(second);
        vi.spyOn(second, 'postCommit').mockImplementation(
          (commit, endpoint) => {
            if (commit.subject === resource.subject && commit.loroUpdate) {
              sentVersions.push(
                new Map(
                  commit.isGenesis
                    ? LoroLoader.Loro.decodeImportBlobMeta(
                        commit.loroUpdate,
                        false,
                      ).partialEndVersionVector.toJSON()
                    : second!.resources
                        .get(resource.subject)!
                        .getLoroDoc()!
                        .oplogVersion()
                        .toJSON(),
                ),
              );
            }

            return postCommit(commit, endpoint);
          },
        );
        second.on(StoreEvents.ServerReplicaReceipt, receipt =>
          observed.push(receipt),
        );
        second.on(StoreEvents.SaveReceipt, receipt => saves.push(receipt));
        second.setServerConnected(true);
        // Ordinary reconnect drain, with no Resource.save/saveWithReceipt
        // invocation in this new Store and no receipt probe from the test.
        await second.syncDirtyResources();
        expect(second.outbox.hasPending(resource.subject)).toBe(false);

        const matchesQueued = (receipt: ServerReplicaReceipt) => {
          if (receipt.observation.barrier?.subject !== resource.subject)
            return false;
          const actual = LoroLoader.Loro.VersionVector.decode(
            decodeB64(receipt.observation.barrier.version!),
          ).toJSON();

          return [...queuedVersion].every(
            ([peer, counter]) => (actual.get(peer) ?? 0) >= counter,
          );
        };

        await until(() => observed.some(matchesQueued));
        const receipt = observed.find(matchesQueued)!;
        expect(sentVersions).toContainEqual(
          LoroLoader.Loro.VersionVector.decode(
            decodeB64(receipt.observation.barrier!.version!),
          ).toJSON(),
        );
        expect(receipt.transport).toBe('http');
        expect(receipt.source).toBeUndefined();
        expect(receipt.clientAgent).toBe(agent.subject);
        expect(saves).toEqual([]);
      } finally {
        first.disconnect();
        first.setServerConnected(false);
        second?.disconnect();
        second?.setServerConnected(false);
        localStorage.removeItem('ws-disconnected');
      }
    },
    60_000,
  );

  it('observes newly imported stored state without another save or reconnect', async () => {
    localStorage.removeItem('ws-disconnected');
    const wasmPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../wasm/pkg/atomic_wasm_bg.wasm',
    );
    const db = fileClientDb({ wasmPath, baseUrl: server.serverUrl });
    await db.init();
    const agent = await Agent.fromSecret(server.agentSecret);
    const observer = new Store({ serverUrl: server.serverUrl, agent });
    observer.setClientDb(db as unknown as ClientDbWorker);
    const writer = new Store({ serverUrl: server.serverUrl, agent });
    const observed: ServerReplicaReceipt[] = [];
    observer.on(StoreEvents.ServerReplicaReceipt, receipt =>
      observed.push(receipt),
    );

    try {
      await until(() => observer.serverConnected && writer.serverConnected);
      const drive = await observer.ensurePrivateDrive();
      observer.setDrive(drive.subject);
      await until(() =>
        observed.some(
          receipt =>
            receipt.observation.barrier?.subject === drive.subject &&
            receipt.transport === 'websocket',
        ),
      );
      const connection = observed.find(
        receipt => receipt.transport === 'websocket',
      )!.connectionId;
      const save = vi.spyOn(observer, 'notifySaveReceipt');
      const resource = await writer.newResource({
        parent: drive.subject,
        propVals: {
          [core.properties.name]: 'Imported after initial inventory',
        },
      });
      const accepted = await resource.saveWithReceipt();
      await observer.fetchResourceFromServer(resource.subject);
      await db.flush();
      const stored = await db.getResourceWithSnapshot(resource.subject);
      expect(stored.snapshot?.length).toBeGreaterThan(0);
      await until(
        () =>
          observed.some(
            receipt =>
              receipt.observation.barrier?.subject === resource.subject &&
              receipt.connectionId === connection,
          ),
        45_000,
      );
      const receipt = observed.find(
        item =>
          item.observation.barrier?.subject === resource.subject &&
          item.connectionId === connection,
      )!;
      const target = LoroLoader.Loro.VersionVector.decode(
        decodeB64(receipt.observation.barrier!.version!),
      ).toJSON();
      const acceptedVersion = LoroLoader.Loro.VersionVector.decode(
        decodeB64(accepted.server!.version!),
      ).toJSON();

      for (const [peer, counter] of acceptedVersion) {
        expect(target.get(peer) ?? 0).toBeGreaterThanOrEqual(counter);
      }

      expect(receipt.source).toBeUndefined();
      expect(save).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
      observer.setServerConnected(false);
      writer.disconnect();
      writer.setServerConnected(false);
    }
  }, 60_000);

  it('produces fresh evidence after reconnect without another save', async () => {
    localStorage.removeItem('ws-disconnected');
    const wasmPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../wasm/pkg/atomic_wasm_bg.wasm',
    );
    const db = fileClientDb({ wasmPath, baseUrl: server.serverUrl });
    await db.init();
    const agent = await Agent.fromSecret(server.agentSecret);
    const store = new Store({ serverUrl: server.serverUrl, agent });
    store.setClientDb(db as unknown as ClientDbWorker);
    const inventories: Array<{
      subject: string;
      version: Map<string, number>;
    }> = [];
    const readSnapshot = db.getResourceWithSnapshot.bind(db);
    vi.spyOn(db, 'getResourceWithSnapshot').mockImplementation(
      async subject => {
        const stored = await readSnapshot(subject);

        if (stored.snapshot) {
          const doc = new LoroLoader.Loro.LoroDoc();

          try {
            doc.import(stored.snapshot);
            inventories.push({
              subject,
              version: new Map(
                [...doc.version().toJSON()].filter(
                  ([, counter]) => counter > 0,
                ),
              ),
            });
          } finally {
            doc.free();
          }
        }

        return stored;
      },
    );
    const observed: ServerReplicaReceipt[] = [];
    const off = store.on(StoreEvents.ServerReplicaReceipt, receipt => {
      observed.push(receipt);
    });

    try {
      await until(() => store.serverConnected);
      const drive = await store.ensurePrivateDrive();
      store.setDrive(drive.subject);
      const resource = await store.newResource({
        parent: drive.subject,
        propVals: { [core.properties.name]: 'Reconciliation receipt' },
      });
      const saved = await resource.saveWithReceipt();
      const matching = () =>
        observed.filter(
          receipt =>
            receipt.observation.barrier?.subject === resource.subject &&
            receipt.transport === 'websocket',
        );
      await until(() => matching().length > 0);
      const previousConnection = matching()[0].connectionId;
      await db.flush();
      inventories.length = 0;
      await store.reconnect();
      await until(() =>
        matching().some(receipt => receipt.connectionId !== previousConnection),
      );
      const receipt = matching().find(
        item => item.connectionId !== previousConnection,
      )!;
      const counters = (version: string) =>
        LoroLoader.Loro.VersionVector.decode(decodeB64(version)).toJSON();
      // Reconciliation captures stored state, which can also contain server
      // metadata added after the immutable save version. Require equality to
      // an actual captured inventory, and coverage of the saved operations.
      const target = counters(receipt.observation.barrier!.version!);
      const captured = inventories
        .filter(state => state.subject === resource.subject)
        .map(state => state.version);
      expect(captured).toContainEqual(target);

      for (const [peer, counter] of counters(saved.server!.version!)) {
        expect(target.get(peer) ?? 0).toBeGreaterThanOrEqual(counter);
      }

      expect(receipt.source).toBeUndefined();
    } finally {
      off();
      store.disconnect();
      store.setServerConnected(false);
      // The fork owns this WASM runtime. Let process teardown release it after
      // pending socket callbacks, as in the other real-server WASM suites.
    }
  });
});

afterAll(disposeFileClientDbs);
