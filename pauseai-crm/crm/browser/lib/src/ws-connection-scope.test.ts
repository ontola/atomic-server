import { describe, it, vi, afterEach } from 'vitest';
import { testStore } from './test-store.js';
import { WSClient } from './websockets.js';

/**
 * A client holds one socket per origin it talks to. Adopting a previous
 * account's drives adds origins the app does not depend on — often old servers
 * that cannot speak this protocol at all. Their sockets fail and retry forever,
 * and each failure used to mark the whole store disconnected: the app reported
 * "Working offline" and queued writes while its own server answered in under a
 * millisecond. On desktop those queued writes do not survive a restart.
 */
class FakeWebSocket {
  public static readonly OPEN = 1;
  public url: string;
  public protocol = 'atomicdata-ws.v2';
  public binaryType = 'arraybuffer';
  public readyState = 0;
  readonly #listeners = new Map<string, Set<(e: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  public addEventListener(type: string, cb: (e: unknown) => void): void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(cb);
    this.#listeners.set(type, set);
  }

  public removeEventListener(type: string, cb: (e: unknown) => void): void {
    this.#listeners.get(type)?.delete(cb);
  }

  public send(): void {}
  public close(): void {}

  public fire(type: string, event: unknown): void {
    for (const cb of this.#listeners.get(type) ?? []) cb(event);
  }
}

const CLOSE_1006 = { code: 1006, reason: '', wasClean: false };

const socketOf = (client: WSClient): FakeWebSocket =>
  (client as unknown as { ws: FakeWebSocket }).ws;

describe('a socket only reports connection state for its own server', () => {
  const original = globalThis.WebSocket;

  afterEach(() => {
    globalThis.WebSocket = original;
    vi.useRealTimers();
  });

  it('a foreign origin closing does not take the app offline', async ({
    expect,
  }) => {
    vi.useFakeTimers();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const { store } = await testStore(); // serverUrl: https://example.com
    const foreign = new WSClient('wss://atomicdata.dev/ws', store);

    store.setServerConnected(true);
    socketOf(foreign).fire('close', CLOSE_1006);

    expect(
      (store as unknown as { _serverConnected: boolean })._serverConnected,
    ).toBe(true);

    foreign.close();
  });

  it("the app's own server closing does take it offline", async ({
    expect,
  }) => {
    vi.useFakeTimers();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const { store } = await testStore();
    const own = new WSClient('wss://example.com/ws', store);

    store.setServerConnected(true);
    socketOf(own).fire('close', CLOSE_1006);

    expect(
      (store as unknown as { _serverConnected: boolean })._serverConnected,
    ).toBe(false);

    own.close();
  });
});
