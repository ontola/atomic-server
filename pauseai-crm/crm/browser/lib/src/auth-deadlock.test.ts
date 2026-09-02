import { beforeAll, describe, it } from 'vitest';
import { Store } from './store.js';
import { Agent } from './agent.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { LoroLoader } from './loro-loader.js';
import { WSClient } from './websockets.js';

/**
 * The desktop app boots its webview before its embedded server binds, so the
 * first websocket connect fails. It then sat on "Offline" indefinitely next to
 * a server answering in ~1ms, with every fetch hanging and only a reload
 * clearing it.
 *
 * The retry loop was never the problem — it fires with correct backoff, and a
 * socket killed after opening reconnects fine. What broke was narrower:
 * `openPromise` only ever resolved. A socket that died before opening left it
 * pending forever, and `authenticate()` awaits it while holding
 * `isAuthenticating`, whose `finally` sits downstream of that await. The flag
 * stayed set for the life of the client, so when the retry's socket opened, its
 * `authenticate()` waited on the dead promise instead.
 */

class FakeSocket {
  public static last: FakeSocket | undefined;
  public readyState = 0;
  public protocol = '';
  public binaryType = 'arraybuffer';
  private listeners = new Map<string, Array<(e: unknown) => void>>();

  constructor(public url: string) {
    FakeSocket.last = this;
  }

  public addEventListener(type: string, cb: (e: unknown) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }

  public removeEventListener() {
    /* no-op */
  }

  public send() {
    /* no-op */
  }

  public close() {
    this.emit('close', { code: 1000, reason: '', wasClean: true });
  }

  public emit(type: string, ev: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }

  /** What a connect to a port nothing is listening on looks like. */
  public failBeforeOpening() {
    this.readyState = 3;
    this.emit('error', {});
    this.emit('close', { code: 1006, reason: '', wasClean: false });
  }
}

beforeAll(async () => {
  await LoroLoader.initializeLoro();
});

async function makeAgent(): Promise<Agent> {
  const keys = await Agent.generateKeyPair();

  return new Agent(
    new JSCryptoProvider(keys.privateKey),
    `did:ad:agent:${keys.publicKey}`,
  );
}

describe('a connect that never opens must not pin the auth flag', () => {
  it('rejects the open promise instead of leaving it pending', async ({
    expect,
  }) => {
    const realWS = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket =
      FakeSocket as unknown as typeof WebSocket;

    try {
      const store = new Store({ serverUrl: 'https://example.com' });
      store.setAgent(await makeAgent());
      const client = new WSClient('wss://example.com/ws', store);
      const socket = FakeSocket.last!;

      // Whoever is first to need the connection — a boot fetch, the presence
      // manager — starts awaiting it here.
      const waiting = (
        client as unknown as { openPromise: Promise<void> }
      ).openPromise.then(
        () => 'resolved',
        () => 'rejected',
      );

      socket.failBeforeOpening();

      // Pending forever is the bug. Either outcome that SETTLES is fine —
      // settling is what lets `authenticate`'s `finally` run.
      const outcome = await Promise.race([
        waiting,
        new Promise(r => setTimeout(() => r('still-pending'), 250)),
      ]);

      expect(outcome).toBe('rejected');
      client.close();
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = realWS;
    }
  });

  it('lets a later authenticate run after a failed first connect', async ({
    expect,
  }) => {
    const realWS = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket =
      FakeSocket as unknown as typeof WebSocket;

    try {
      const store = new Store({ serverUrl: 'https://example.com' });
      store.setAgent(await makeAgent());
      const client = new WSClient('wss://example.com/ws', store);

      // An auth attempt that starts while the first socket is still
      // connecting. It holds `isAuthenticating` until it settles.
      const first = client.authenticate().catch(() => undefined);
      FakeSocket.last!.failBeforeOpening();
      await first;

      // The flag must be clear, or the reconnect's authenticate never runs.
      const stuck = (client as unknown as { isAuthenticating: boolean })
        .isAuthenticating;

      expect(stuck).toBe(false);
      client.close();
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = realWS;
    }
  });
});
