// @vitest-environment jsdom
// @wc-ignore-file
import {
  act,
  cleanup,
  renderHook,
  waitFor,
  configure,
} from '@testing-library/react';
import { StoreContext, type Store as PackageStore } from '@tomic/react';
import { Resource } from '../../../../lib/src/resource';
import { testStore } from '../../../../lib/src/test-store';
import { afterEach, expect, it, vi } from 'vitest';
import { getSyncLabel, useSyncStatus } from './syncStatus';

vi.mock('@tomic/lib', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/lib')>()),
  signRequest: vi.fn(async () => ({ authorization: 'signed' })),
}));
configure({ asyncUtilTimeout: 2500 });
const DRIVE = 'atomic:resource:drive';
const HASH = 'a'.repeat(64);
const ok = (confirmed: boolean, patch: Record<string, unknown> = {}) => ({
  ok: true,
  json: async () => ({
    version: 1,
    drive: DRIVE,
    hashVersion: 2,
    driveHash: HASH,
    checkedBlobs: 1,
    confirmed,
    ...patch,
  }),
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function setup(fetchImpl: ReturnType<typeof vi.fn>) {
  const { store } = await testStore({ connect: false });
  vi.stubGlobal('fetch', fetchImpl);
  const db = {
    isReady: true,
    flush: vi.fn().mockResolvedValue(undefined),
    getVersionVectorsForDrive: vi.fn(),
  };
  vi.spyOn(store, 'getClientDb').mockReturnValue(db as never);
  vi.spyOn(store, 'computeDriveSyncState').mockResolvedValue({
    drive: DRIVE,
    driveHash: HASH,
    peers: [],
    resources: {},
    vvs: {},
    hashVersion: 2,
  });
  store.setDrive(DRIVE);
  store.finishDriveSync(DRIVE, 1, 10);
  const hook = renderHook(() => useSyncStatus(), {
    wrapper: ({ children }) => (
      <StoreContext.Provider value={store as unknown as PackageStore}>
        {children}
      </StoreContext.Provider>
    ),
  });

  return { store, hook, db };
}

it('requires exact signed confirmation even after metadata sync', async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(ok(false))
    .mockResolvedValue(ok(true));
  const { hook, db } = await setup(fetchImpl);
  await waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
  expect(getSyncLabel(hook.result.current)).toBe('Sync not confirmed');
  await waitFor(
    () => expect(getSyncLabel(hook.result.current)).toBe('Synced with server'),
    { timeout: 8000 },
  );
  expect(db.flush).toHaveBeenCalled();
  const [url, opts] = fetchImpl.mock.calls[0];
  expect(new URL(url).pathname).toBe('/drive-sync-confirmation');
  expect(new URL(url).searchParams.get('subject')).toBe(DRIVE);
  expect(new URL(url).searchParams.get('hash')).toBe(HASH);
  expect(opts).toMatchObject({
    cache: 'no-store',
    redirect: 'error',
    headers: { authorization: 'signed' },
  });
}, 12000);

it('ignores a delayed successful response after a local edit', async () => {
  let respond!: (value: unknown) => void;
  const fetchImpl = vi.fn(
    () =>
      new Promise(resolve => {
        respond = resolve;
      }),
  );
  const { store, hook } = await setup(fetchImpl);
  const resource = new Resource(DRIVE);
  act(() => store.addResource(resource));
  await waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
  act(() => resource.markDirty());
  await act(async () => {
    respond(ok(true));
    await Promise.resolve();
  });
  expect(getSyncLabel(hook.result.current)).toBe('Changes not yet synced');
});

it('rejects stale replies after switching drives and server', async () => {
  let respond!: (value: unknown) => void;
  const fetchImpl = vi.fn(
    () =>
      new Promise(resolve => {
        respond = resolve;
      }),
  );
  const { store, hook } = await setup(fetchImpl);
  await waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
  act(() => {
    store.setDrive('atomic:resource:other');
    store.setServerUrl('https://other.example', { connect: false });
    store.setServerConnected(true);
  });
  await act(async () => {
    respond(ok(true));
    await Promise.resolve();
  });
  expect(getSyncLabel(hook.result.current)).toBe('Sync not confirmed');
});

it.each([
  { version: 2 },
  { drive: 'atomic:resource:other' },
  { hashVersion: 1 },
  { driveHash: 'b'.repeat(64) },
  { checkedBlobs: -1 },
  { checkedBlobs: 1.5 },
  { confirmed: 'true' },
])('fails closed for malformed or mismatched response %j', async patch => {
  const fetchImpl = vi.fn().mockResolvedValue(ok(true, patch));
  const { hook } = await setup(fetchImpl);
  await waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
  await act(async () => {
    await Promise.resolve();
  });
  expect(getSyncLabel(hook.result.current)).toBe('Sync not confirmed');
});

it('does not contact the saved server for a local-only drive', async () => {
  const fetchImpl = vi.fn();
  const { store, hook } = await setup(fetchImpl);
  act(() => store.registerLocalOnlyDrive(DRIVE));
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(getSyncLabel(hook.result.current)).toBe('Not syncing with a server');
});

it('invalidates an existing proof for a bulk import and rechecks it', async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(ok(true))
    .mockResolvedValue(ok(false));
  const { store, hook } = await setup(fetchImpl);
  await waitFor(() =>
    expect(getSyncLabel(hook.result.current)).toBe('Synced with server'),
  );
  act(() => store.notifyBulkApplied());
  expect(getSyncLabel(hook.result.current)).toBe('Sync not confirmed');
  await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2), {
    timeout: 8000,
  });
  expect(getSyncLabel(hook.result.current)).toBe('Sync not confirmed');
}, 12000);

it.each([
  { ok: false, json: async () => ({}) },
  {
    ok: true,
    json: async () => {
      throw new SyntaxError('HTML, not JSON');
    },
  },
])('fails closed for an old server or non-JSON response', async response => {
  const fetchImpl = vi.fn().mockResolvedValue(response);
  const { hook } = await setup(fetchImpl);
  await waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
  await act(async () => {
    await Promise.resolve();
  });
  expect(getSyncLabel(hook.result.current)).toBe('Sync not confirmed');
});

it('does not claim proof if the complete local inventory is unavailable', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(ok(true));
  const { store, hook, db } = await setup(fetchImpl);
  db.flush.mockRejectedValue(new Error('database unavailable'));
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(getSyncLabel(hook.result.current)).toBe('Sync not confirmed');
  expect(store.getSyncStatus().lastDriveSync).toBeDefined();
});

it('ignores a confirmation response after the agent changes', async () => {
  let respond!: (value: unknown) => void;
  const fetchImpl = vi.fn(
    () =>
      new Promise(resolve => {
        respond = resolve;
      }),
  );
  const { store, hook } = await setup(fetchImpl);
  await waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
  act(() => {
    store.setAgent(undefined);
    store.setDrive(DRIVE);
  });
  await act(async () => {
    respond(ok(true));
    await Promise.resolve();
  });
  expect(getSyncLabel(hook.result.current)).toBe('Sync not confirmed');
});

it('invalidates proof at the start of an incoming bulk pull', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(ok(true));
  const { store, hook } = await setup(fetchImpl);
  await waitFor(() =>
    expect(getSyncLabel(hook.result.current)).toBe('Synced with server'),
  );
  act(() => store.startDriveSyncPull());
  expect(getSyncLabel(hook.result.current)).toBe('Syncing...');
});

it('rejects a response if the local database fails while it is in flight', async () => {
  let respond!: (value: unknown) => void;
  const fetchImpl = vi.fn(
    () =>
      new Promise(resolve => {
        respond = resolve;
      }),
  );
  const { db, hook } = await setup(fetchImpl);
  await waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
  db.isReady = false;
  await act(async () => {
    respond(ok(true));
    await Promise.resolve();
  });
  expect(getSyncLabel(hook.result.current)).toBe('Sync not confirmed');
});
