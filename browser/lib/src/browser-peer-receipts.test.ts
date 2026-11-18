import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  BrowserPeerSync,
  type BrowserReplicaReceipt,
} from './browser-peer-sync.js';
import {
  CAP_BROWSER_STORAGE_RECEIPTS,
  PEER_STORAGE_BARRIER,
  Tag,
} from './ws-v2.js';
import { testStore } from './test-store.js';
import { core } from './ontologies/core.js';
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

async function setup(capability = true, sourceAvailable = true) {
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
      supportsDurablePersistence: true,
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
            peerAgent: (index === 0 ? right : left).getAgent()!.subject!,
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
    vi.spyOn(store, 'computeDriveSyncState').mockResolvedValue({
      driveHash: 'hash',
      peers: [],
      resources: {},
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

it('automatically requests both exact saved versions across a delayed paired handshake', async () => {
  const h = await setup();
  const first = await h.resource.saveWithReceipt();
  await h.resource.set(core.properties.name, 'Second', false);
  const second = await h.resource.saveWithReceipt();
  expect(first.local!.version).not.toBe(second.local!.version);
  h.connect(h.right);
  await vi.waitUntil(() => h.events.length === 2);
  expect(h.events.map(event => event.observation.barrier!.version)).toEqual([
    first.local!.version,
    second.local!.version,
  ]);
  expect(h.events[0]).toMatchObject({
    source: h.identities[0],
    peerAgent: h.right.getAgent()!.subject,
    drive: h.drive,
    observation: { replica: h.identities[1] },
  });
  expect(Object.isFrozen(h.events[0])).toBe(true);
  expect(
    peers[0].sent.filter(frame => frame[0] === Tag.STORAGE_RECEIPT_REQUEST),
  ).toHaveLength(2);
});

it.each([
  [false, true],
  [true, false],
])(
  'keeps normal synchronization without receipts for capability=%s source=%s',
  async (capability, source) => {
    const h = await setup(capability, source);
    await h.resource.saveWithReceipt();
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
    await h.resource.saveWithReceipt();
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
  await h.resource.saveWithReceipt();
  h.connect(h.right);
  await vi.waitUntil(() => h.dbs[0].canSendPeerFrame.mock.calls.length > 0);
  expect(
    peers[0].sent.some(frame => frame[0] === Tag.STORAGE_RECEIPT_REQUEST),
  ).toBe(false);
  expect(h.events).toHaveLength(0);
});
