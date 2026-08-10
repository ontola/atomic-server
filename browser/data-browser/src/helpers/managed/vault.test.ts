import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  agentSecretBytes,
  vaultLaneId,
  backupDrive,
  restoreDrive,
  setUpVaultForDrive,
  recoverDriveKey,
  nextSegmentFor,
  runVaultBackup,
  type VaultCapableDb,
  type VaultKeyOps,
  type VaultDriveState,
} from './vault';

/**
 * These cover the orchestration, which is deliberately the half that lives in
 * TypeScript: WASM does crypto and format, this does the network. The Rust
 * tests cannot reach any of it — ordering of upload vs confirm, what happens
 * when storage rejects a PUT, whether restore replays segments in the right
 * order. Each of those is a data-integrity property, not a plumbing detail.
 */

const DEVICE = '03'.repeat(32);
const PSEUDONYM = 'testpseudonym';
const KEY = new Uint8Array(32).fill(7);

beforeEach(() => {
  vi.stubEnv('VITE_MANAGED_PORTAL_URL', 'https://control.test');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A sealed pack, as the WASM binding would hand it over. */
function sealedPack(objectKey: string, bytes = 4) {
  return {
    objectKey,
    sealed: new Uint8Array(bytes).fill(1),
    resources: 3,
    tombstones: 0,
  };
}

const PACK_KEY = `vault/${PSEUDONYM}/lanes/${DEVICE}/seg-000001.pack`;

/** Records every request so a test can assert on order, not just on calls. */
function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; method: string }[] = [];
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const result = handler(url, init);

    return (
      result ?? {
        ok: true,
        status: 200,
        json: async () => ({}),
      }
    );
  });
  vi.stubGlobal('fetch', spy);

  return calls;
}

describe('backupDrive', () => {
  it('uploads nothing when the drive has not changed', async () => {
    const db: VaultCapableDb = {
      vaultExport: vi.fn(async () => null),
      vaultImport: vi.fn(),
      vaultCommitSegment: vi.fn(),
    };
    const calls = mockFetch(() => undefined);

    const outcome = await backupDrive({
      db,
      driveSubject: 'did:ad:drive',
      drivePseudonym: PSEUDONYM,
      devicePubkey: DEVICE,
      driveKey: KEY,
      segment: 1,
    });

    expect(outcome).toEqual({ status: 'nothing-to-do' });
    expect(calls).toHaveLength(0);
  });

  /**
   * The object is confirmed only after storage accepted it. Confirming first
   * would make quota drift upward on every dropped connection — usage the user
   * never consumed and cannot clear.
   */
  it('confirms only after storage accepts the bytes', async () => {
    const db: VaultCapableDb = {
      vaultExport: vi.fn(async () => sealedPack(PACK_KEY)),
      vaultImport: vi.fn(),
      vaultCommitSegment: vi.fn(),
    };
    const calls = mockFetch(url => {
      if (url.endsWith('/upload-urls')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            uploads: [
              {
                object_id: 'obj-1',
                object_key: PACK_KEY,
                url: 'https://s3.test/put',
                method: 'PUT',
                headers: [['content-length', '4']],
                size_bytes: 4,
              },
            ],
          }),
        };
      }

      return undefined;
    });

    const outcome = await backupDrive({
      db,
      driveSubject: 'did:ad:drive',
      drivePseudonym: PSEUDONYM,
      devicePubkey: DEVICE,
      driveKey: KEY,
      segment: 1,
    });

    expect(outcome).toMatchObject({ status: 'backed-up', resources: 3 });
    const order = calls.map(c => c.url);
    expect(order[0]).toContain('/upload-urls');
    expect(order[1]).toBe('https://s3.test/put');
    expect(order[2]).toContain('/confirm-upload');
  });

  it('does not confirm an upload storage rejected', async () => {
    const db: VaultCapableDb = {
      vaultExport: vi.fn(async () => sealedPack(PACK_KEY)),
      vaultImport: vi.fn(),
      vaultCommitSegment: vi.fn(),
    };
    const calls = mockFetch(url => {
      if (url.endsWith('/upload-urls')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            uploads: [
              {
                object_id: 'obj-1',
                object_key: PACK_KEY,
                url: 'https://s3.test/put',
                method: 'PUT',
                headers: [],
                size_bytes: 4,
              },
            ],
          }),
        };
      }

      if (url === 'https://s3.test/put') {
        return { ok: false, status: 403, json: async () => ({}) };
      }

      return undefined;
    });

    await expect(
      backupDrive({
        db,
        driveSubject: 'did:ad:drive',
        drivePseudonym: PSEUDONYM,
        devicePubkey: DEVICE,
        driveKey: KEY,
        segment: 1,
      }),
    ).rejects.toThrow(/upload failed/i);

    expect(calls.some(c => c.url.includes('/confirm-upload'))).toBe(false);
  });

  /**
   * The layout is implemented in two repos. If they disagree, the upload lands
   * where restore never looks, and nothing notices until a restore comes up
   * short — so it has to be caught at the moment of disagreement.
   */
  it('refuses to upload when the server names a different object key', async () => {
    const db: VaultCapableDb = {
      vaultExport: vi.fn(async () => sealedPack(PACK_KEY)),
      vaultImport: vi.fn(),
      vaultCommitSegment: vi.fn(),
    };
    mockFetch(url => {
      if (url.endsWith('/upload-urls')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            uploads: [
              {
                object_id: 'obj-1',
                object_key: `vault/${PSEUDONYM}/lanes/${DEVICE}/seg-000009.pack`,
                url: 'https://s3.test/put',
                method: 'PUT',
                headers: [],
                size_bytes: 4,
              },
            ],
          }),
        };
      }

      return undefined;
    });

    await expect(
      backupDrive({
        db,
        driveSubject: 'did:ad:drive',
        drivePseudonym: PSEUDONYM,
        devicePubkey: DEVICE,
        driveKey: KEY,
        segment: 1,
      }),
    ).rejects.toThrow(/key mismatch/i);
  });

  /** Assigning Content-Length throws in the browser before the request goes out. */
  it('strips content-length from the headers it forwards', async () => {
    const db: VaultCapableDb = {
      vaultExport: vi.fn(async () => sealedPack(PACK_KEY)),
      vaultImport: vi.fn(),
      vaultCommitSegment: vi.fn(),
    };
    let putHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/upload-urls')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              uploads: [
                {
                  object_id: 'obj-1',
                  object_key: PACK_KEY,
                  url: 'https://s3.test/put',
                  method: 'PUT',
                  headers: [
                    ['content-length', '4'],
                    ['x-custom', 'kept'],
                  ],
                  size_bytes: 4,
                },
              ],
            }),
          };
        }

        if (url === 'https://s3.test/put') {
          putHeaders = init?.headers as Record<string, string>;
        }

        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    await backupDrive({
      db,
      driveSubject: 'did:ad:drive',
      drivePseudonym: PSEUDONYM,
      devicePubkey: DEVICE,
      driveKey: KEY,
      segment: 1,
    });

    expect(putHeaders).toEqual({ 'x-custom': 'kept' });
  });

  /** A billing rejection should read as one, not as a generic failure. */
  it("surfaces the control plane's own message", async () => {
    const db: VaultCapableDb = {
      vaultExport: vi.fn(async () => sealedPack(PACK_KEY)),
      vaultImport: vi.fn(),
      vaultCommitSegment: vi.fn(),
    };
    mockFetch(url =>
      url.endsWith('/upload-urls')
        ? {
            ok: false,
            status: 402,
            json: async () => ({ error: 'Cloud Vault quota exceeded' }),
          }
        : undefined,
    );

    await expect(
      backupDrive({
        db,
        driveSubject: 'did:ad:drive',
        drivePseudonym: PSEUDONYM,
        devicePubkey: DEVICE,
        driveKey: KEY,
        segment: 1,
      }),
    ).rejects.toThrow('Cloud Vault quota exceeded');
  });
});

describe('restoreDrive', () => {
  it('reports nothing when the vault is empty', async () => {
    const db: VaultCapableDb = {
      vaultExport: vi.fn(),
      vaultImport: vi.fn(),
      vaultCommitSegment: vi.fn(),
    };
    mockFetch(url =>
      url.endsWith('/objects')
        ? { ok: true, status: 200, json: async () => [] }
        : undefined,
    );

    const outcome = await restoreDrive({
      db,
      drivePseudonym: PSEUDONYM,
      driveKey: KEY,
    });

    expect(outcome.resourcesRestored).toBe(0);
    expect(db.vaultImport).not.toHaveBeenCalled();
  });

  /**
   * The listing is ordered for replay; `download-urls` answers per request and
   * is not required to echo that order. Applying out of order would let a later
   * segment's deletion land before the pack that re-creates the resource — the
   * delete would silently be undone.
   */
  it('applies objects in listing order, not download order', async () => {
    const first = `vault/${PSEUDONYM}/lanes/${DEVICE}/seg-000001.pack`;
    const second = `vault/${PSEUDONYM}/lanes/${DEVICE}/seg-000002.pack`;
    const imported: string[] = [];

    const db: VaultCapableDb = {
      vaultExport: vi.fn(),
      vaultImport: vi.fn(
        async (
          _k: Uint8Array,
          _e: number,
          _p: string,
          objects: { objectKey: string; sealed: Uint8Array }[],
        ) => {
          imported.push(...objects.map(o => o.objectKey));

          return { packsRead: 2, resourcesRestored: 5, tombstonesApplied: 1 };
        },
      ),
      vaultCommitSegment: vi.fn(),
    };

    mockFetch(url => {
      if (url.endsWith('/objects')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { object_id: 'a', object_key: first },
            { object_id: 'b', object_key: second },
          ],
        };
      }

      if (url.endsWith('/download-urls')) {
        // Deliberately reversed.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            downloads: [
              { object_id: 'b', object_key: second, url: 'https://s3.test/2' },
              { object_id: 'a', object_key: first, url: 'https://s3.test/1' },
            ],
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
      };
    });

    const outcome = await restoreDrive({
      db,
      drivePseudonym: PSEUDONYM,
      driveKey: KEY,
    });

    expect(imported).toEqual([first, second]);
    expect(outcome.resourcesRestored).toBe(5);
  });

  it('reports progress as objects arrive', async () => {
    const db: VaultCapableDb = {
      vaultExport: vi.fn(),
      vaultImport: vi.fn(async () => ({
        packsRead: 2,
        resourcesRestored: 1,
        tombstonesApplied: 0,
      })),
      vaultCommitSegment: vi.fn(),
    };
    mockFetch(url => {
      if (url.endsWith('/objects')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { object_id: 'a', object_key: 'k1' },
            { object_id: 'b', object_key: 'k2' },
          ],
        };
      }

      if (url.endsWith('/download-urls')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            downloads: [
              { object_id: 'a', object_key: 'k1', url: 'https://s3.test/1' },
              { object_id: 'b', object_key: 'k2', url: 'https://s3.test/2' },
            ],
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([9]).buffer,
      };
    });

    const seen: [number, number][] = [];
    await restoreDrive({
      db,
      drivePseudonym: PSEUDONYM,
      driveKey: KEY,
      onProgress: (done, total) => seen.push([done, total]),
    });

    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('fails loudly when the server issues no URL for a listed object', async () => {
    const db: VaultCapableDb = {
      vaultExport: vi.fn(),
      vaultImport: vi.fn(),
      vaultCommitSegment: vi.fn(),
    };
    mockFetch(url => {
      if (url.endsWith('/objects')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ object_id: 'a', object_key: 'k1' }],
        };
      }

      if (url.endsWith('/download-urls')) {
        return { ok: true, status: 200, json: async () => ({ downloads: [] }) };
      }

      return undefined;
    });

    await expect(
      restoreDrive({
        db,
        drivePseudonym: PSEUDONYM,
        driveKey: KEY,
      }),
    ).rejects.toThrow(/No download URL/i);
  });
});

describe('key management', () => {
  /** A stand-in for the WASM key ops: wrapping is reversible and keyed. */
  function fakeKeys(): VaultKeyOps {
    let counter = 0;

    return {
      vaultGenerateKey: () => new Uint8Array(32).fill(++counter),
      vaultWrapKey: (key, secret) =>
        JSON.stringify({ key: Array.from(key), secret: Array.from(secret) }),
      vaultUnwrapKey: (envelope, secret) => {
        const parsed = JSON.parse(envelope);

        if (parsed.secret.join() !== Array.from(secret).join()) {
          throw new Error('wrong agent secret');
        }

        return new Uint8Array(parsed.key);
      },
    };
  }

  const AGENT_SECRET = new Uint8Array([1, 2, 3]);

  /**
   * The failure this guards against is unrecoverable: a second key would leave
   * every object written under the first permanently unreadable.
   */
  it('reuses an existing key rather than minting a second one', async () => {
    const keys = fakeKeys();
    const stored = keys.vaultWrapKey(new Uint8Array(32).fill(99), AGENT_SECRET);
    const puts: string[] = [];

    mockFetch((url, init) => {
      if (url.endsWith('/enroll')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            enrollment: { drive_pseudonym: PSEUDONYM, id: 'e1' },
          }),
        };
      }

      if (url.endsWith('/key') && init?.method === 'PUT') {
        puts.push(String(init.body));

        return { ok: true, status: 200, json: async () => ({}) };
      }

      if (url.endsWith('/key')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ envelope: stored }),
        };
      }

      return undefined;
    });

    const { driveKey } = await setUpVaultForDrive({
      keys,
      driveSubject: 'did:ad:drive',
      agentSubject: 'did:ad:agent:x',
      agentSecret: AGENT_SECRET,
    });

    expect(Array.from(driveKey)).toEqual(Array.from(new Uint8Array(32).fill(99)));
    expect(puts).toHaveLength(0);
  });

  it('stores the wrapped key before anything is backed up', async () => {
    const keys = fakeKeys();
    const puts: string[] = [];

    mockFetch((url, init) => {
      if (url.endsWith('/enroll')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            enrollment: { drive_pseudonym: PSEUDONYM, id: 'e1' },
          }),
        };
      }

      if (url.endsWith('/key') && init?.method === 'PUT') {
        puts.push(String(init.body));

        return { ok: true, status: 200, json: async () => ({}) };
      }

      // No key stored yet.
      if (url.endsWith('/key')) return { ok: true, status: 204 };

      return undefined;
    });

    const { driveKey } = await setUpVaultForDrive({
      keys,
      driveSubject: 'did:ad:drive',
      agentSubject: 'did:ad:agent:x',
      agentSecret: AGENT_SECRET,
    });

    expect(puts).toHaveLength(1);
    // The wrapped form must actually contain this key, or restore gets a
    // different one back.
    expect(keys.vaultUnwrapKey(JSON.parse(puts[0]).envelope, AGENT_SECRET)).toEqual(
      driveKey,
    );
  });

  /** The wiped-device path, end to end through the client. */
  it('recovers a key from the control plane with only the agent secret', async () => {
    const keys = fakeKeys();
    const original = new Uint8Array(32).fill(7);
    const envelope = keys.vaultWrapKey(original, AGENT_SECRET);

    mockFetch(url =>
      url.endsWith('/key')
        ? { ok: true, status: 200, json: async () => ({ envelope }) }
        : undefined,
    );

    const recovered = await recoverDriveKey({
      keys,
      drivePseudonym: PSEUDONYM,
      agentSecret: AGENT_SECRET,
    });

    expect(Array.from(recovered)).toEqual(Array.from(original));
  });

  /**
   * Two clients enrolling the same drive at once would each mint a key and race
   * to store it. The server is create-only, so the loser must adopt the
   * winner's key — anything else leaves one client's backups undecryptable by
   * the other.
   */
  it('adopts the winner\'s key when another client stored one first', async () => {
    const keys = fakeKeys();
    const winnersKey = new Uint8Array(32).fill(42);
    const stored = keys.vaultWrapKey(winnersKey, AGENT_SECRET);
    let sawPut = false;

    mockFetch((url, init) => {
      if (url.endsWith('/enroll')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            enrollment: { drive_pseudonym: PSEUDONYM, id: 'e1' },
          }),
        };
      }

      if (url.endsWith('/key') && init?.method === 'PUT') {
        sawPut = true;

        // Create-only: the other client got there first.
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: 'a key envelope already exists' }),
        };
      }

      if (url.endsWith('/key')) {
        // First read: nothing yet. Second read (after the conflict): the winner.
        return sawPut
          ? { ok: true, status: 200, json: async () => ({ envelope: stored }) }
          : { ok: true, status: 204 };
      }

      return undefined;
    });

    const { driveKey } = await setUpVaultForDrive({
      keys,
      driveSubject: 'did:ad:drive',
      agentSubject: 'did:ad:agent:x',
      agentSecret: AGENT_SECRET,
    });

    expect(Array.from(driveKey)).toEqual(Array.from(winnersKey));
  });

  /**
   * A present-but-unusable envelope must not read as "no key yet" — the caller
   * would mint a second key and overwrite the real one, making every existing
   * backup undecryptable.
   */
  it('refuses a malformed stored envelope rather than treating it as absent', async () => {
    mockFetch(url =>
      url.endsWith('/key')
        ? { ok: true, status: 200, json: async () => ({ envelope: '' }) }
        : undefined,
    );

    await expect(
      recoverDriveKey({
        keys: fakeKeys(),
        drivePseudonym: PSEUDONYM,
        agentSecret: AGENT_SECRET,
      }),
    ).rejects.toThrow(/malformed/i);
  });

  it('says so plainly when a drive has no stored key', async () => {
    mockFetch(url => (url.endsWith('/key') ? { ok: true, status: 204 } : undefined));

    await expect(
      recoverDriveKey({
        keys: fakeKeys(),
        drivePseudonym: PSEUDONYM,
        agentSecret: AGENT_SECRET,
      }),
    ).rejects.toThrow(/no stored vault key/i);
  });
});

describe('lane bookkeeping', () => {
  /**
   * Sealing parks the lane's progress; only a confirmed upload makes it
   * official. Committing earlier would let a failed upload convince the next
   * pass that a segment exists in the vault when it does not.
   */
  it('commits the segment only after the upload is confirmed', async () => {
    const order: string[] = [];
    const db: VaultCapableDb = {
      vaultExport: vi.fn(async () => sealedPack(PACK_KEY)),
      vaultImport: vi.fn(),
      vaultCommitSegment: vi.fn(() => {
        order.push('commit');
      }),
    };
    mockFetch(url => {
      if (url.endsWith('/upload-urls')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            uploads: [
              {
                object_id: 'obj-1',
                object_key: PACK_KEY,
                url: 'https://s3.test/put',
                method: 'PUT',
                headers: [],
                size_bytes: 4,
              },
            ],
          }),
        };
      }

      if (url.endsWith('/confirm-upload')) order.push('confirm');

      if (url === 'https://s3.test/put') order.push('put');

      return undefined;
    });

    await backupDrive({
      db,
      driveSubject: 'did:ad:drive',
      drivePseudonym: PSEUDONYM,
      devicePubkey: DEVICE,
      driveKey: KEY,
      segment: 3,
    });

    expect(order).toEqual(['put', 'confirm', 'commit']);
    expect(db.vaultCommitSegment).toHaveBeenCalledWith(PSEUDONYM, DEVICE, 3);
  });

  it('does not commit a segment whose upload failed', async () => {
    const db: VaultCapableDb = {
      vaultExport: vi.fn(async () => sealedPack(PACK_KEY)),
      vaultImport: vi.fn(),
      vaultCommitSegment: vi.fn(),
    };
    mockFetch(url => {
      if (url.endsWith('/upload-urls')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            uploads: [
              {
                object_id: 'obj-1',
                object_key: PACK_KEY,
                url: 'https://s3.test/put',
                method: 'PUT',
                headers: [],
                size_bytes: 4,
              },
            ],
          }),
        };
      }

      if (url === 'https://s3.test/put') {
        return { ok: false, status: 500, json: async () => ({}) };
      }

      return undefined;
    });

    await expect(
      backupDrive({
        db,
        driveSubject: 'did:ad:drive',
        drivePseudonym: PSEUDONYM,
        devicePubkey: DEVICE,
        driveKey: KEY,
        segment: 3,
      }),
    ).rejects.toThrow();

    expect(db.vaultCommitSegment).not.toHaveBeenCalled();
  });

  it('reports a missing upload URL rather than crashing on undefined', async () => {
    const db: VaultCapableDb = {
      vaultExport: vi.fn(async () => sealedPack(PACK_KEY)),
      vaultImport: vi.fn(),
      vaultCommitSegment: vi.fn(),
    };
    mockFetch(url =>
      url.endsWith('/upload-urls')
        ? { ok: true, status: 200, json: async () => ({ uploads: [] }) }
        : undefined,
    );

    await expect(
      backupDrive({
        db,
        driveSubject: 'did:ad:drive',
        drivePseudonym: PSEUDONYM,
        devicePubkey: DEVICE,
        driveKey: KEY,
        segment: 1,
      }),
    ).rejects.toThrow(/no upload URL/i);
  });
});

describe('scheduling', () => {
  function state(lanes: Record<string, number>, status = 'active'): VaultDriveState {
    return {
      enrollment: {
        id: 'e1',
        drive_subject: 'did:ad:drive',
        drive_pseudonym: PSEUDONYM,
        status,
        used_bytes: 0,
        quota_bytes: 100,
        last_backup_at: null,
      },
      lanes,
      pending_uploads: 0,
      confirmed_objects: 0,
    };
  }

  it('starts at segment 1 on a lane that has never been written', () => {
    expect(nextSegmentFor(state({}), DEVICE)).toBe(1);
  });

  /**
   * Taken from the server, not from memory: a device that cleared its storage
   * would otherwise restart at 1 and overwrite a pack that is still the only
   * copy of some history.
   */
  it('continues after the last segment the server saw', () => {
    expect(nextSegmentFor(state({ [DEVICE]: 7 }), DEVICE)).toBe(8);
  });

  it('numbers each device lane independently', () => {
    const other = 'ff'.repeat(32);
    expect(nextSegmentFor(state({ [other]: 9 }), DEVICE)).toBe(1);
  });

  /**
   * Two passes at once would both read the same "next" segment and race to
   * write it; the loser's history would be silently overwritten.
   */
  it('runs one pass at a time per drive', async () => {
    let exports = 0;
    const db: VaultCapableDb = {
      vaultExport: vi.fn(async () => {
        exports += 1;
        await new Promise(resolve => setTimeout(resolve, 10));

        return null;
      }),
      vaultImport: vi.fn(),
      vaultCommitSegment: vi.fn(),
    };
    mockFetch(url =>
      url.endsWith('/state')
        ? { ok: true, status: 200, json: async () => state({}) }
        : undefined,
    );

    const args = {
      db,
      driveSubject: 'did:ad:drive',
      drivePseudonym: PSEUDONYM,
      devicePubkey: DEVICE,
      driveKey: KEY,
    };
    const [a, b] = await Promise.all([
      runVaultBackup(args),
      runVaultBackup(args),
    ]);

    expect(exports).toBe(1);
    expect(a).toBe(b);
  });

  it('allows a fresh pass once the previous one finished', async () => {
    let exports = 0;
    const db: VaultCapableDb = {
      vaultExport: vi.fn(async () => {
        exports += 1;

        return null;
      }),
      vaultImport: vi.fn(),
      vaultCommitSegment: vi.fn(),
    };
    mockFetch(url =>
      url.endsWith('/state')
        ? { ok: true, status: 200, json: async () => state({}) }
        : undefined,
    );

    const args = {
      db,
      driveSubject: 'did:ad:drive',
      drivePseudonym: PSEUDONYM,
      devicePubkey: DEVICE,
      driveKey: KEY,
    };
    await runVaultBackup(args);
    await runVaultBackup(args);

    expect(exports).toBe(2);
  });

  /** A suspended vault refuses uploads; asking every tick just buries the log. */
  it('does not attempt a backup while the vault is suspended', async () => {
    const db: VaultCapableDb = {
      vaultExport: vi.fn(),
      vaultImport: vi.fn(),
      vaultCommitSegment: vi.fn(),
    };
    mockFetch(url =>
      url.endsWith('/state')
        ? { ok: true, status: 200, json: async () => state({}, 'suspended') }
        : undefined,
    );

    const outcome = await runVaultBackup({
      db,
      driveSubject: 'did:ad:drive',
      drivePseudonym: PSEUDONYM,
      devicePubkey: DEVICE,
      driveKey: KEY,
    });

    expect(outcome).toEqual({ status: 'nothing-to-do' });
    expect(db.vaultExport).not.toHaveBeenCalled();
  });
});

describe('agentSecretBytes', () => {
  /**
   * The exact confusion this exists to prevent: the full secret blob is a
   * base64 JSON object, not a key. Wrapping under it succeeds and then the
   * envelope can never be opened with the real seed.
   */
  it('rejects the full secret blob', () => {
    const blob = btoa(
      JSON.stringify({ privateKey: 'x'.repeat(43), subject: 'did:ad:agent:a' }),
    );
    expect(() => agentSecretBytes(blob)).toThrow(/32-byte agent key seed/);
  });

  it('accepts a real 32-byte key', () => {
    const seed = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
    expect(agentSecretBytes(seed)).toHaveLength(32);
  });
});

describe('vaultLaneId', () => {
  /** The control plane validates the shape: 64 lowercase hex characters. */
  it('produces the shape the control plane accepts', async () => {
    const id = await vaultLaneId('device-a');
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for one install and distinct between installs', async () => {
    expect(await vaultLaneId('device-a')).toBe(await vaultLaneId('device-a'));
    expect(await vaultLaneId('device-a')).not.toBe(await vaultLaneId('device-b'));
  });
});
