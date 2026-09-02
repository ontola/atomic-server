import { enableLoro } from '../src/loro-loader.js';
import { vi } from 'vitest';

// Loro is the default CRDT engine — initialize it before all tests.
await enableLoro();

// Mock localStorage for Node.js test environment. Integration tests
// deliberately do NOT set the `ws-disconnected` flag that the unit-test
// setup uses — these tests spawn a real atomic-server and need the
// Store's WebSocket to actually open.
if (
  typeof localStorage === 'undefined' ||
  typeof localStorage.getItem !== 'function'
) {
  const storage = new Map<string, string>();

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
    clear: () => storage.clear(),
  });
}
