import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  BrowserPeerSync,
  type BrowserReplicaReceipt,
} from './browser-peer-sync.js';
import {
  CAP_BROWSER_STORAGE_RECEIPTS,
  PEER_STORAGE_BARRIER,
  Tag,
  decodeCommit,
} from './ws-v2.js';
import { testStore } from './test-store.js';
import { core } from './ontologies/core.js';
import { encodeB64, decodeB64 } from './base64.js';
import { LoroLoader } from './loro-loader.js';
import { commits } from './ontologies/commits.js';
import type { ClientDbWorker } from './client-db.js';
import type { Store } from './store.js';

const peers = vi.hoisted(
  () =>
    [] as {
      sent: Uint8Array[];
      connect(other: unknown): void;
      deliver(frame: Uint8Array): void;
    }[],
);
vi.mock('./webrtc-peer.js', () => ({
  WebRtcPeer: class {
    sent: Uint8Array[] = [];
    private queue: Uint8Array[] = [];
    private waiter?: (frame: Uint8Array | undefined) => void;
    private other?: { deliver(frame: Uint8Array): void };
    private resolve!: (pipe: unknown) => void;
    transport = new Promise(resolve => {
      this.resolve = resolve;
    });
    constructor() {
      peers.push(this);

      if (peers.length % 2 === 0) {
        const other = peers[peers.length - 2];
        this.connect(other);
        other.connect(this);
      }
    }
    connect(other: unknown) {
      this.other = other as typeof this.other;
      this.resolve({
        send: async (frame: Uint8Array) => {
          this.sent.push(frame);
          this.other!.deliver(frame);
        },
        recv: async () =>
          this.queue.shift() ??
          new Promise(resolve => {
            this.waiter = resolve;
          }),
      });
    }
    deliver(frame: Uint8Array) {
      if (this.waiter) {
        const resolve = this.waiter;
        this.waiter = undefined;
        resolve(frame);
      } else this.queue.push(frame);
    }
    close() {
      this.waiter?.(undefined);
    }
    async channelBinding() {
      return 'binding';
    }
    async connectionPath() {
      return 'direct';
    }
    async createOffer() {
      return { type: 'offer', sdp: 'offer' };
    }
  },
}));
class SignalSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: SignalSocket[] = [];
  readyState = 1;
  constructor() {
    super();
    SignalSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  join() {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'joined', peers: ['f'.repeat(64)] }),
      }),
    );
  }
}
const links: BrowserPeerSync[] = [];
const stores: Store[] = [];
const json = (tag: number, data: unknown) =>
  new Uint8Array([tag, ...new TextEncoder().encode(JSON.stringify(data))]);
const parse = (frame: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(frame.subarray(1)));
beforeEach(() => {
  peers.length = 0;
  SignalSocket.instances = [];
  vi.stubGlobal('WebSocket', SignalSocket);
});
afterEach(() => {
  links.splice(0).forEach(link => link.close());
  stores.splice(0).forEach(store => store.setServerConnected(false));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(
  capability = true,
  sourceAvailable = true,
  reportPeerAgent = true,
) {
  const left = (await testStore()).store;
  const right = (await testStore()).store;
  stores.push(left, right);
  const resource = await left.newResource({ noParent: true });
  const drive = resource.subject;
  left.registerLocalOnlyDrive(drive);
  const events: BrowserReplicaReceipt[] = [];
  const held: Uint8Array[] = [];
  const control = { hold: false };
  const identities = [
    { storageId: 'a'.repeat(64), generation: 'b'.repeat(64) },
    { storageId: 'c'.repeat(64), generation: 'd'.repeat(64) },
  ];
  const dbs = [left, right].map((store, index) => {
    const db = {
      getReplicaIdentity: vi.fn(async () =>
        sourceAvailable ? identities[index] : undefined,
      ),
      putResourceWithSnapshot: vi.fn(async () => {}),
      getResourceWithSnapshot: vi.fn(async () => ({
        snapshot: new Uint8Array([1]),
      })),
      createPeerSession: vi.fn(async () => 1),
      closePeerSession: vi.fn(async () => {}),
      canSendPeerFrame: vi.fn(async () => true),
      handlePeerFrame: vi.fn(async (_session: number, frame: Uint8Array) => {
        if (frame[0] === Tag.AUTH)
          return {
            frames: [
              capability
                ? json(Tag.AUTH_OK, [CAP_BROWSER_STORAGE_RECEIPTS])
                : new Uint8Array([Tag.AUTH_OK]),
            ],
            changed: [],
            // Authenticated Rust result, not a provider's claimed identity.
            peerAgent: reportPeerAgent
              ? (index === 0 ? right : left).getAgent()!.subject!
              : undefined,
          };

        if (frame[0] === Tag.STORAGE_RECEIPT_REQUEST) {
          const response = json(Tag.STORAGE_RECEIPT_RESPONSE, {
            ...parse(frame),
            replica: identities[index],
            barrier: PEER_STORAGE_BARRIER,
          });

          if (control.hold) {
            held.push(response);

            return { frames: [], changed: [] };
          }

          return { frames: [response], changed: [] };
        }

        return { frames: [], changed: [] };
      }),
    };
    store.setClientDb(db as unknown as ClientDbWorker);
    vi.spyOn(store, 'computeDriveSyncState').mockImplementation(async () => {
      const version = resource.getLoroDoc()!.oplogVersion().toJSON();

      return {
        drive,
        driveHash: 'hash',
        peers: [...version.keys()],
        resources: index === 0 ? { [drive]: [...version.values()] } : {},
      };
    });

    return db;
  });

  function connect(store: Store) {
    const link = new BrowserPeerSync(store, {
      drive,
      room: 'e'.repeat(64),
      signalingUrl: 'ws://localhost/signal',
      onReplicaReceipt: event => {
        events.push(event);
      },
    });
    links.push(link);
    (link as unknown as { peerId: string }).peerId = '0'.repeat(64);
    SignalSocket.instances.at(-1)!.join();

    return link;
  }

  connect(left);

  return {
    left,
    right,
    resource,
    drive,
    events,
    dbs,
    identities,
    held,
    control,
    connect,
  };
}

it('automatically confirms current persisted inventory after a paired handshake', async () => {
  const h = await setup();
  await h.resource.set(core.properties.name, 'First', false);
  await h.resource.save();
  const version = encodeB64(h.resource.getLoroDoc()!.oplogVersion().encode());
  h.connect(h.right);
  await vi.waitUntil(() => h.events.length === 1);
  expect(h.events[0]).toMatchObject({
    source: h.identities[0],
    peerAgent: h.right.getAgent()!.subject,
    drive: h.drive,
    replica: h.identities[1],
    version,
  });
  expect(h.left.getResourcePeerSyncStatus(h.resource).confirmedCount).toBe(1);
  expect(Object.isFrozen(h.events[0])).toBe(true);
  links[0].close();
  expect(h.left.getResourcePeerSyncStatus(h.resource).confirmedCount).toBe(0);
});

it.each([
  [false, true],
  [true, false],
])(
  'keeps normal synchronization without receipts for capability=%s source=%s',
  async (capability, source) => {
    const h = await setup(capability, source);
    await h.resource.set(core.properties.name, 'Initial', false);
    await h.resource.save();
    h.connect(h.right);
    await vi.waitUntil(() =>
      peers[0].sent.some(frame => frame[0] === Tag.SYNC),
    );
    expect(h.events).toHaveLength(0);
    expect(
      peers
        .flatMap(peer => peer.sent)
        .some(frame => frame[0] === Tag.STORAGE_RECEIPT_REQUEST),
    ).toBe(false);
  },
);

it.each(['agent', 'database'])(
  'rejects a delayed receipt after %s switches away and back',
  async kind => {
    const h = await setup();
    h.control.hold = true;
    await h.resource.set(core.properties.name, 'Initial', false);
    await h.resource.save();
    h.connect(h.right);
    await vi.waitUntil(() => h.held.length > 0);

    if (kind === 'agent') {
      const agent = h.left.getAgent();
      h.left.setAgent(undefined);
      h.left.setAgent(agent);
    } else {
      const db = h.left.getClientDb();
      h.left.setClientDb(undefined);
      h.left.setClientDb(db);
    }

    peers[0].deliver(h.held[0]);
    await vi.waitUntil(() => h.dbs[0].closePeerSession.mock.calls.length > 0);
    expect(h.events).toHaveLength(0);
  },
);

it('rechecks outgoing subject authorization before disclosing a save frontier', async () => {
  const h = await setup();
  h.dbs[0].canSendPeerFrame.mockResolvedValue(false);
  await h.resource.set(core.properties.name, 'Initial', false);
  await h.resource.save();
  h.connect(h.right);
  await vi.waitUntil(() => h.dbs[0].canSendPeerFrame.mock.calls.length > 0);
  expect(
    peers[0].sent.some(frame => frame[0] === Tag.STORAGE_RECEIPT_REQUEST),
  ).toBe(false);
  expect(h.events).toHaveLength(0);
});

it('keeps a held old-version receipt pending after a newer edit and rejects it after silent removal', async () => {
  const h = await setup();
  h.control.hold = true;
  await h.resource.set(core.properties.name, 'Initial', false);
  await h.resource.save();
  h.connect(h.right);
  await vi.waitUntil(() => h.held.length > 0);
  await h.resource.set(core.properties.name, 'Newer', false);
  h.resource.sealPendingEdits();
  peers[0].deliver(h.held[0]);
  await vi.waitUntil(() => h.events.length === 1);
  expect(h.left.getResourcePeerSyncStatus(h.resource).state).toBe('pending');
  h.left.evictResource(h.resource.subject, false);
  h.left.resources.set(h.resource.subject, h.resource);
  peers[0].deliver(h.held[0]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(h.left.getResourcePeerSyncStatus(h.resource).state).toBe('unknown');
  expect(h.events).toHaveLength(1);
});

it('keeps older adapters connected and unconfirmed without storage identity or peerAgent output', async () => {
  const h = await setup(false, true, false);
  for (const db of h.dbs) Reflect.deleteProperty(db, 'getReplicaIdentity');
  await h.resource.set(core.properties.name, 'Legacy', false);
  await h.resource.save();
  h.connect(h.right);
  await vi.waitUntil(() => peers[0].sent.some(frame => frame[0] === Tag.SYNC));
  expect(h.left.getResourcePeerSyncStatus(h.resource)).toMatchObject({
    connectedCount: 1,
    confirmedCount: 0,
    state: 'unknown',
  });
  expect(h.events).toHaveLength(0);
});

it('probes an actual signed outgoing commit even when reconciliation inventory excludes the resource', async () => {
  const h = await setup();
  await h.resource.set(core.properties.name, 'Initial', false);
  await h.resource.save();
  vi.mocked(h.left.computeDriveSyncState).mockResolvedValue({
    drive: h.drive,
    driveHash: '',
    peers: [],
    resources: {},
  });
  h.connect(h.right);
  await vi.waitUntil(() => peers[0].sent.some(frame => frame[0] === Tag.SYNC));
  h.control.hold = true;
  await h.resource.set(core.properties.name, 'Sent edit', false);
  await h.resource.save();
  await vi.waitUntil(() => h.held.length > 0);
  const sent = peers[0].sent.find(frame => frame[0] === Tag.COMMIT)!;
  const commit = JSON.parse(decodeCommit(sent.subarray(1))!.commitJson);
  const sentVersion = encodeB64(
    LoroLoader.Loro.decodeImportBlobMeta(
      decodeB64(commit[commits.properties.loroUpdate]),
      true,
    ).partialEndVersionVector.encode(),
  );
  expect(parse(h.held[0]).version).toBe(sentVersion);
  await h.resource.set(core.properties.name, 'Newer unsent edit', false);
  peers[0].deliver(h.held[0]);
  await vi.waitUntil(() => h.events.length === 1);
  expect(h.events[0].version).toBe(sentVersion);
  expect(h.left.getResourcePeerSyncStatus(h.resource).state).toBe('pending');
});
