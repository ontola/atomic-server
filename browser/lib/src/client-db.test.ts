import { describe, it, expect } from 'vitest';

import { ClientDbWorker } from './client-db.js';

describe('ClientDbWorker without a secure context', () => {
  it('parks in server-only mode with a clear error when Web Locks are unavailable', async () => {
    // Simulate an insecure context (plain HTTP on a non-localhost origin, e.g.
    // `http://homeassistant.local:9883`): the browser withholds
    // `navigator.locks`. Node's default test env already lacks it; make the
    // precondition explicit and robust to future Node versions that might add
    // it.
    if (
      typeof navigator !== 'undefined' &&
      (navigator as Navigator & { locks?: unknown }).locks
    ) {
      Object.defineProperty(navigator, 'locks', {
        value: undefined,
        configurable: true,
      });
    }

    const db = new ClientDbWorker('wasm-url', 'worker-url');

    // Must NOT throw an opaque TypeError — it resolves cleanly into a degraded,
    // server-only mode, recording the reason on `initError`.
    await expect(
      db.init('http://homeassistant.local:9883'),
    ).resolves.toBeUndefined();
    expect(db.initError).toBeInstanceOf(Error);
    expect(db.initError?.message).toMatch(/insecure connection/i);
  });
});
