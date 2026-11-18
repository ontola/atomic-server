import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type ServerHandle } from './server-fixture.js';
import { Agent } from '../src/agent.js';
import { Store, StoreEvents, type DriveSyncState } from '../src/store.js';
import { core } from '../src/ontologies/core.js';
import type { ServerReplicaReceipt } from '../src/server-receipts.js';
import { NodeClientDb } from '../src/client-db.node.js';
import type { ClientDbWorker } from '../src/client-db.js';
import { decodeB64 } from '../src/base64.js';
import { LoroLoader } from '../src/loro-loader.js';

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 25_000;
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

  it('produces fresh evidence after reconnect without another save', async () => {
    localStorage.removeItem('ws-disconnected');
    const wasmPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../wasm/pkg/atomic_wasm_bg.wasm',
    );
    const db = new NodeClientDb({ wasmPath, baseUrl: server.serverUrl });
    await db.init();
    const agent = await Agent.fromSecret(server.agentSecret);
    const store = new Store({ serverUrl: server.serverUrl, agent });
    store.setClientDb(db as unknown as ClientDbWorker);
    const inventories: DriveSyncState[] = [];
    const compute = store.computeDriveSyncState.bind(store);
    vi.spyOn(store, 'computeDriveSyncState').mockImplementation(
      async (...args) => {
        const state = await compute(...args);
        inventories.push(state);
        return state;
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
        .filter(state => state.drive === drive.subject)
        .map(state => {
          const entries = state.vvs
            ? Object.entries(state.vvs[resource.subject] ?? {})
            : state.peers.map(
                (peer, index) =>
                  [peer, state.resources[resource.subject]?.[index]] as [
                    string,
                    number,
                  ],
              );
          return new Map(entries.filter(([, counter]) => counter > 0));
        });
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
