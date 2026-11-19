import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from './agent.js';
import { NativeCryptoProvider } from './client-db.native.js';
import { encodeB64 } from './base64.js';
import { NativeClientDb, type NativeChannel } from './client-db.native.js';
import type { ClientDbWorker } from './client-db.js';
import type { AttachmentManifest } from './attachment-manifest.js';
import { BLOB, INTERNAL_ID } from './urls.js';
import { core } from './ontologies/core.js';
import { Resource } from './resource.js';
import { Store } from './store.js';
import { browserReceipt } from './resource-receipts.js';
import type { BrowserReplicaReceipt } from './peer-receipts.js';

const AGENT = 'atomic:agent:source';
const DRIVE = 'atomic:native-drive';
const ack = (
  store: Store,
  receipt: Omit<BrowserReplicaReceipt, 'drive' | 'peerAgent'> &
    Partial<BrowserReplicaReceipt>,
) =>
  store.acknowledgeReceipt(
    browserReceipt({
      drive: DRIVE,
      peerAgent: 'atomic:agent:peer',
      ...receipt,
    })!,
  );

const SOURCE = { storageId: 'a'.repeat(64), generation: 'b'.repeat(64) };
const REPLICA = { storageId: 'c'.repeat(64), generation: 'd'.repeat(64) };
const cleanup: Array<() => void> = [];

type NativeReceipt = {
  subject: string;
  version: string;
  confirmedAt: number;
  source: typeof SOURCE;
  replica: typeof REPLICA;
};
type NativeSnapshot = {
  agent: string;
  agentGeneration: string;
  connections: Array<{
    connectionId: string;
    drive: string;
    peerAgent: string;
    receipts: NativeReceipt[];
    attachmentReceipts?: Array<
      NativeReceipt & { manifest: AttachmentManifest }
    >;
  }>;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(transport: 'iroh' | 'webrtc') {
  const calls: string[][] = [];
  let reply: () => Promise<unknown>;
  const channel: NativeChannel = {
    async call(method, args) {
      if (method === 'getResourcePeerEvidence') {
        calls.push(args[0] as string[]);

        return reply();
      }

      if (method === 'init') return true;
      if (method === 'outboxEntries') return [];
      if (method === 'getResourcesWithSnapshots')
        return (args[0] as string[]).map(() => ({
          jsonAd: null,
          snapshot: null,
        }));

      return null;
    },
  };
  const db = new NativeClientDb(channel);
  const agent = new Agent(new NativeCryptoProvider(channel), AGENT);
  const store = new Store({
    serverUrl: 'https://embed.invalid',
    connect: false,
    noServer: true,
    agent,
  });
  store.setClientDb(db as unknown as ClientDbWorker);
  await db.waitForInit();
  const resource = new Resource('atomic:native-resource');
  resource.setStore(store);
  const props = resource.getLoroDoc()!.getMap('properties');
  props.set(core.properties.name, 'Native notes');
  await resource.set('https://atomicdata.dev/properties/drive', DRIVE, false);
  resource.sealPendingEdits();
  store.resources.set(resource.subject, resource);
  const version = () =>
    encodeB64(resource.getLoroDoc()!.oplogVersion().encode());
  const receipt = (): NativeReceipt => ({
    subject: resource.subject,
    version: version(),
    confirmedAt: 100,
    source: SOURCE,
    replica: REPLICA,
  });
  const snapshot = (): NativeSnapshot => ({
    agent: AGENT,
    agentGeneration: '1',
    connections: [
      {
        connectionId: `${transport}:${'e'.repeat(64)}:1`,
        drive: DRIVE,
        peerAgent: 'atomic:agent:remote',
        receipts: [receipt()],
      },
    ],
  });
  reply = async () => snapshot();
  let stop: (() => void) | undefined;

  const watch = () => {
    stop ??= store.subscribeResourceCopies(resource, () => {});
  };

  const unsubscribe = () => {
    stop?.();
    stop = undefined;
  };

  cleanup.push(() => {
    unsubscribe();
    store.setClientDb(undefined);
  });
  const get = () => store.getResourceCopies(resource).peers;

  const respond = (value: unknown) => {
    reply = async () => structuredClone(value);
  };

  const respondWith = (callback: () => Promise<unknown>) => {
    reply = callback;
  };

  const poll = async () => {
    watch();
    await vi.advanceTimersByTimeAsync(1000);
  };

  return {
    store,
    db,
    agent,
    resource,
    version,
    receipt,
    snapshot,
    calls,
    watch,
    unsubscribe,
    get,
    respond,
    respondWith,
    poll,
  };
}

describe.each(['iroh', 'webrtc'] as const)(
  'native %s host resource peer evidence',
  transport => {
    it('reads host evidence through NativeClientDb without turning it into server proof', async () => {
      const h = await fixture(transport);
      await h.poll();
      expect(h.calls).toContainEqual([h.resource.subject]);
      expect(h.get()).toMatchObject({
        state: 'confirmed',
        connectedCount: 1,
        confirmedCount: 1,
      });
      expect(h.get().peers[0]).toMatchObject({
        peerAgent: 'atomic:agent:remote',
        storageId: REPLICA.storageId,
        confirmedAt: 100,
      });
      expect(h.store.getResourceCopies(h.resource).server.state).toBe(
        'not-configured',
      );
    });

    it('keeps an unsaved or newer local version pending until the host reports that exact version', async () => {
      const h = await fixture(transport);
      const old = h.snapshot();
      h.respond(old);
      await h.poll();
      h.resource
        .getLoroDoc()!
        .getMap('properties')
        .set(core.properties.name, 'Later');
      expect(h.get().state).toBe('pending');
      h.resource.sealPendingEdits();
      await h.poll();
      expect(h.get().state).toBe('pending');
      h.respond(h.snapshot());
      await h.poll();
      expect(h.get().state).toBe('confirmed');
    });

    it('treats missing host receipts and departures as authoritative instead of retaining a prior green state', async () => {
      const h = await fixture(transport);
      await h.poll();
      const missing = h.snapshot();
      missing.connections[0].receipts = [];
      h.respond(missing);
      await h.poll();
      expect(h.get()).toMatchObject({ state: 'unknown', confirmedCount: 0 });
      h.respond(h.snapshot());
      await h.poll();
      expect(h.get().state).toBe('confirmed');
      h.respond({ ...h.snapshot(), connections: [] });
      await h.poll();
      expect(h.get()).toMatchObject({
        state: 'unknown',
        connectedCount: 0,
        confirmedCount: 0,
        peers: [],
      });
    });

    it('does not count cloned source storage or duplicate connections as extra copies', async () => {
      const h = await fixture(transport);
      const data = h.snapshot();
      const first = data.connections[0];
      data.connections.push(
        { ...first, connectionId: 'webrtc:duplicate:2' },
        {
          ...first,
          connectionId: 'iroh:same-source:3',
          receipts: [{ ...h.receipt(), replica: SOURCE }],
        },
      );
      h.respond(data);
      await h.poll();
      expect(h.get().confirmedCount).toBe(1);
      expect(h.get().peers).toHaveLength(1);
    });

    for (const failure of [
      'unsupported',
      'error',
      'malformed',
      'wrong-agent',
    ] as const) {
      it(`clears old native confirmation after ${failure} host evidence`, async () => {
        const h = await fixture(transport);
        await h.poll();
        expect(h.get().state).toBe('confirmed');

        if (failure === 'unsupported') h.respond(undefined);
        else if (failure === 'error')
          h.respondWith(async () => {
            throw new Error('Native host unavailable');
          });
        else if (failure === 'wrong-agent')
          h.respond({ ...h.snapshot(), agent: 'atomic:agent:someone-else' });
        else {
          const malformed = h.snapshot();
          malformed.connections[0].receipts[0].version = 'not-a-version-vector';
          h.respond(malformed);
        }

        await h.poll();
        expect(h.get().state).toBe('unknown');
        expect(h.get().confirmedCount).toBe(0);

        if (failure !== 'unsupported') {
          h.respond(h.snapshot());
          await h.poll();
          expect(h.get().state).toBe('confirmed');
        }
      });
    }

    for (const changed of ['agent', 'database'] as const) {
      it(`ignores a delayed host reply across ${changed} A→B→A`, async () => {
        const h = await fixture(transport);
        const old = h.snapshot();
        let release!: (value: unknown) => void;
        h.respondWith(
          () =>
            new Promise(resolve => {
              release = resolve;
            }),
        );
        h.watch();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls.length).toBeGreaterThan(0);
        h.respond({ ...old, connections: [] });

        if (changed === 'agent') {
          h.store.setAgent(undefined);
          h.store.setAgent(h.agent);
        } else {
          h.store.setClientDb(undefined);
          h.store.setClientDb(h.db as unknown as ClientDbWorker);
        }

        release(old);
        await h.poll();
        expect(h.get().state).toBe('unknown');
        expect(h.get().confirmedCount).toBe(0);
      });
    }

    it('does not borrow old receipt coverage after the native agent epoch changes', async () => {
      const h = await fixture(transport);
      await h.poll();
      h.respond({ ...h.snapshot(), agentGeneration: '2', connections: [] });
      await h.poll();
      expect(h.get().state).toBe('unknown');
      h.respond({ ...h.snapshot(), agentGeneration: '2' });
      await h.poll();
      expect(h.get().state).toBe('confirmed');
    });

    it('releases native proof when the last observer leaves and re-queries a still-live host on remount', async () => {
      const h = await fixture(transport);
      await h.poll();
      h.unsubscribe();
      expect(h.get().confirmedCount).toBe(0);
      const before = h.calls.length;
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.calls).toHaveLength(before);
      const stop = h.store.subscribeResourceCopies(h.resource, () => {});
      cleanup.push(stop);
      await h.poll();
      expect(h.get().state).toBe('confirmed');
    });

    it('bounds a hung bridge to one request, discards its late proof, and recovers with a fresh poll', async () => {
      const h = await fixture(transport);
      await h.poll();
      const old = h.snapshot();
      let release!: (value: unknown) => void;
      h.respondWith(
        () =>
          new Promise(resolve => {
            release = resolve;
          }),
      );
      await h.poll();
      const calls = h.calls.length;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(h.get().state).toBe('unknown');
      expect(h.calls).toHaveLength(calls);
      h.respond({ ...old, connections: [] });
      release(old);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.get().state).toBe('unknown');
      await h.poll();
      expect(h.calls.length).toBeGreaterThan(calls);
      expect(h.get().state).toBe('unknown');
      h.respond(h.snapshot());
      await h.poll();
      expect(h.get().state).toBe('confirmed');
    });

    it('clears omitted attachment evidence even while the native metadata receipt remains', async () => {
      const h = await fixture(transport);
      const hash = 'f'.repeat(64);
      await h.resource.set(BLOB, `atomic:blob:${hash}`, false);
      await h.resource.set(INTERNAL_ID, hash, false);
      h.resource.sealPendingEdits();
      const data = h.snapshot();
      const manifest: AttachmentManifest = {
        files: [{ subject: h.resource.subject, hash, chunks: [] }],
      };
      data.connections[0].attachmentReceipts = [
        {
          ...h.receipt(),
          manifest,
          confirmedAt: Date.now(),
        },
      ];

      const contents = () => {
        const copies = h.store.getResourceCopies(h.resource);

        return {
          ...copies,
          server: copies.server.contents,
          peers: copies.peers.peers.map(peer => ({
            ...peer.contents,
            connectionId: peer.connectionId,
            storageId: peer.storageId,
          })),
        };
      };

      h.respond(data);
      await h.poll();
      expect(contents()).toMatchObject({
        required: true,
        peers: [{ state: 'confirmed' }],
      });
      delete data.connections[0].attachmentReceipts;
      h.respond(data);
      await h.poll();
      expect(h.get().state).toBe('confirmed');
      expect(contents().peers[0].state).toBe('unknown');
      data.connections[0].connectionId = 'untrusted:session';
      h.respond(data);
      await h.poll();
      expect(h.get().confirmedCount).toBe(0);
      expect(contents().peers).toEqual([]);
    });

    it('deduplicates Iroh and WebRTC storage without combining details and bytes from different sessions', async () => {
      const h = await fixture(transport);
      const hash = 'f'.repeat(64);
      await h.resource.set(BLOB, `atomic:blob:${hash}`, false);
      await h.resource.set(INTERNAL_ID, hash, false);
      h.resource.sealPendingEdits();
      const data = h.snapshot();
      data.connections[0].connectionId = 'iroh:same-storage:1';
      const web = {
        ...data.connections[0],
        connectionId: 'webrtc:same-storage:2',
        receipts: [] as NativeReceipt[],
        attachmentReceipts: [
          {
            ...h.receipt(),
            confirmedAt: Date.now(),
            manifest: {
              files: [{ subject: h.resource.subject, hash, chunks: [] }],
            },
          },
        ],
      };
      data.connections.push(web);
      h.respond(data);
      await h.poll();

      const contents = () => {
        const copies = h.store.getResourceCopies(h.resource);

        return {
          ...copies,
          server: copies.server.contents,
          peers: copies.peers.peers.map(peer => ({
            ...peer.contents,
            connectionId: peer.connectionId,
            storageId: peer.storageId,
          })),
        };
      };

      expect(h.get().confirmedCount).toBe(1);
      expect(contents().peers.every(peer => peer.state !== 'confirmed')).toBe(
        true,
      );
      web.receipts = [{ ...h.receipt(), confirmedAt: 200 }];
      h.respond(data);
      await h.poll();
      expect(h.get()).toMatchObject({ connectedCount: 2, confirmedCount: 1 });
      expect(h.get().peers).toHaveLength(1);
      expect(contents().peers).toMatchObject([
        {
          connectionId: web.connectionId,
          state: 'confirmed',
          storageId: REPLICA.storageId,
        },
      ]);
      data.connections.pop();
      h.respond(data);
      await h.poll();
      expect(h.get()).toMatchObject({ connectedCount: 1, confirmedCount: 1 });
      expect(contents().peers).toMatchObject([
        {
          connectionId: 'iroh:same-storage:1',
          state: 'unknown',
        },
      ]);
    });

    it('keeps a real browser connection receipt when native polling fails', async () => {
      const h = await fixture(transport);
      await h.poll();
      h.store.registerResourcePeerSession(
        'browser-session',
        DRIVE,
        'atomic:agent:browser',
      );
      ack(h.store, {
        ...h.receipt(),
        drive: DRIVE,
        peerAgent: 'atomic:agent:browser',
        connectionId: 'browser-session',
        replica: { storageId: 'f'.repeat(64), generation: '0'.repeat(64) },
      });
      expect(h.get().confirmedCount).toBe(2);
      h.respondWith(async () => {
        throw new Error('Bridge disconnected');
      });
      await h.poll();
      expect(h.get()).toMatchObject({ state: 'confirmed', confirmedCount: 1 });
      expect(h.get().peers[0].connectionId).toBe('browser-session');
    });
  },
);
