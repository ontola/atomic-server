import { describe, it, expect, vi, beforeEach } from 'vitest';
import { backupBlobs } from './vault';

const invoke = vi.fn();
const listen = vi.fn();
const native = vi.hoisted(() => ({ value: false }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...args),
}));
vi.mock('../tauri', () => ({ isRunningInTauri: () => native.value }));

const { nodeVault, onNodeFileContents, requestNodeFileContents } =
  await import('./nodeVault');

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  native.value = false;
});

describe('native stored-file notifications', () => {
  it('does not register a native listener in an ordinary browser', async () => {
    const callback = vi.fn();
    const stop = onNodeFileContents(callback);
    await Promise.resolve();
    expect(listen).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    stop();
  });

  it('rechecks after listener registration and forwards only valid stored-file hints', async () => {
    native.value = true;
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const callback = vi.fn();
    const stop = onNodeFileContents(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(null));
    expect(listen).toHaveBeenCalledWith(
      'atomic-file-content-stored',
      expect.any(Function),
    );
    const handler = listen.mock.calls[0][1];
    callback.mockClear();
    for (const payload of [
      undefined,
      {},
      { hash: 42 },
      { hash: 'AA'.repeat(32) },
      { hash: 'not-a-hash' },
    ])
      handler({ payload });
    expect(callback).not.toHaveBeenCalled();
    handler({ payload: { hash: 'ab'.repeat(32) } });
    handler({ payload: { hash: null } });
    expect(callback.mock.calls).toEqual([['ab'.repeat(32)], [null]]);
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
    handler({ payload: { hash: 'cd'.repeat(32) } });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('disposes a listener whose asynchronous registration finishes after shutdown', async () => {
    native.value = true;
    const registration = Promise.withResolvers<() => void>();
    listen.mockReturnValue(registration.promise);
    const callback = vi.fn();
    const unlisten = vi.fn();
    const stop = onNodeFileContents(callback);
    await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce());
    stop();
    registration.resolve(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
    expect(callback).not.toHaveBeenCalled();
  });
});

/**
 * These tests are about the boundary, not the vault.
 *
 * Sealed bytes and drive keys are the two things crossing IPC, and getting
 * exactly that wrong once already stored a stringified byte array in every
 * vault object — uploaded, confirmed, and unreadable. So assert the bytes
 * survive the trip rather than that the call was made.
 */
describe('nodeVault', () => {
  const key = new Uint8Array(32).fill(7);

  it('provides native file export so a file backup runs even when history is unchanged', async () => {
    vi.stubEnv('VITE_MANAGED_PORTAL_URL', 'http://localhost:3031');
    invoke.mockResolvedValue([]);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => [],
    } as Response);

    try {
      const outcome = await backupBlobs({
        db: nodeVault,
        driveSubject: 'atomic:native-drive',
        drivePseudonym: 'native-file-backup',
        driveKey: key,
        keyEpoch: 1,
      });
      expect(outcome).toEqual({
        uploaded: 0,
        alreadyStored: 0,
        missing: 0,
        tooLarge: 0,
        bytesUploaded: 0,
      });
      expect(invoke).toHaveBeenCalledWith('vault_file_hashes', {
        driveSubject: 'atomic:native-drive',
      });
      expect(invoke).toHaveBeenCalledWith('vault_blob_close');
    } finally {
      fetcher.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('passes a file plan and binary sealed chunks over the native export boundary', async () => {
    const plan = {
      status: 'ready',
      size: 2,
      blobId: 'per-vault-id',
      chunks: [{ index: 0, offset: 0, length: 2, sealedLength: 48 }],
    };
    const sealed = new Uint8Array([0, 1, 127, 128, 254, 255]);
    invoke.mockImplementation(async command => {
      if (command === 'vault_blob_open') return plan;
      if (command === 'vault_blob_chunk')
        return btoa(String.fromCharCode(...sealed));
    });
    expect(await nodeVault.vaultBlobOpen!('plain-hash', key, 3)).toEqual(plan);
    expect(invoke).toHaveBeenCalledWith('vault_blob_open', {
      hash: 'plain-hash',
      key: btoa(String.fromCharCode(...key)),
      keyEpoch: 3,
    });
    const result = await nodeVault.vaultBlobChunk!('plain-hash', key, 3, 0);
    expect(result).toBeInstanceOf(Uint8Array);
    expect([...result]).toEqual([...sealed]);
    expect(invoke).toHaveBeenCalledWith('vault_blob_chunk', {
      hash: 'plain-hash',
      key: btoa(String.fromCharCode(...key)),
      keyEpoch: 3,
      index: 0,
    });
    await nodeVault.vaultBlobClose!();
    expect(invoke).toHaveBeenLastCalledWith('vault_blob_close');
  });

  it('sends the key as base64 and brings sealed bytes back intact', async () => {
    const sealed = new Uint8Array([0, 1, 254, 255, 127, 128]);
    invoke.mockResolvedValue({
      objectKey: 'v1/drive/lane/000001',
      sealed: btoa(String.fromCharCode(...sealed)),
      kind: 'pack',
      resources: 3,
      unchanged: 9,
      tombstones: 1,
      coverage: {},
    });

    const result = await nodeVault.vaultExport(
      'did:ad:drive',
      key,
      2,
      'pseudo',
      'dev',
      1,
      1,
      true,
      {},
    );

    const [command, args] = invoke.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(command).toBe('vault_export');
    expect(typeof args.key).toBe('string');
    expect(args.keyEpoch).toBe(2);

    expect(result?.sealed).toBeInstanceOf(Uint8Array);
    expect([...(result?.sealed ?? [])]).toEqual([...sealed]);
    expect(result?.objectKey).toBe('v1/drive/lane/000001');
    expect(result?.resources).toBe(3);
    expect(result?.kind).toBe('pack');
    expect(result?.unchanged).toBe(
      9,
      // The count the whole incremental pass exists to make large.
    );
  });

  /**
   * Nothing to back up is an answer, not a failure — and since incremental
   * cursors landed it is the ordinary answer for an idle device.
   */
  it('passes through the "nothing changed since the cursor" null', async () => {
    invoke.mockResolvedValue(null);
    expect(
      await nodeVault.vaultExport(
        'did:ad:drive',
        key,
        1,
        'p',
        'd',
        4,
        1,
        true,
        {},
      ),
    ).toBeNull();
  });

  /**
   * A checkpoint crosses the boundary as a different `kind` and carries the
   * coverage map the caller must publish. Losing either would leave the control
   * plane storing an anchor it does not know it can prune against.
   */
  it('carries a checkpoint kind and its coverage across the IPC boundary', async () => {
    invoke.mockResolvedValue({
      objectKey: 'vault/pseudo/checkpoints/ckpt-000002.loro',
      sealed: btoa('xx'),
      kind: 'checkpoint',
      resources: 40,
      unchanged: 0,
      tombstones: 2,
      coverage: { dev: 7 },
    });

    const result = await nodeVault.vaultExport(
      'did:ad:drive',
      key,
      1,
      'pseudo',
      'dev',
      8,
      2,
      true,
      { dev: 7 },
    );

    expect(result?.kind).toBe('checkpoint');
    expect(result?.coverage).toEqual({ dev: 7 });

    const [, args] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.checkpointN).toBe(2);
    expect(args.observedLanes).toEqual({ dev: 7 });
  });

  it('encodes objects for import and passes them through in listing order', async () => {
    invoke.mockResolvedValue({
      packsRead: 2,
      resourcesRestored: 5,
      tombstonesApplied: 0,
      objectsSkipped: 1,
      objectsUnreadable: 0,
    });

    const objects = [
      { objectKey: 'a/000001', sealed: new Uint8Array([1, 2]) },
      { objectKey: 'a/000002', sealed: new Uint8Array([3, 4]) },
    ];
    const outcome = await nodeVault.vaultImport(
      key,
      1,
      'pseudo',
      'dev',
      objects,
    );

    const [, args] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    const sent = args.objects as { objectKey: string; sealed: string }[];

    // The list crosses intact; the *application* order is decided on the other
    // side by `plan_restore`, from the newest checkpoint's coverage and
    // observed maps. What must not happen here is objects being dropped or
    // reordered on the way.
    expect(sent.map(o => o.objectKey)).toEqual(['a/000001', 'a/000002']);
    expect(sent.every(o => typeof o.sealed === 'string')).toBe(true);
    expect(outcome.resourcesRestored).toBe(5);
  });

  it('commits a segment by name', async () => {
    invoke.mockResolvedValue(undefined);
    await nodeVault.vaultCommitSegment('pseudo', 'dev', 9);

    expect(invoke).toHaveBeenCalledWith('vault_commit_segment', {
      drivePseudonym: 'pseudo',
      devicePubkey: 'dev',
      segment: 9,
    });
  });

  it('restores file chunks across IPC without importing history', async () => {
    const chunks = [new Uint8Array([0, 255, 128]), new Uint8Array([254, 1, 2])];
    invoke.mockResolvedValue({ status: 'restored', hash: 'plain-hash' });
    const result = await nodeVault.vaultBlobRestore!(
      key,
      3,
      'vault-blob-id',
      chunks,
      ['plain-hash'],
      'atomic:current-drive',
    );
    const [command, args] = invoke.mock.calls[0];
    expect(command).toBe('vault_blob_restore');
    expect(args.key).toBe(btoa(String.fromCharCode(...key)));
    expect(args.keyEpoch).toBe(3);
    expect(args.wanted).toEqual(['plain-hash']);
    expect(args.driveSubject).toBe('atomic:current-drive');
    expect(
      args.chunks.map((chunk: string) =>
        [...atob(chunk)].map(c => c.charCodeAt(0)),
      ),
    ).toEqual(chunks.map(chunk => [...chunk]));
    expect(result).toEqual({ status: 'restored', hash: 'plain-hash' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not request files after recovery has been cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestNodeFileContents('atomic:drive', ['hash'], controller.signal),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
