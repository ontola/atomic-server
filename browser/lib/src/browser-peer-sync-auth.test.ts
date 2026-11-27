import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { Agent } from './agent.js';
import { BrowserPeerSync } from './browser-peer-sync.js';
import { Tag } from './ws-v2.js';
import type { Store } from './store.js';

const AUTH_AGENT = 'https://atomicdata.dev/properties/auth/agent';
const BINDING = 'binding';
const CHALLENGE = `${BINDING}:${'c'.repeat(64)}`;

const sent = vi.hoisted(() => [] as Uint8Array[]);
const incoming = vi.hoisted(() => [] as Uint8Array[]);

vi.mock('./webrtc-peer.js', () => ({
  WebRtcPeer: class {
    close = vi.fn();
    // Deliver the remote's CHALLENGE before any queued test frames.
    transport = Promise.resolve({
      send: async (frame: Uint8Array) => void sent.push(frame),
      recv: (() => {
        let served = false;

        return async () => {
          if (served) return incoming.shift();
          served = true;

          return new Uint8Array([
            Tag.CHALLENGE,
            ...new TextEncoder().encode(CHALLENGE),
          ]);
        };
      })(),
    });
    async channelBinding() {
      return BINDING;
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
  message(value: object) {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(value) }),
    );
  }
}

let link: BrowserPeerSync | undefined;

beforeEach(() => {
  sent.length = 0;
  incoming.length = 0;
  SignalSocket.instances = [];
  vi.stubGlobal('WebSocket', SignalSocket);
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  link?.close();
  vi.unstubAllGlobals();
});

/**
 * The browser-peer session (Rust `BrowserPeerSession`) pins the invite issuer
 * and checks ephemeral frames by comparing the AUTH `agent` field with the
 * canonical `atomic:agent:` subject as a string. The `did:ad:agent:` spelling
 * that goes to servers (ATOMIC-BROWSER-36) is therefore refused there with
 * "Unexpected peer identity", and no guest ever joins an unhosted drive.
 */
it('authenticates to a browser peer with the canonical agent subject', async () => {
  const agent = await Agent.generateNonExtractable();
  const db = {
    getResourceWithSnapshot: async () => ({ snapshot: undefined }),
    createPeerSession: async () => 1,
    closePeerSession: async () => {},
  };
  const store = {
    getAgent: () => agent,
    getClientDb: () => db,
    getIdentityGeneration: () => 0,
    getClientDbGeneration: () => 0,
    getPeerSyncGeneration: () => 0,
    on: () => () => {},
  } as unknown as Store;

  link = new BrowserPeerSync(store, {
    drive: 'atomic:drive',
    room: 'a'.repeat(64),
    signalingUrl: 'ws://localhost/webrtc-signal',
  });
  // A peer id that sorts before every other id makes this side the dialer.
  (link as unknown as { peerId: string }).peerId = '0'.repeat(64);
  SignalSocket.instances[0].message({
    type: 'joined',
    peers: ['f'.repeat(64)],
  });
  await vi.waitUntil(() => sent.some(frame => frame[0] === Tag.AUTH));

  expect(agent.subject).toMatch(/^atomic:agent:/);
  const frame = sent.find(candidate => candidate[0] === Tag.AUTH)!;
  const auth = JSON.parse(new TextDecoder().decode(frame.subarray(1)));
  expect(auth[AUTH_AGENT]).toBe(agent.subject);
});

async function receivedFile(
  handling: Promise<{ frames: number[][]; changed: string[] }>,
) {
  const agent = await Agent.generateNonExtractable();
  const db = {
    getResourceWithSnapshot: async () => ({ snapshot: undefined }),
    createPeerSession: async () => 1,
    closePeerSession: async () => {},
    handlePeerFrame: vi.fn(() => handling),
  };
  let currentDb: object = db;
  const retry = vi.fn();
  const store = {
    getAgent: () => agent,
    getClientDb: () => currentDb,
    getIdentityGeneration: () => 0,
    getClientDbGeneration: () => 0,
    getPeerSyncGeneration: () => 0,
    on: () => () => {},
    retryFileContentRecovery: retry,
  } as unknown as Store;
  incoming.push(new Uint8Array([Tag.BLOB_RESPONSE]));
  link = new BrowserPeerSync(store, {
    drive: 'atomic:drive',
    room: 'a'.repeat(64),
    signalingUrl: 'ws://localhost/webrtc-signal',
  });
  (link as unknown as { peerId: string }).peerId = '0'.repeat(64);
  SignalSocket.instances[0].message({
    type: 'joined',
    peers: ['f'.repeat(64)],
  });
  await vi.waitFor(() => expect(db.handlePeerFrame).toHaveBeenCalledOnce());

  return {
    retry,
    replaceDb: () => {
      currentDb = {};
    },
  };
}

it('refreshes file readers only after the peer database validates and stores a late response', async () => {
  const processed = Promise.withResolvers<{
    frames: number[][];
    changed: string[];
  }>();
  const f = await receivedFile(processed.promise);
  expect(f.retry).not.toHaveBeenCalled();
  processed.resolve({ frames: [], changed: [] });
  await vi.waitFor(() => expect(f.retry).toHaveBeenCalledOnce());
});

it('does not refresh file readers when the peer database rejects a response', async () => {
  const processed = Promise.withResolvers<{
    frames: number[][];
    changed: string[];
  }>();
  const f = await receivedFile(processed.promise);
  processed.reject(new Error('Blob hash mismatch'));
  await Promise.resolve();
  await Promise.resolve();
  expect(f.retry).not.toHaveBeenCalled();
});

it('does not refresh file readers for a previous peer database', async () => {
  const processed = Promise.withResolvers<{
    frames: number[][];
    changed: string[];
  }>();
  const f = await receivedFile(processed.promise);
  f.replaceDb();
  processed.resolve({ frames: [], changed: [] });
  await processed.promise;
  await Promise.resolve();
  expect(f.retry).not.toHaveBeenCalled();
});
