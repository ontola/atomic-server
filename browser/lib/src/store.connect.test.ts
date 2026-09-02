import { describe, it, afterEach, beforeEach } from 'vitest';
import { Store } from './store.js';

/**
 * The managed deployment serves the app from an origin that runs no
 * atomic-server. The store still needs that origin as `serverUrl`, but a
 * socket to it can only fail — so `connect: false` keeps it closed, and a
 * later switch to a real node connects as usual.
 */
class FakeWebSocket {
  public static readonly OPEN = 1;
  public static opened: string[] = [];
  public url: string;
  public protocol = 'atomicdata-ws.v2';
  public binaryType = 'arraybuffer';
  public readyState = 0;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.opened.push(url);
  }

  public addEventListener(): void {}
  public removeEventListener(): void {}
  public send(): void {}
  public close(): void {}
}

const STATIC_HOST = 'https://app.example';
const NODE = 'https://node1.example';

describe('Store connect option', () => {
  const original = globalThis.WebSocket;

  beforeEach(() => {
    // `test-setup.ts` disconnects every store's socket by default; this file
    // is about exactly that decision, so it needs the real one back.
    localStorage.removeItem('ws-disconnected');
  });

  afterEach(() => {
    localStorage.setItem('ws-disconnected', '1');
    globalThis.WebSocket = original;
    FakeWebSocket.opened = [];
  });

  it('opens a socket to serverUrl by default', ({ expect }) => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const store = new Store({ serverUrl: NODE });

    expect(FakeWebSocket.opened).toEqual([`wss://node1.example/ws`]);
    expect(store.getDefaultWebSocket()).toBeDefined();
  });

  it('connect: false keeps the URL but opens nothing', ({ expect }) => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const store = new Store({ serverUrl: STATIC_HOST, connect: false });

    expect(store.getServerUrl()).toBe(STATIC_HOST);
    expect(FakeWebSocket.opened).toEqual([]);
    expect(store.getDefaultWebSocket()).toBeUndefined();
    expect(store.getSyncStatus().serverConnected).toBe(false);
  });

  it('setting the drive to that same origin still opens nothing', ({
    expect,
  }) => {
    // The drive defaults to the server URL, and `setDrive(origin)` goes
    // through `setServerUrl` again — which is how the hosted build ended up
    // with a socket after all.
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const store = new Store({ serverUrl: STATIC_HOST, connect: false });
    store.setDrive(STATIC_HOST);
    store.setServerUrl(STATIC_HOST);

    expect(FakeWebSocket.opened).toEqual([]);
    expect(store.getDefaultWebSocket()).toBeUndefined();
  });

  it('switching to a real node afterwards connects as usual', ({ expect }) => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const store = new Store({ serverUrl: STATIC_HOST, connect: false });
    store.setServerUrl(NODE);

    expect(store.getServerUrl()).toBe(NODE);
    expect(FakeWebSocket.opened).toEqual([`wss://node1.example/ws`]);
  });
});
