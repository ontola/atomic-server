import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const { nodeVault } = await import('./nodeVault');

beforeEach(() => {
  invoke.mockReset();
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

  it('sends the key as base64 and brings sealed bytes back intact', async () => {
    const sealed = new Uint8Array([0, 1, 254, 255, 127, 128]);
    invoke.mockResolvedValue({
      objectKey: 'v1/drive/lane/000001',
      sealed: btoa(String.fromCharCode(...sealed)),
      resources: 3,
      tombstones: 1,
    });

    const result = await nodeVault.vaultExport('did:ad:drive', key, 2, 'pseudo', 'dev', 1);

    const [command, args] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe('vault_export');
    expect(typeof args.key).toBe('string');
    expect(args.keyEpoch).toBe(2);

    expect(result?.sealed).toBeInstanceOf(Uint8Array);
    expect([...(result?.sealed ?? [])]).toEqual([...sealed]);
    expect(result?.objectKey).toBe('v1/drive/lane/000001');
    expect(result?.resources).toBe(3);
  });

  /** Nothing to back up is an answer, not a failure. */
  it('passes through the "unchanged since last segment" null', async () => {
    invoke.mockResolvedValue(null);
    expect(await nodeVault.vaultExport('did:ad:drive', key, 1, 'p', 'd', 4)).toBeNull();
  });

  it('encodes objects for import and preserves their order', async () => {
    invoke.mockResolvedValue({
      packsRead: 2,
      resourcesRestored: 5,
      tombstonesApplied: 0,
    });

    const objects = [
      { objectKey: 'a/000001', sealed: new Uint8Array([1, 2]) },
      { objectKey: 'a/000002', sealed: new Uint8Array([3, 4]) },
    ];
    const outcome = await nodeVault.vaultImport(key, 1, 'pseudo', objects);

    const [, args] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    const sent = args.objects as { objectKey: string; sealed: string }[];

    // Order is the caller's contract: a later segment's deletion has to be
    // applied after the earlier pack that created the resource.
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
});
