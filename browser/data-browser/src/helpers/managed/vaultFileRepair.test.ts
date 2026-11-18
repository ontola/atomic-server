import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { managedFetch } from './api';
import { repairDriveFiles, type FileRepairProgress } from './vaultFileRepair';
import type { VaultCapableDb } from './vault';

vi.mock('./api', () => ({ managedFetch: vi.fn() }));

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const C = 'cc'.repeat(32);
const DRIVE = 'atomic:test-drive';
const PSEUDONYM = 'private-drive';
const DRIVE_KEY = new Uint8Array(32).fill(7);
const object = (id: string) => ({
  object_id: id,
  object_key: `vault/${PSEUDONYM}/blobs/${id}/000000`,
  kind: 'blob',
  size_bytes: 50,
});

function fixture(hashes: string[] = [A]) {
  const state = {
    referenced: hashes,
    local: new Set<string>(),
    stored: [A],
    corrupt: new Set<string>(),
    objectsStatus: 200,
    downloadError: false,
    afterDownload: () => {},
  };
  const resources = { name: 'Current edited drive', version: 42, deleted: [B] };
  const history = ['current', 'older'];
  const db = {
    vaultExport: vi.fn(),
    vaultImport: vi.fn(),
    vaultCommitSegment: vi.fn(),
    vaultFileHashes: vi.fn(async () => state.referenced),
    vaultBlobPresent: vi.fn(async (hash: string) => state.local.has(hash)),
    vaultBlobRestore: vi.fn(
      async (
        _key: Uint8Array,
        _epoch: number,
        id: string,
        _chunks: Uint8Array[],
        wanted: string[],
      ) => {
        if (state.corrupt.has(id)) return { status: 'unreadable' as const };
        if (!wanted.includes(id)) return { status: 'unreferenced' as const };
        state.local.add(id);

        return { status: 'restored' as const, hash: id };
      },
    ),
  } satisfies VaultCapableDb;
  const json = (value: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => value }) as Response;
  vi.mocked(managedFetch).mockImplementation(async (path, init) => {
    if (String(path).endsWith('/objects')) {
      return json(state.stored.map(object), state.objectsStatus);
    }

    if (String(path).endsWith('/download-urls')) {
      const body = JSON.parse(String(init?.body));

      return json({
        downloads: body.object_ids.map((id: string) => ({
          object_key: object(id).object_key,
          url: `https://storage.test/${id}`,
        })),
      });
    }

    throw new Error(`unexpected request ${path}`);
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      if (state.downloadError) throw new TypeError('Network interrupted');

      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          state.afterDownload();

          return new Uint8Array([1, 2]).buffer;
        },
      } as Response;
    }),
  );
  const tryPeers = vi.fn(async () => {});
  const progress: FileRepairProgress[] = [];
  const args = {
    db,
    driveSubject: DRIVE,
    drivePseudonym: PSEUDONYM,
    driveKey: DRIVE_KEY,
    tryPeers,
    onProgress: (next: FileRepairProgress) => progress.push(next),
  };

  return { state, db, tryPeers, args, progress, resources, history };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(managedFetch).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('recovering missing drive files', () => {
  it('selectively repairs requested hashes after an earlier peer opportunity', async () => {
    const f = fixture([A, B]);
    f.state.stored = [A, B];
    const result = await repairDriveFiles({
      ...f.args,
      hashes: [A, A],
      peerWaitMs: 0,
    });
    expect(result).toEqual({
      total: 1,
      repaired: 1,
      missing: [],
      unreadable: 0,
    });
    expect(f.state.local.has(B)).toBe(false);
    expect(f.tryPeers).not.toHaveBeenCalled();
    expect(f.db.vaultBlobRestore).toHaveBeenCalledTimes(1);
  });

  it('rejects another recovery for the same db and drive and releases it after cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    const first = repairDriveFiles({ ...f.args, signal: controller.signal });
    const cancelled = expect(first).rejects.toMatchObject({
      name: 'AbortError',
    });
    await vi.advanceTimersByTimeAsync(300);
    await expect(
      repairDriveFiles({
        ...f.args,
        driveSubject: DRIVE.replace('atomic:', 'did:ad:'),
      }),
    ).rejects.toThrow('already running');
    controller.abort();
    await cancelled;
    const retry = repairDriveFiles(f.args);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(await retry).toMatchObject({ repaired: 1, missing: [] });
  });

  it('actively tries peers first and skips Vault when they supply the bytes', async () => {
    const f = fixture();
    f.tryPeers.mockImplementation(async () => {
      f.state.local.add(A);
    });
    const repairing = repairDriveFiles(f.args);
    await vi.advanceTimersByTimeAsync(300);
    expect(await repairing).toEqual({
      total: 1,
      repaired: 1,
      missing: [],
      unreadable: 0,
    });
    expect(f.tryPeers).toHaveBeenCalledWith([A], expect.any(AbortSignal));
    expect(managedFetch).not.toHaveBeenCalled();
    expect(f.db.vaultImport).not.toHaveBeenCalled();
    expect(f.progress.map(p => p.stage)).toContain('peers');
  });

  it('repairs only the remaining hashes and preserves resources and history', async () => {
    const f = fixture([A, B, B, C]);
    f.state.stored = [B];
    f.tryPeers.mockImplementation(async () => {
      f.state.local.add(A);
    });
    const before = JSON.stringify([f.resources, f.history]);
    const repairing = repairDriveFiles(f.args);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(await repairing).toEqual({
      total: 3,
      repaired: 2,
      missing: [C],
      unreadable: 0,
    });
    expect(f.tryPeers).toHaveBeenCalledWith([A, B, C], expect.any(AbortSignal));
    expect(f.db.vaultBlobRestore).toHaveBeenCalledWith(
      DRIVE_KEY,
      1,
      B,
      expect.any(Array),
      [B, C],
      DRIVE,
    );
    expect(JSON.stringify([f.resources, f.history])).toBe(before);
    expect(f.db.vaultImport).not.toHaveBeenCalled();
    expect(f.db.vaultExport).not.toHaveBeenCalled();
    expect(f.db.vaultCommitSegment).not.toHaveBeenCalled();
    expect(vi.mocked(managedFetch).mock.calls.map(c => String(c[0]))).toEqual([
      `/cloud-vault/${PSEUDONYM}/objects`,
      `/cloud-vault/${PSEUDONYM}/download-urls`,
    ]);
  });

  it.each([{ current: [] }, { current: [B] }])(
    'rechecks deletion or replacement after a download, references $current',
    async ({ current }) => {
      const f = fixture();

      f.state.afterDownload = () => {
        f.state.referenced = current;
      };

      const repairing = repairDriveFiles(f.args);
      await vi.advanceTimersByTimeAsync(5_500);
      expect(await repairing).toEqual({
        total: 0,
        repaired: 0,
        missing: [],
        unreadable: 0,
      });
      expect(f.db.vaultBlobRestore).not.toHaveBeenCalled();
      expect(f.state.local.size).toBe(0);
    },
  );

  it('aborts before storing bytes downloaded after cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.state.afterDownload = () => controller.abort();
    const repairing = repairDriveFiles({
      ...f.args,
      signal: controller.signal,
    });
    const rejected = expect(repairing).rejects.toMatchObject({
      name: 'AbortError',
    });
    await vi.advanceTimersByTimeAsync(5_500);
    await rejected;
    expect(f.db.vaultBlobRestore).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it('cancels a stale drive or account before the worker receives the bytes', async () => {
    const f = fixture();
    let stale = false;

    f.state.afterDownload = () => {
      stale = true;
    };

    const repairing = repairDriveFiles({
      ...f.args,
      throwIfStale: () => {
        if (stale) throw new Error('Drive or account changed');
      },
    });
    const rejected = expect(repairing).rejects.toThrow(
      'Drive or account changed',
    );
    await vi.advanceTimersByTimeAsync(5_500);
    await rejected;
    expect(f.db.vaultBlobRestore).not.toHaveBeenCalled();
  });

  it('reports unresolved hashes when the Vault session expires', async () => {
    const f = fixture();
    f.state.objectsStatus = 401;
    const repairing = repairDriveFiles(f.args);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(await repairing).toMatchObject({
      total: 1,
      repaired: 0,
      missing: [A],
      error: expect.any(String),
    });
    expect(f.db.vaultBlobRestore).not.toHaveBeenCalled();
  });

  it('keeps exact missing hashes even when unrelated corrupt objects reduce restore counts', async () => {
    const f = fixture([A, B]);
    f.state.stored = [C];
    f.state.corrupt.add(C);
    const repairing = repairDriveFiles(f.args);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(await repairing).toEqual({
      total: 2,
      repaired: 0,
      missing: [A, B],
      unreadable: 1,
    });
  });

  it('leaves a file unresolved when the decrypted hash is outside the requested set', async () => {
    const f = fixture();
    f.state.stored = [B];
    const repairing = repairDriveFiles(f.args);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(await repairing).toEqual({
      total: 1,
      repaired: 0,
      missing: [A],
      unreadable: 0,
    });
    expect(f.state.local.size).toBe(0);
  });

  it('can retry an interrupted download without importing history', async () => {
    const f = fixture();
    f.state.downloadError = true;
    const first = repairDriveFiles(f.args);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(await first).toMatchObject({
      missing: [A],
      repaired: 0,
      error: 'Network interrupted',
    });
    f.state.downloadError = false;
    const retry = repairDriveFiles(f.args);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(await retry).toEqual({
      total: 1,
      repaired: 1,
      missing: [],
      unreadable: 0,
    });
    expect(f.db.vaultImport).not.toHaveBeenCalled();
  });
});
