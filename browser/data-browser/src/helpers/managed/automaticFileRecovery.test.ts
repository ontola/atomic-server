// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreEvents, type Store } from '@tomic/lib';
import { startAutomaticFileRecovery } from './automaticFileRecovery';
import type { VaultCapableDb } from './vault';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const C = 'cc'.repeat(32);
const DRIVE = 'atomic:drive';
const disposers: (() => void)[] = [];

function fixture() {
  const state = {
    agent: { subject: 'atomic:agent:alice' },
    drive: DRIVE,
    refs: [A, B, C],
    local: new Set<string>(),
    email: 'alice@example.test' as string | null,
  };
  const db = {
    vaultExport: vi.fn(),
    vaultImport: vi.fn(),
    vaultCommitSegment: vi.fn(),
    vaultFileHashes: vi.fn(async () => state.refs),
    vaultBlobPresent: vi.fn(async (hash: string) => state.local.has(hash)),
    vaultBlobRestore: vi.fn(),
  } satisfies VaultCapableDb;
  let currentDb: VaultCapableDb = db;
  let handler: (hash: string, drive?: string) => Promise<boolean> = async () =>
    false;
  const listeners = new Map<string, Set<() => void>>();
  const store = {
    getAgent: () => state.agent,
    getDrive: () => state.drive,
    setFileContentRecovery: vi.fn((next: typeof handler) => {
      handler = next;

      return () => {
        handler = async () => false;
      };
    }),
    retryFileContentRecovery: vi.fn(),
    on: (event: string, callback: () => void) => {
      const registered = listeners.get(event) ?? new Set();
      registered.add(callback);
      listeners.set(event, registered);

      return () => {
        registered.delete(callback);
      };
    },
  } as unknown as Store;
  const deps = {
    db: () => currentDb,
    peers: vi.fn(
      async (
        _store: Store,
        _drive: string,
        _hashes: string[],
        _signal: AbortSignal,
      ) => {},
    ),
    account: vi.fn(async () => state.email),
    credentials: vi.fn(async () => ({
      drivePseudonym: 'private-pseudonym',
      driveKey: new Uint8Array(32).fill(7),
      keyEpoch: 2,
    })),
    repair: vi.fn(
      async (args: {
        hashes?: string[];
        signal?: AbortSignal;
        throwIfStale?: () => void | Promise<void>;
      }) => {
        for (const hash of args.hashes ?? []) state.local.add(hash);

        return {
          total: args.hashes?.length ?? 0,
          repaired: args.hashes?.length ?? 0,
          missing: [],
          unreadable: 0,
        };
      },
    ),
  };
  const dispose = startAutomaticFileRecovery(store, deps);
  disposers.push(dispose);

  return {
    state,
    db,
    store,
    deps,
    dispose,
    recover: (hash: string, drive?: string) => handler(hash, drive),
    emit: (event: string) =>
      listeners.get(event)?.forEach(callback => callback()),
    replaceDb: () => {
      currentDb = { ...db };
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('automatic recovery for displayed files', () => {
  it('releases the preview when the managed account lookup never answers', async () => {
    const f = fixture();
    f.deps.account.mockImplementation(() => new Promise(() => {}));
    const recovering = f.recover(A);
    await vi.advanceTimersByTimeAsync(30_500);
    expect(await recovering).toBe(false);
    expect(f.deps.credentials).not.toHaveBeenCalled();
    expect(f.deps.repair).not.toHaveBeenCalled();
  });

  it('aborts a Vault repair that never answers and guards its late work', async () => {
    const f = fixture();
    f.deps.repair.mockImplementation(() => new Promise(() => {}));
    const recovering = f.recover(A);
    await vi.advanceTimersByTimeAsync(30_500);
    expect(await recovering).toBe(false);
    const request = f.deps.repair.mock.calls[0][0];
    expect(request.signal?.aborted).toBe(true);
    await expect(async () => request.throwIfStale?.()).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(f.state.local.has(A)).toBe(false);
  });

  it('does not start recovery after a timed-out key lookup eventually resolves', async () => {
    const f = fixture();
    let finish!: () => void;
    f.deps.credentials.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = () =>
            resolve({
              drivePseudonym: 'late-pseudonym',
              driveKey: new Uint8Array(32).fill(9),
              keyEpoch: 3,
            });
        }),
    );
    const recovering = f.recover(A);
    await vi.advanceTimersByTimeAsync(30_500);
    expect(await recovering).toBe(false);
    finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.deps.repair).not.toHaveBeenCalled();
  });

  it('gives a newly queued file its own attempt when the active Vault repair fails', async () => {
    const f = fixture();
    let fail!: () => void;
    f.deps.repair.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new Error('File A could not be downloaded'));
        }),
    );
    const first = f.recover(A);
    await vi.advanceTimersByTimeAsync(5_500);
    const second = f.recover(B);
    fail();
    await vi.advanceTimersByTimeAsync(5_500);
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(f.deps.repair.mock.calls.map(call => call[0].hashes)).toEqual([
      [A],
      [B],
    ]);
    expect(await f.recover(A)).toBe(false);
    expect(f.state.local.has(B)).toBe(true);
  });

  it('shares the same hash and batches concurrent images into one selective Vault pass', async () => {
    const f = fixture();
    const first = f.recover(A);
    expect(f.recover(A)).toBe(first);
    const second = f.recover(B);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(f.deps.repair).toHaveBeenCalledTimes(1);
    expect(f.deps.repair).toHaveBeenCalledWith(
      expect.objectContaining({
        hashes: [A, B],
        peerWaitMs: 0,
        driveSubject: DRIVE,
      }),
    );
    expect(f.state.local.has(C)).toBe(false);
    expect(f.db.vaultImport).not.toHaveBeenCalled();
  });

  it('repairs from peers without a managed account or a vault key', async () => {
    const f = fixture();
    f.state.email = null;
    f.deps.peers.mockImplementation(async (_store, _drive, hashes) => {
      for (const hash of hashes) f.state.local.add(hash);
    });
    const recovering = f.recover(A);
    await vi.advanceTimersByTimeAsync(600);
    expect(await recovering).toBe(true);
    expect(f.deps.account).not.toHaveBeenCalled();
    expect(f.deps.credentials).not.toHaveBeenCalled();
    expect(f.deps.repair).not.toHaveBeenCalled();
  });

  it('includes files requested while the five-second peer opportunity is running', async () => {
    const f = fixture();
    const first = f.recover(A);
    await vi.advanceTimersByTimeAsync(1_000);
    const second = f.recover(B);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(f.deps.repair).toHaveBeenCalledTimes(1);
    expect(f.deps.repair.mock.calls[0][0].hashes).toEqual([A, B]);
  });

  it('uses local presence for native-shaped databases without a browser ClientDb', async () => {
    const f = fixture();
    f.state.local.add(A);
    const recovering = f.recover(A);
    await vi.advanceTimersByTimeAsync(200);
    expect(await recovering).toBe(true);
    expect(f.deps.peers).not.toHaveBeenCalled();
    expect(f.deps.repair).not.toHaveBeenCalled();
  });

  it('does not disclose or recover a hash outside the drive references', async () => {
    const f = fixture();
    f.state.refs = [B];
    const recovering = f.recover(A);
    await vi.advanceTimersByTimeAsync(200);
    expect(await recovering).toBe(false);
    expect(f.deps.peers).not.toHaveBeenCalled();
    expect(f.deps.account).not.toHaveBeenCalled();
  });

  it('bounds failures with a cooldown and retries visible readers after online', async () => {
    const f = fixture();
    f.state.email = null;
    const first = f.recover(A);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(await first).toBe(false);
    expect(await f.recover(A)).toBe(false);
    expect(f.deps.account).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('online'));
    expect(f.store.retryFileContentRecovery).toHaveBeenCalled();
    f.state.email = 'alice@example.test';
    const retry = f.recover(A);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(await retry).toBe(true);
  });

  it.each([StoreEvents.AgentChanged, StoreEvents.DriveChanged])(
    'cancels stale requests after %s',
    async event => {
      const f = fixture();
      const recovering = f.recover(A);
      await vi.advanceTimersByTimeAsync(300);
      f.emit(event);
      expect(await recovering).toBe(false);
      await vi.advanceTimersByTimeAsync(5_500);
      expect(f.deps.credentials).not.toHaveBeenCalled();
      expect(f.deps.repair).not.toHaveBeenCalled();
    },
  );

  it('cancels and notifies readers when the local database changes', async () => {
    const f = fixture();
    const recovering = f.recover(A);
    await vi.advanceTimersByTimeAsync(300);
    f.replaceDb();
    f.emit(StoreEvents.SyncStatusChanged);
    expect(await recovering).toBe(false);
    expect(f.store.retryFileContentRecovery).toHaveBeenCalled();
  });

  it('disposes pending work and leaves no automatic repair running', async () => {
    const f = fixture();
    const recovering = f.recover(A);
    await vi.advanceTimersByTimeAsync(300);
    f.dispose();
    expect(await recovering).toBe(false);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(f.deps.repair).not.toHaveBeenCalled();
  });
});
