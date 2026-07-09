import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Agent } from '@tomic/react';

/** In-memory stand-in for IndexedDB, so we can inspect exactly what got stored. */
const store = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => void store.set(key, value),
  del: async (key: string) => void store.delete(key),
}));

const { getAgentFromIDB, saveAgentToIDB } = await import('./agentStorage');

const AGENT_IDB_KEY = 'atomic.agent';
const AGENT_FALLBACK_KEY = 'atomic.agent.fallback';

async function makeSecret(): Promise<string> {
  const keys = await Agent.generateKeyPair();

  return Agent.buildSecret(keys.privateKey, 'http://localhost/agents/test');
}

/** Simulates an insecure context (plain-HTTP origin), where Web Crypto is absent. */
function withoutSubtleCrypto(run: () => Promise<void>): Promise<void> {
  const real = globalThis.crypto.subtle;
  Object.defineProperty(globalThis.crypto, 'subtle', {
    value: undefined,
    configurable: true,
  });

  return run().finally(() => {
    Object.defineProperty(globalThis.crypto, 'subtle', {
      value: real,
      configurable: true,
    });
  });
}

describe('agent key storage', () => {
  beforeEach(() => store.clear());
  afterEach(() => store.clear());

  it('never stores a readable private key where Web Crypto is available', async () => {
    await saveAgentToIDB(await makeSecret());

    expect(store.has(AGENT_IDB_KEY)).toBe(true);
    // The whole point of the non-extractable keypair: a readable copy beside it
    // would hand back exactly what non-extractability withholds.
    expect(store.has(AGENT_FALLBACK_KEY)).toBe(false);
  });

  it('discards a readable key left behind by an earlier version', async () => {
    const secret = await makeSecret();
    await saveAgentToIDB(secret);
    // An install from before the fix: plaintext sitting next to the keypair.
    store.set(AGENT_FALLBACK_KEY, {
      privateKey: 'leaked',
      subject: 'http://localhost/agents/test',
    });

    const agent = await getAgentFromIDB();

    expect(agent).toBeDefined();
    expect(store.has(AGENT_FALLBACK_KEY)).toBe(false);
  });

  it('falls back to a readable key only in an insecure context', async () => {
    const secret = await makeSecret();

    await withoutSubtleCrypto(async () => {
      await saveAgentToIDB(secret);

      expect(store.has(AGENT_FALLBACK_KEY)).toBe(true);
      expect(store.has(AGENT_IDB_KEY)).toBe(false);

      // ...and it stays usable — dropping it would lock the user out.
      const agent = await getAgentFromIDB();
      expect(agent).toBeDefined();
      expect(store.has(AGENT_FALLBACK_KEY)).toBe(true);
    });
  });

  it('signs out by removing both key records', async () => {
    await saveAgentToIDB(await makeSecret());
    store.set(AGENT_FALLBACK_KEY, { privateKey: 'x', subject: 'y' });

    await saveAgentToIDB(undefined);

    expect(store.size).toBe(0);
  });
});
