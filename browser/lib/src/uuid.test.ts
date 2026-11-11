import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRandomUUIDPolyfill, randomUUID, Store } from './index.js';

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Over plain http on a non-localhost origin the browser has no randomUUID. */
function withoutRandomUUID() {
  vi.stubGlobal('crypto', {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
  });
}

describe('crypto.randomUUID in an insecure context', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('randomUUID() returns unique v4 ids without crypto.randomUUID', () => {
    withoutRandomUUID();
    const ids = new Set(Array.from({ length: 50 }, () => randomUUID()));

    expect(ids.size).toBe(50);
    ids.forEach(id => expect(id).toMatch(V4));
  });

  it('the polyfill makes crypto.randomUUID() work', () => {
    withoutRandomUUID();
    expect(() => crypto.randomUUID()).toThrow();

    installRandomUUIDPolyfill();

    expect(crypto.randomUUID()).toMatch(V4);
  });

  it('creating a Store does not crash without crypto.randomUUID', () => {
    withoutRandomUUID();

    const store = new Store();

    expect(store.presenceSessionId).toMatch(V4);
  });
});
