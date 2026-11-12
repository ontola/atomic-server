import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  backupDrive,
  restoreDrive,
  type VaultBlobDb,
  type VaultBlobPlan,
  type VaultCapableDb,
} from './vault';

/**
 * File bytes through the hosted client, against a mocked control plane.
 *
 * Chunking, hashing and the proof answers are Rust (`atomic_lib::vault::sync`,
 * tested there). These cover what only TypeScript does: which requests go out
 * in which order, what a claim, a 412 or a failed PUT leads to, which hashes
 * `retain-blobs` is told are live, and how a restore counts what it found.
 */

const PSEUDONYM = 'testpseudonym';
const DEVICE = '03'.repeat(32);
const HASH_A = 'aa'.repeat(32);
const HASH_B = 'bb'.repeat(32);
const CHUNK = 4;

const key = (hash: string, n: number) =>
  `vault-blobs/${hash}/${String(n).padStart(6, '0')}`;

const PASS = {
  driveSubject: 'did:ad:drive',
  drivePseudonym: PSEUDONYM,
  devicePubkey: DEVICE,
  driveKey: new Uint8Array(32).fill(7),
  segment: 1,
  checkpointN: 1,
  driveHasCheckpoint: true,
  observedLanes: {},
};

type Call = { url: string; method: string; body?: unknown; headers?: unknown };

/** A db whose files are cut into 4-byte chunks. Only one file is open at once. */
function fakeDb(
  files: Record<string, Uint8Array>,
  referenced = Object.keys(files),
) {
  let open: string | null = null;
  const local = new Map(Object.entries(files));
  const opened: string[] = [];
  const restored = new Map<string, Uint8Array[]>();
  const db = {
    vaultExport: vi.fn(async () => null),
    vaultImport: vi.fn(async () => ({
      packsRead: 1,
      resourcesRestored: 2,
      tombstonesApplied: 0,
      objectsSkipped: 0,
      objectsUnreadable: 0,
    })),
    vaultCommitSegment: vi.fn(),
    vaultFileHashes: vi.fn(async () => referenced),
    vaultBlobPresent: vi.fn(async (hash: string) => local.has(hash)),
    vaultBlobOpen: vi.fn(async (hash: string): Promise<VaultBlobPlan> => {
      opened.push(hash);
      open = hash;
      const bytes = local.get(hash);

      if (!bytes) return { status: 'missing', size: 0, chunks: [] };

      return {
        status: 'ready',
        size: bytes.length,
        chunks: Array.from(
          { length: Math.ceil(bytes.length / CHUNK) },
          (_, i) => ({
            index: i,
            offset: i * CHUNK,
            length: Math.min(CHUNK, bytes.length - i * CHUNK),
          }),
        ),
      };
    }),
    vaultBlobChunk: vi.fn(async (hash: string, i: number) => {
      expect(open).toBe(hash);

      return local.get(hash)!.slice(i * CHUNK, (i + 1) * CHUNK);
    }),
    vaultBlobProof: vi.fn(
      async (hash: string, ranges: { chunkIndex: number }[]) => {
        expect(open).toBe(hash);

        return ranges.map(r => `proof-${hash.slice(0, 2)}-${r.chunkIndex}`);
      },
    ),
    vaultBlobClose: vi.fn(async () => {
      open = null;
    }),
    vaultBlobRestore: vi.fn(async (hash: string, chunks: Uint8Array[]) => {
      // The real check is the BLAKE3 in Rust; here a chunk of 0xff is "corrupt".
      if (chunks.some(c => c[0] === 0xff)) return false;

      restored.set(hash, chunks);
      local.set(hash, new Uint8Array(0));

      return true;
    }),
  } satisfies VaultCapableDb & VaultBlobDb;

  return Object.assign(db, { opened, restored });
}

type Portal = {
  calls: Call[];
  /** Objects this vault already references, as `list-objects` returns them. */
  objects: {
    object_id: string;
    object_key: string;
    kind: string;
    size_bytes: number;
    content_hash?: string;
  }[];
  /** What the next upload-urls says for a hash. */
  challenge: Record<string, boolean>;
  putStatus: number;
  downloads: Record<string, Uint8Array | number>;
  retain: string[][];
};

function portal(overrides: Partial<Portal> = {}): Portal {
  const state: Portal = {
    calls: [],
    objects: [],
    challenge: {},
    putStatus: 200,
    downloads: {},
    retain: [],
    ...overrides,
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;

      state.calls.push({ url, method, body, headers: init?.headers });
      const json = (value: unknown) =>
        ({ ok: true, status: 200, json: async () => value }) as Response;

      if (url.endsWith('/objects')) return json(state.objects);

      if (url.endsWith('/upload-urls')) {
        const objects = body.objects as {
          content_hash: string;
          chunk_index: number;
          size_bytes: number;
        }[];
        const hashes = [...new Set(objects.map(o => o.content_hash))];

        return json({
          uploads: objects
            .filter(o => !state.challenge[o.content_hash])
            .map(o => ({
              object_id: `id-${o.content_hash.slice(0, 2)}-${o.chunk_index}`,
              object_key: key(o.content_hash, o.chunk_index),
              url: `https://s3.test/${key(o.content_hash, o.chunk_index)}`,
              method: 'PUT',
              headers: [['content-length', String(o.size_bytes)]],
              size_bytes: o.size_bytes,
              already_stored: false,
            })),
          blob_proofs: hashes
            .filter(h => state.challenge[h])
            .map(h => ({
              content_hash: h,
              token: `token-${h.slice(0, 2)}`,
              expires_at: 1,
              ranges: [{ chunk_index: 0, offset: 1, length: 2 }],
            })),
        });
      }

      if (url.endsWith('/confirm-upload')) {
        return json({
          confirmed: body.confirmations.length,
          claimed_blobs: body.blob_proofs.length,
          used_bytes: 0,
        });
      }

      if (url.endsWith('/retain-blobs')) {
        state.retain.push(body.hashes);

        return json({
          retained: body.hashes.length,
          marked_unused: 0,
          unknown_hashes: 0,
        });
      }

      if (url.endsWith('/download-urls')) {
        return json({
          downloads: (body.object_ids as string[]).map(id => {
            const object = state.objects.find(o => o.object_id === id)!;

            return {
              object_id: id,
              object_key: object.object_key,
              url: `https://s3.test/${object.object_key}`,
            };
          }),
        });
      }

      if (url.startsWith('https://s3.test/') && method === 'PUT') {
        return {
          ok: state.putStatus < 400,
          status: state.putStatus,
        } as Response;
      }

      if (url.startsWith('https://s3.test/')) {
        const bytes = state.downloads[url.replace('https://s3.test/', '')];

        if (typeof bytes === 'number')
          return { ok: false, status: bytes } as Response;

        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => bytes!.buffer,
        } as Response;
      }

      return json({});
    }),
  );

  return state;
}

const urls = (p: Portal, suffix: string) =>
  p.calls.filter(c => c.url.endsWith(suffix));

beforeEach(() => {
  vi.stubEnv('VITE_MANAGED_PORTAL_URL', 'https://control.test');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('backing up file bytes', () => {
  it('uploads each chunk create-only, confirms them together, then retains the live set', async () => {
    const db = fakeDb({ [HASH_A]: new Uint8Array(10).fill(1) });
    const p = portal();

    const outcome = await backupDrive({ db, ...PASS });

    expect(outcome).toMatchObject({
      status: 'nothing-to-do',
      blobs: { uploaded: 1, claimed: 0, bytesUploaded: 10 },
    });

    const upload = urls(p, '/upload-urls')[0].body as {
      objects: Record<string, unknown>[];
    };
    expect(upload.objects).toEqual(
      [0, 1, 2].map(i => ({
        kind: 'blob',
        size_bytes: i === 2 ? 2 : 4,
        key_epoch: 1,
        content_hash: HASH_A,
        chunk_index: i,
        chunk_count: 3,
      })),
    );

    const puts = p.calls.filter(c => c.method === 'PUT');
    expect(puts.map(c => c.url)).toEqual(
      [0, 1, 2].map(i => `https://s3.test/${key(HASH_A, i)}`),
    );
    expect(puts[0].headers).toEqual({ 'if-none-match': '*' });

    const confirms = urls(p, '/confirm-upload');
    expect(confirms).toHaveLength(1);
    expect(
      (confirms[0].body as { confirmations: unknown[] }).confirmations,
    ).toEqual(
      [0, 1, 2].map(i => ({
        object_id: `id-aa-${i}`,
        size_bytes: i === 2 ? 2 : 4,
        content_hash: HASH_A,
      })),
    );

    // Confirmed before the live set is published, and the live set is last.
    expect(p.calls.at(-1)!.url).toMatch(/\/retain-blobs$/);
    expect(p.retain).toEqual([[HASH_A]]);
    expect(db.vaultBlobClose).toHaveBeenCalled();
  });

  it('does not read, upload or confirm a file this vault already references', async () => {
    const db = fakeDb({ [HASH_A]: new Uint8Array(10) });
    const p = portal({
      objects: [0, 1, 2].map(i => ({
        object_id: `x${i}`,
        object_key: key(HASH_A, i),
        kind: 'blob',
        size_bytes: 4,
        content_hash: HASH_A,
      })),
    });

    const outcome = await backupDrive({ db, ...PASS });

    expect(outcome.blobs).toMatchObject({ alreadyStored: 1, uploaded: 0 });
    expect(db.vaultBlobOpen).not.toHaveBeenCalled();
    expect(urls(p, '/upload-urls')).toHaveLength(0);
    expect(p.retain).toEqual([[HASH_A]]);
  });

  it('claims a file another vault stored by answering the challenge from its own copy', async () => {
    const db = fakeDb({ [HASH_A]: new Uint8Array(10).fill(1) });
    const p = portal({ challenge: { [HASH_A]: true } });

    const outcome = await backupDrive({ db, ...PASS });

    expect(outcome.blobs).toMatchObject({
      claimed: 1,
      uploaded: 0,
      bytesUploaded: 0,
    });
    expect(p.calls.filter(c => c.method === 'PUT')).toHaveLength(0);
    expect(db.vaultBlobProof).toHaveBeenCalledWith(HASH_A, [
      { chunkIndex: 0, offset: 1, length: 2 },
    ]);
    expect(urls(p, '/confirm-upload')[0].body).toEqual({
      confirmations: [],
      blob_proofs: [
        { content_hash: HASH_A, token: 'token-aa', hashes: ['proof-aa-0'] },
      ],
    });
    expect(p.retain).toEqual([[HASH_A]]);
  });

  it('treats 412 as "bytes already there" and still confirms', async () => {
    const db = fakeDb({ [HASH_A]: new Uint8Array(4) });
    const p = portal({ putStatus: 412 });

    const outcome = await backupDrive({ db, ...PASS });

    expect(outcome.blobs).toMatchObject({ uploaded: 1 });
    expect(urls(p, '/confirm-upload')).toHaveLength(1);
  });

  it('fails without publishing a live set when a PUT is rejected', async () => {
    const db = fakeDb({ [HASH_A]: new Uint8Array(4) });
    const p = portal({ putStatus: 500 });

    await expect(backupDrive({ db, ...PASS })).rejects.toThrow(
      'Vault file upload failed (500)',
    );

    expect(urls(p, '/confirm-upload')).toHaveLength(0);
    expect(p.retain).toHaveLength(0);
    // Still released, so the next file read starts clean.
    expect(db.vaultBlobClose).toHaveBeenCalled();
  });

  it('counts files this device lacks, and keeps only referenced ones live', async () => {
    // B is referenced by a File resource but not on this device, and the vault
    // has no copy either. A is not on this device but the vault holds it.
    const db = fakeDb({}, [HASH_A, HASH_B]);
    const p = portal({
      objects: [
        {
          object_id: 'a0',
          object_key: key(HASH_A, 0),
          kind: 'blob',
          size_bytes: 4,
          content_hash: HASH_A,
        },
      ],
    });

    const outcome = await backupDrive({ db, ...PASS });

    expect(outcome.blobs).toMatchObject({
      alreadyStored: 1,
      missing: 1,
      uploaded: 0,
    });
    // Dropping A here would remove this vault's reference to bytes only the
    // vault still has.
    expect(p.retain).toEqual([[HASH_A]]);
  });

  it('publishes an empty live set once every file is gone, so references drop', async () => {
    const db = fakeDb({}, []);
    const p = portal();

    await backupDrive({ db, ...PASS });

    expect(p.retain).toEqual([[]]);
  });

  it('batches files so one upload-urls call never exceeds 16 objects, and a file is never split', async () => {
    const files: Record<string, Uint8Array> = {};

    for (let i = 0; i < 4; i++) {
      files[i.toString(16).padStart(2, '0').repeat(32)] = new Uint8Array(
        CHUNK * 7,
      );
    }

    const db = fakeDb(files);
    const p = portal();

    await backupDrive({ db, ...PASS });

    const sizes = urls(p, '/upload-urls').map(
      c =>
        new Set(
          (c.body as { objects: { content_hash: string }[] }).objects.map(
            o => o.content_hash,
          ),
        ).size,
    );
    expect(sizes).toEqual([2, 2]);
    expect(p.retain[0]).toHaveLength(4);
  });

  it('reports files too large for a vault and leaves them out of the live set', async () => {
    const db = fakeDb({ [HASH_A]: new Uint8Array(4) });
    db.vaultBlobOpen.mockResolvedValueOnce({
      status: 'tooLarge',
      size: 1e12,
      chunks: [],
    });
    const p = portal();

    const outcome = await backupDrive({ db, ...PASS });

    expect(outcome.blobs).toMatchObject({ tooLarge: 1, uploaded: 0 });
    expect(p.retain).toEqual([[]]);
  });

  it('keeps a failed retain-blobs from failing a backup whose files are safe', async () => {
    const db = fakeDb({ [HASH_A]: new Uint8Array(4) });
    portal();
    const fetchMock = vi.mocked(fetch);
    const inner = fetchMock.getMockImplementation()!;

    fetchMock.mockImplementation(async (url, init) =>
      String(url).endsWith('/retain-blobs')
        ? ({
            ok: false,
            status: 500,
            json: async () => ({ error: 'boom' }),
          } as Response)
        : inner(url, init),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(backupDrive({ db, ...PASS })).resolves.toMatchObject({
      blobs: { uploaded: 1 },
    });
  });

  it('leaves a db without file support alone', async () => {
    const db: VaultCapableDb = {
      vaultExport: vi.fn(async () => null),
      vaultImport: vi.fn(),
      vaultCommitSegment: vi.fn(),
    };
    const p = portal();

    expect(await backupDrive({ db, ...PASS })).toEqual({
      status: 'nothing-to-do',
    });
    expect(p.calls).toHaveLength(0);
  });
});

describe('restoring file bytes', () => {
  const objects = (hash: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      object_id: `${hash.slice(0, 2)}${i}`,
      object_key: key(hash, i),
      kind: 'blob',
      size_bytes: 4,
      content_hash: hash,
    }));
  const history = {
    object_id: 'seg',
    object_key: `vault/${PSEUDONYM}/lanes/${DEVICE}/seg-000001.pack`,
    kind: 'pack',
    size_bytes: 8,
  };

  it('hands only sealed history to the importer, then restores each missing file', async () => {
    const db = fakeDb({}, [HASH_A]);
    db.vaultBlobPresent.mockResolvedValue(false);
    const p = portal({
      objects: [history, ...objects(HASH_A, 2)],
      downloads: {
        [history.object_key]: new Uint8Array(8),
        [key(HASH_A, 0)]: new Uint8Array(4).fill(1),
        [key(HASH_A, 1)]: new Uint8Array(2).fill(2),
      },
    });

    const outcome = await restoreDrive({
      db,
      driveSubject: 'did:ad:drive',
      drivePseudonym: PSEUDONYM,
      devicePubkey: DEVICE,
      driveKey: new Uint8Array(32),
    });

    const imported = db.vaultImport.mock.calls[0][4] as { objectKey: string }[];
    expect(imported.map(o => o.objectKey)).toEqual([history.object_key]);
    expect(db.vaultBlobRestore).toHaveBeenCalledWith(HASH_A, [
      new Uint8Array(4).fill(1),
      new Uint8Array(2).fill(2),
    ]);
    expect(outcome).toMatchObject({
      resourcesRestored: 2,
      blobs: { restored: 1, present: 0, missing: 0, unreadable: 0 },
    });
    expect(p.calls.some(c => c.url.includes(key(HASH_B, 0)))).toBe(false);
  });

  it('reports present, missing and unreadable files instead of hiding them', async () => {
    const hashC = 'cc'.repeat(32);
    const hashD = 'dd'.repeat(32);
    const db = fakeDb({ [HASH_A]: new Uint8Array(1) }, [
      HASH_A,
      HASH_B,
      hashC,
      hashD,
    ]);
    portal({
      objects: [history, ...objects(hashC, 1), ...objects(hashD, 1)],
      downloads: {
        [history.object_key]: new Uint8Array(8),
        // C downloads but fails the hash check; D's chunk is gone from storage.
        [key(hashC, 0)]: new Uint8Array(4).fill(0xff),
        [key(hashD, 0)]: 404,
      },
    });

    const outcome = await restoreDrive({
      db,
      driveSubject: 'did:ad:drive',
      drivePseudonym: PSEUDONYM,
      devicePubkey: DEVICE,
      driveKey: new Uint8Array(32),
    });

    // A is on this device, B was never uploaded, C and D cannot be read.
    expect(outcome.blobs).toEqual({
      restored: 0,
      present: 1,
      missing: 1,
      unreadable: 2,
    });
    expect(db.vaultBlobRestore).toHaveBeenCalledTimes(1);
  });

  it('does not restore files from a backup file or snapshot source', async () => {
    const db = fakeDb({}, [HASH_A]);
    const p = portal();

    const outcome = await restoreDrive({
      db,
      driveSubject: 'did:ad:drive',
      drivePseudonym: PSEUDONYM,
      devicePubkey: DEVICE,
      driveKey: new Uint8Array(32),
      source: async () => [
        { objectKey: history.object_key, sealed: new Uint8Array(8) },
      ],
    });

    expect(outcome.blobs).toBeUndefined();
    expect(p.calls).toHaveLength(0);
  });
});
