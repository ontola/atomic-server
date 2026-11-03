// @wc-ignore-file
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Agent, JSCryptoProvider, StoreEvents, type Store } from '@tomic/react';
import { handOverAppKey } from './appAgent';
import {
  retryPendingAppKeys,
  startAppKeyRecovery,
  subscribeAppKeyHandover,
} from './appKeyHandover';

const disk = vi.hoisted(() => new Map<string, unknown>());
const dbKey = new Uint8Array(32).fill(17);
const localKey = vi.hoisted(() => ({ available: true }));
vi.mock('idb-keyval', () => ({
  get: async (key: string) => disk.get(key),
  set: async (key: string, value: unknown) => {
    disk.set(key, value);
  },
  del: async (key: string) => {
    disk.delete(key);
  },
  entries: async () => [...disk.entries()],
}));
vi.mock('../../helpers/localDbKey', () => ({
  getOrCreateSessionDbKey: async () => dbKey,
  getSessionDbKey: async () => (localKey.available ? dbKey : undefined),
}));

const secret = Agent.buildSecret(
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'atomic:agent:O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik',
);
const options = { drive: 'atomic:drive', app: 'atomic:app', secret };

function fakeStore() {
  const agent = new Agent(
    new JSCryptoProvider('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    'atomic:agent:O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik',
  );

  const events = new Map<string, Set<() => void>>();
  const state = {
    agent: agent as Agent | undefined,
    server: 'http://node.test',
    connected: true,
    pending: 0,
  };
  const store = {
    getAgent: () => state.agent,
    getServerUrl: () => state.server,
    getSyncStatus: () => ({
      serverConnected: state.connected,
      syncInProgress: false,
      pendingDirtyCount: state.pending,
    }),
    on: (event: string, callback: () => void) => {
      let callbacks = events.get(event);
      if (!callbacks) events.set(event, (callbacks = new Set()));
      callbacks.add(callback);

      return () => callbacks.delete(callback);
    },
  } as unknown as Store;

  return {
    store,
    state,
    emit: (event: string) => events.get(event)?.forEach(callback => callback()),
  };
}

beforeEach(() => {
  disk.clear();
  localKey.available = true;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function responding(state = 'missing', agent?: string, status = 200) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) =>
    init.method === 'POST'
      ? new Response('{}', { status })
      : Response.json({ handover: 'initialize-only-v1', state, agent }),
  );
  vi.stubGlobal('fetch', fetch);

  return fetch;
}

async function offlineInstall() {
  const fixture = fakeStore();
  fixture.state.connected = false;
  await handOverAppKey(fixture.store, options);
  fixture.state.connected = true;

  return fixture;
}

it('keeps an encrypted handover when the node is unavailable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }),
  );
  await expect(
    handOverAppKey(fakeStore().store, {
      drive: 'atomic:drive',
      app: 'atomic:app',
      secret: 'app-secret-sentinel',
    }),
  ).rejects.toThrow();

  expect(disk.size).toBe(1);
  expect(JSON.stringify([...disk.values()])).not.toContain(
    'app-secret-sentinel',
  );
});

it('retries the same encrypted key after a page reload, then removes it', async () => {
  await offlineInstall();
  const fetch = responding();
  const storeAfterReload = fakeStore().store;
  expect(await retryPendingAppKeys(storeAfterReload)).toBe(false);
  const post = fetch.mock.calls.find(([, init]) => init.method === 'POST');
  expect(JSON.parse(post![1].body as string)).toEqual({
    ...options,
    initializeOnly: true,
  });
  expect(post![0]).toBe('http://node.test/app-agent');
  expect(post![1].redirect).toBe('error');
  expect(disk.size).toBe(0);
});

it('does not send while resources are still queued', async () => {
  const { store, state } = await offlineInstall();
  const fetch = responding();
  state.pending = 2;
  await retryPendingAppKeys(store);
  expect(fetch).not.toHaveBeenCalled();
  state.pending = 0;
  await retryPendingAppKeys(store);
  expect(disk.size).toBe(0);
});

it('keeps server handovers queued when the store switches to a device-only host', async () => {
  const { store } = await offlineInstall();
  Object.defineProperty(store, 'noServer', { value: true });
  vi.spyOn(store, 'getServerUrl').mockImplementation(() => {
    throw new Error('device-only host');
  });
  const fetch = responding();
  await retryPendingAppKeys(store);
  expect(fetch).not.toHaveBeenCalled();
  expect(disk.size).toBe(1);
});

it.each(['node', 'account', 'signed out', 'locked'])(
  'keeps the encrypted record when the %s changes',
  async change => {
    const { store, state } = await offlineInstall();
    const fetch = responding();
    if (change === 'node') state.server = 'http://other.test';
    if (change === 'account')
      state.agent = new Agent(
        new JSCryptoProvider('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        'atomic:agent:other',
      );
    if (change === 'signed out') state.agent = undefined;
    if (change === 'locked') localKey.available = false;
    await retryPendingAppKeys(store);
    expect(fetch).not.toHaveBeenCalled();
    expect(disk.size).toBe(1);
  },
);

it('authenticates the queue metadata before sending a secret', async () => {
  const { store } = await offlineInstall();
  const record = [...disk.values()][0] as { app: string };
  record.app = 'atomic:attacker';
  const fetch = responding();
  await retryPendingAppKeys(store);
  expect(fetch).not.toHaveBeenCalled();
});

it('does not replay keys to older nodes that cannot enforce initialization-only', async () => {
  const { store } = await offlineInstall();
  const fetch = vi.fn(async () => Response.json(null));
  vi.stubGlobal('fetch', fetch);
  expect(await retryPendingAppKeys(store)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(disk.size).toBe(1);
});

it('preserves a normal online installation against an older node', async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) =>
    init.method === 'POST'
      ? Response.json({ agent: 'atomic:agent:app' })
      : Response.json(null),
  );
  vi.stubGlobal('fetch', fetch);
  await handOverAppKey(fakeStore().store, options);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(disk.size).toBe(0);
});

it.each(['revoked', 'active'])(
  'cancels a stale handover after the identity is %s',
  async state => {
    const { store } = await offlineInstall();
    const fetch = responding(state, 'atomic:agent:replacement');
    await retryPendingAppKeys(store);
    expect(fetch.mock.calls.every(([, init]) => init.method !== 'POST')).toBe(
      true,
    );
    expect(disk.size).toBe(0);
  },
);

it('cancels when revocation wins the race after the probe', async () => {
  const { store } = await offlineInstall();
  responding('missing', undefined, 409);
  await retryPendingAppKeys(store);
  expect(disk.size).toBe(0);
});

it('retains failed requests and retries without generating another identity', async () => {
  const { store } = await offlineInstall();
  const fetch = responding('missing', undefined, 503);
  expect(await retryPendingAppKeys(store)).toBe(true);
  expect(disk.size).toBe(1);
  responding('active', (await Agent.fromSecret(secret)).subject);
  await retryPendingAppKeys(store);
  expect(disk.size).toBe(0);
  expect(JSON.parse(fetch.mock.calls[1][1].body as string).secret).toBe(secret);
});

it('checks the selected node again after the capability probe', async () => {
  const { store, state } = await offlineInstall();
  const fetch = vi.fn(async () => {
    state.server = 'http://other.test';

    return Response.json({ handover: 'initialize-only-v1', state: 'missing' });
  });
  vi.stubGlobal('fetch', fetch);
  await retryPendingAppKeys(store);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(disk.size).toBe(1);
});

it('retries on reconnect after sync and signals only the recovered app', async () => {
  const { store, state, emit } = await offlineInstall();
  const fetch = responding();
  state.connected = false;
  vi.useFakeTimers();
  const changed = vi.fn();
  const unsubscribe = subscribeAppKeyHandover(store, changed);
  const stop = startAppKeyRecovery(store);
  await vi.runOnlyPendingTimersAsync();
  expect(fetch).not.toHaveBeenCalled();
  state.connected = true;
  state.pending = 1;
  emit(StoreEvents.ConnectionChanged);
  await vi.runOnlyPendingTimersAsync();
  expect(fetch).not.toHaveBeenCalled();
  state.pending = 0;
  emit(StoreEvents.SyncStatusChanged);
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(changed.mock.calls[0][0]).toMatchObject({
    drive: options.drive,
    app: options.app,
  });
  unsubscribe();
  stop();
});
