import { enableLoro } from './loro-loader.js';

// Loro is the default CRDT engine — initialize it before all tests.
await enableLoro();

// Mock localStorage for Node.js test environment. Defined directly, not with
// `vi.stubGlobal`: a test that calls `vi.unstubAllGlobals()` (to undo its own
// fetch stub) would otherwise remove this mock too, and every Store made after
// it would open a real WebSocket whose failure logs after the file has ended.
if (
  typeof localStorage === 'undefined' ||
  typeof localStorage.getItem !== 'function'
) {
  const storage = new Map<string, string>();

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      get length() {
        return storage.size;
      },
      key: (i: number) => [...storage.keys()][i] ?? null,
      clear: () => storage.clear(),
    },
  });
}

// Suppress WebSocket auto-connect in unit tests. The Store opens a WS to
// `serverUrl` on construction; in Node tests against `https://example.com`
// the connect fails ~immediately and the WSClient calls
// `setServerConnected(false)`, overwriting any explicit
// `store.setServerConnected(true)` in test setup. Save flows then take the
// offline path and never call `postCommit`, leaving spies empty (looked
// like the genesis-commit logic was broken; it wasn't — the test just
// raced the WS disconnect). The flag is read in `Store.setServerUrl` ->
// `openWebSocket` and short-circuits creation entirely.
localStorage.setItem('ws-disconnected', '1');
