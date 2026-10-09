import { describe, expect, it, vi } from 'vitest';
import { Agent } from './agent.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { Store } from './store.js';
import type { Commit } from './commit.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { withDurableParam } from './client.js';

async function newAgent(): Promise<Agent> {
  const keys = await Agent.generateKeyPair();

  return new Agent(
    new JSCryptoProvider(keys.privateKey),
    `did:ad:agent:${keys.publicKey}`,
  );
}

/** A signed-in store whose HTTP commits go to a spy that records the options. */
async function tab(opts: { defaultDurable?: boolean } = {}) {
  const store = new Store({ serverUrl: 'https://example.com', ...opts });
  store.setServerConnected(true);
  store.setAgent(await newAgent());
  const spy = vi.fn(async (commit: Commit, _endpoint: string, _o?: unknown) => {
    return {
      ...commit,
      id: `https://example.com/commits/${commit.signature}`,
    } as Commit;
  });
  (
    store as unknown as { client: { postCommit: typeof spy } }
  ).client.postCommit = spy;
  vi.spyOn(store, 'getProperty').mockRejectedValue(
    new Error('property validation skipped'),
  );
  store.injectFetch(async () => {
    throw new Error('network disabled');
  });

  return { store, spy };
}

const durableOf = (spy: ReturnType<typeof vi.fn>, call: number) =>
  (spy.mock.calls[call][2] as { durable?: boolean } | undefined)?.durable;

async function newDoc(store: Store) {
  return store.newResource({
    isA: server.classes.drive,
    noParent: true,
    propVals: { [core.properties.name]: 'Doc' },
  });
}

describe('durable commits', () => {
  it('a plain save is not durable', async () => {
    const { store, spy } = await tab();
    const doc = await newDoc(store);
    await expect(doc.save()).resolves.toBe('persisted');
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.every((_c, i) => durableOf(spy, i) === false)).toBe(
      true,
    );
  });

  it('save({ durable: true }) asks the server for a durable commit', async () => {
    const { store, spy } = await tab();
    const doc = await newDoc(store);
    await expect(doc.save({ durable: true })).resolves.toBe('persisted');
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(spy.mock.calls.every((_c, i) => durableOf(spy, i) === true)).toBe(
      true,
    );

    // The request belongs to that save: the next plain one is not durable.
    spy.mockClear();
    await doc.set(core.properties.name, 'Second');
    await doc.save();
    expect(spy).toHaveBeenCalled();
    expect(durableOf(spy, 0)).toBe(false);
    expect(store.outbox.size).toBe(0);
  });

  it('the store default applies to every save, and can be switched off', async () => {
    const { store, spy } = await tab({ defaultDurable: true });
    expect(store.defaultDurable).toBe(true);
    const doc = await newDoc(store);
    await doc.save();
    expect(spy.mock.calls.every((_c, i) => durableOf(spy, i) === true)).toBe(
      true,
    );

    store.setDefaultDurable(false);
    spy.mockClear();
    await doc.set(core.properties.name, 'Later');
    await doc.save();
    expect(durableOf(spy, 0)).toBe(false);
  });

  it('a failed durable commit stays queued and is retried as durable', async () => {
    const { store, spy } = await tab();
    const doc = await newDoc(store);
    await doc.save();
    spy.mockClear();

    spy.mockRejectedValueOnce(new Error('network down'));
    await doc.set(core.properties.name, 'Edited');
    await doc.save({ durable: true }).catch(() => undefined);
    const queued = store.outbox.getEntry(doc.subject);
    expect(queued?.durable).toBe(true);
    expect(durableOf(spy, 0)).toBe(true);

    // Skip the retry backoff.
    queued!.failures = 0;
    queued!.lastAttemptAt = undefined;
    await store.syncDirtyResources();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(durableOf(spy, 1)).toBe(true);
    expect(store.outbox.hasPending(doc.subject)).toBe(false);
  });
});

describe('withDurableParam', () => {
  it('adds durable=true and keeps the rest of the URL', () => {
    expect(withDurableParam('https://example.com/commit')).toBe(
      'https://example.com/commit?durable=true',
    );
    expect(withDurableParam('https://example.com/commit?a=1')).toBe(
      'https://example.com/commit?a=1&durable=true',
    );
  });
});
