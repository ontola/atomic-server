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
 * Hashing, chunking, sealing and opening are Rust (`atomic_lib::vault::sync`,
 * tested there, including the two-vault and corruption cases). These cover
 * what only TypeScript does: which requests go out in which order, that only
 * sealed bytes are uploaded, which ids `retain-blobs` is told are live and
 * when, and how a restore counts what it found.
 */

const PSEUDONYM = 'testpseudonym';
const DEVICE = '03'.repeat(32);
const HASH_A = 'aa'.repeat(32);
const HASH_B = 'bb'.repeat(32);
const CHUNK = 4;
const OVERHEAD = 46;
const SEALED = 0x5e;

/** What the vault calls a file: unrelated to its plain hash. */
const idOf = (hash: string) => `1d${hash.slice(2)}`;

const key = (id: string, n: number) =>
  `vault/${PSEUDONYM}/blobs/${id}/${String(n).padStart(6, '0')}`;

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
    vaultBlobOpen: vi.fn(
      async (
        hash: string,
        _key: Uint8Array,
        _epoch: number,
      ): Promise<VaultBlobPlan> => {
        opened.push(hash);
        open = hash;
        const bytes = local.get(hash);

        if (!bytes)
          return { status: 'missing', size: 0, blobId: '', chunks: [] };

        return {
          status: 'ready',
          size: bytes.length,
          blobId: idOf(hash),
          chunks: Array.from(
            { length: Math.ceil(bytes.length / CHUNK) },
            (_, i) => {
              const length = Math.min(CHUNK, bytes.length - i * CHUNK);

              return {
                index: i,
                offset: i * CHUNK,
                length,
                sealedLength: length + OVERHEAD,
              };
            },
          ),
        };
      },
    ),
    vaultBlobChunk: vi.fn(
      async (hash: string, _key: Uint8Array, _epoch: number, i: number) => {
        expect(open).toBe(hash);
        const plain = local.get(hash)!.slice(i * CHUNK, (i + 1) * CHUNK);

        return new Uint8Array(plain.length + OVERHEAD).fill(SEALED);
      },
    ),
    vaultBlobClose: vi.fn(async () => {
      open = null;
    }),
    // The real work (decrypt, plain BLAKE3, match to a wanted hash) is Rust. A
    // chunk starting with 0xff stands for one that does not open.
    vaultBlobRestore: vi.fn(
      async (
        _key: Uint8Array,
        _epoch: number,
        blobId: string,
        chunks: Uint8Array[],
        wanted: string[],
      ) => {
        if (chunks.some(c => c[0] === 0xff)) {
          return { status: 'unreadable' as const };
        }

        const hash = [HASH_A, HASH_B, 'cc'.repeat(32)].find(
          h => idOf(h) === blobId,
        );

        if (!hash || !wanted.includes(hash)) {
          return { status: 'unreferenced' as const };
        }

        restored.set(hash, chunks);
        local.set(hash, new Uint8Array(0));

        return { status: 'restored' as const, hash };
      },
    ),
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
  putStatus: number;
  downloads: Record<string, Uint8Array | number>;
  retain: string[][];
};

function portal(overrides: Partial<Portal> = {}): Portal {
  const state: Portal = {
    calls: [],
    objects: [],
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

        return json({
          uploads: objects.map(o => {
            const object_key = key(o.content_hash, o.chunk_index);
            const existing = state.objects.find(
              e => e.object_key === object_key,
            );

            return {
              object_id:
                existing?.object_id ??
                `id-${o.content_hash.slice(0, 2)}-${o.chunk_index}`,
              object_key,
              url: existing ? '' : `https://s3.test/${object_key}`,
              method: 'PUT',
              headers: [['content-length', String(o.size_bytes)]],
              size_bytes: o.size_bytes,
              already_stored: Boolean(existing),
            };
          }),
        });
      }

      if (url.endsWith('/confirm-upload')) {
        return json({ confirmed: body.confirmations.length, used_bytes: 0 });
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

/** A `localStorage` that survives between passes within one test. */
function stubStorage() {
  const data = new Map<string, string>();

  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  });
}

beforeEach(() => {
  vi.stubEnv('VITE_MANAGED_PORTAL_URL', 'https://control.test');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const stored = (hash: string, n: number) => ({
  object_id: `x${hash.slice(0, 2)}${n}`,
  object_key: key(idOf(hash), n),
  kind: 'blob',
  size_bytes: CHUNK + OVERHEAD,
  content_hash: idOf(hash),
});

describe('backing up file bytes', () => {
  it('uploads sealed chunks under the per-vault id and confirms them together', async () => {
    const db = fakeDb({ [HASH_A]: new Uint8Array(10).fill(1) });
    const p = portal();

    const outcome = await backupDrive({ db, ...PASS });

    expect(outcome).toMatchObject({
      status: 'nothing-to-do',
      blobs: { uploaded: 1, bytesUploaded: 10 + 3 * OVERHEAD },
    });
    expect(db.vaultBlobOpen).toHaveBeenCalledWith(HASH_A, PASS.driveKey, 1);

    const upload = urls(p, '/upload-urls')[0].body as {
      objects: Record<string, unknown>[];
    };
    // The control plane is told the id (never the plain hash) and the sealed
    // size; no chunk count, no proof.
    expect(upload.objects).toEqual(
      [0, 1, 2].map(i => ({
        kind: 'blob',
        size_bytes: (i === 2 ? 2 : 4) + OVERHEAD,
        key_epoch: 1,
        content_hash: idOf(HASH_A),
        chunk_index: i,
      })),
    );
    expect(JSON.stringify(p.calls)).not.toContain(HASH_A);

    const puts = p.calls.filter(c => c.method === 'PUT');
    expect(puts.map(c => c.url)).toEqual(
      [0, 1, 2].map(i => `https://s3.test/${key(idOf(HASH_A), i)}`),
    );

    // Ciphertext only: every body is the sealed chunk, never the plaintext.
    for (const put of puts) {
      expect(put.headers).toEqual({});
      expect((put.body as Uint8Array)[0]).toBe(SEALED);
    }

    const confirms = urls(p, '/confirm-upload');
    expect(confirms).toHaveLength(1);
    expect(confirms[0].body).toEqual({
      confirmations: [0, 1, 2].map(i => ({
        object_id: `id-1d-${i}`,
        size_bytes: (i === 2 ? 2 : 4) + OVERHEAD,
        content_hash: idOf(HASH_A),
      })),
    });
    expect(db.vaultBlobClose).toHaveBeenCalled();
  });

  it('never publishes a live set during an ordinary backup', async () => {
    const db = fakeDb({ [HASH_A]: new Uint8Array(4) });
    const p = portal();

    const outcome = await backupDrive({ db, ...PASS });

    expect(outcome.blobs).toMatchObject({ uploaded: 1, retained: false });
    expect(urls(p, '/retain-blobs')).toHaveLength(0);
  });

  it('publishes the live ids, last, when an explicit compress asks for it', async () => {
    const db = fakeDb({
      [HASH_A]: new Uint8Array(4),
      [HASH_B]: new Uint8Array(4),
    });
    const p = portal();

    const outcome = await backupDrive({ db, ...PASS, retainBlobs: true });

    expect(outcome.blobs).toMatchObject({ uploaded: 2, retained: true });
    expect(p.calls.at(-1)!.url).toMatch(/\/retain-blobs$/);
    expect(p.retain).toEqual([[idOf(HASH_A), idOf(HASH_B)]]);
  });

  it('does not publish a live set when this device lacks a referenced file', async () => {
    // B is referenced but neither on this device nor known: its id is unknown,
    // so leaving it out of the set could start the delete clock on a file
    // another device uses.
    const db = fakeDb({ [HASH_A]: new Uint8Array(4) }, [HASH_A, HASH_B]);
    const p = portal();

    const outcome = await backupDrive({ db, ...PASS, retainBlobs: true });

    expect(outcome.blobs).toMatchObject({
      uploaded: 1,
      missing: 1,
      retained: false,
    });
    expect(urls(p, '/retain-blobs')).toHaveLength(0);
  });

  it('publishes an empty live set once every file is gone, so references drop', async () => {
    const db = fakeDb({}, []);
    const p = portal();

    await backupDrive({ db, ...PASS, retainBlobs: true });

    expect(p.retain).toEqual([[]]);
  });

  it('does not read, upload or confirm a file this vault already holds', async () => {
    const db = fakeDb({ [HASH_A]: new Uint8Array(10) });
    const p = portal({ objects: [0, 1, 2].map(i => stored(HASH_A, i)) });

    const outcome = await backupDrive({ db, ...PASS });

    // The id needs the bytes, so the file is read once to learn it...
    expect(db.vaultBlobOpen).toHaveBeenCalledTimes(1);
    expect(outcome.blobs).toMatchObject({ alreadyStored: 1, uploaded: 0 });
    expect(p.calls.filter(c => c.method === 'PUT')).toHaveLength(0);
    expect(urls(p, '/confirm-upload')).toHaveLength(0);
  });

  it('remembers ids so a later pass does not read files again', async () => {
    stubStorage();
    const db = fakeDb({ [HASH_A]: new Uint8Array(10).fill(1) });
    const p = portal();

    await backupDrive({ db, ...PASS });
    // The vault now lists what the first pass uploaded.
    p.objects = [0, 1, 2].map(i => stored(HASH_A, i));
    db.vaultBlobOpen.mockClear();
    const second = await backupDrive({ db, ...PASS, retainBlobs: true });

    expect(db.vaultBlobOpen).not.toHaveBeenCalled();
    expect(second.blobs).toMatchObject({ alreadyStored: 1, uploaded: 0 });
    // Known without the bytes, so this device can still publish a full set.
    expect(p.retain).toEqual([[idOf(HASH_A)]]);
  });

  it('sends only the chunks the vault does not hold yet', async () => {
    const db = fakeDb({ [HASH_A]: new Uint8Array(10).fill(1) });
    const p = portal({ objects: [stored(HASH_A, 0)] });

    const outcome = await backupDrive({ db, ...PASS });

    expect(outcome.blobs).toMatchObject({ uploaded: 1 });
    expect(p.calls.filter(c => c.method === 'PUT').map(c => c.url)).toEqual(
      [1, 2].map(i => `https://s3.test/${key(idOf(HASH_A), i)}`),
    );
    expect(
      (urls(p, '/confirm-upload')[0].body as { confirmations: unknown[] })
        .confirmations,
    ).toHaveLength(2);
  });

  it('fails when a PUT is rejected and confirms nothing', async () => {
    const db = fakeDb({ [HASH_A]: new Uint8Array(4) });
    const p = portal({ putStatus: 500 });

    await expect(
      backupDrive({ db, ...PASS, retainBlobs: true }),
    ).rejects.toThrow('Vault file upload failed (500)');

    expect(urls(p, '/confirm-upload')).toHaveLength(0);
    expect(p.retain).toHaveLength(0);
    // Still released, so the next file read starts clean.
    expect(db.vaultBlobClose).toHaveBeenCalled();
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
  });

  it('reports files too large for a vault and leaves them out of the live set', async () => {
    const db = fakeDb({ [HASH_A]: new Uint8Array(4) });
    db.vaultBlobOpen.mockResolvedValueOnce({
      status: 'tooLarge',
      size: 1e12,
      blobId: '',
      chunks: [],
    });
    const p = portal();

    const outcome = await backupDrive({ db, ...PASS, retainBlobs: true });

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

    await expect(
      backupDrive({ db, ...PASS, retainBlobs: true }),
    ).resolves.toMatchObject({ blobs: { uploaded: 1, retained: false } });
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
    Array.from({ length: n }, (_, i) => stored(hash, i));
  const history = {
    object_id: 'seg',
    object_key: `vault/${PSEUDONYM}/lanes/${DEVICE}/seg-000001.pack`,
    kind: 'pack',
    size_bytes: 8,
  };
  const restoreArgs = {
    driveSubject: 'did:ad:drive',
    drivePseudonym: PSEUDONYM,
    devicePubkey: DEVICE,
    driveKey: new Uint8Array(32).fill(7),
  };

  it('hands only sealed history to the importer, then opens each stored file and matches it by hash', async () => {
    const db = fakeDb({}, [HASH_A]);
    db.vaultBlobPresent.mockResolvedValue(false);
    const p = portal({
      objects: [history, ...objects(HASH_A, 2), ...objects(HASH_B, 1)],
      downloads: {
        [history.object_key]: new Uint8Array(8),
        [key(idOf(HASH_A), 0)]: new Uint8Array(4).fill(1),
        [key(idOf(HASH_A), 1)]: new Uint8Array(2).fill(2),
        [key(idOf(HASH_B), 0)]: new Uint8Array(4).fill(3),
      },
    });

    const outcome = await restoreDrive({ db, ...restoreArgs });

    const imported = (db.vaultImport.mock.calls[0] as unknown[])[4] as {
      objectKey: string;
    }[];
    expect(imported.map(o => o.objectKey)).toEqual([history.object_key]);
    expect(db.vaultBlobRestore).toHaveBeenCalledWith(
      restoreArgs.driveKey,
      1,
      idOf(HASH_A),
      [new Uint8Array(4).fill(1), new Uint8Array(2).fill(2)],
      [HASH_A],
    );
    expect(outcome).toMatchObject({
      resourcesRestored: 2,
      blobs: { restored: 1, present: 0, missing: 0, unreadable: 0 },
    });
    // Everything wanted is back, so the rest of the vault is not downloaded.
    expect(p.calls.some(c => c.url.includes(idOf(HASH_B)))).toBe(false);
    expect(db.restored.get(HASH_A)).toHaveLength(2);
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
        // C downloads but does not open; D's chunk is gone from storage.
        [key(idOf(hashC), 0)]: new Uint8Array(4).fill(0xff),
        [key(idOf(hashD), 0)]: 404,
      },
    });

    const outcome = await restoreDrive({ db, ...restoreArgs });

    // A is on this device, B was never uploaded, C and D cannot be read: three
    // wanted files are still absent, two of which are explained as unreadable.
    expect(outcome.blobs).toEqual({
      restored: 0,
      present: 1,
      missing: 1,
      unreadable: 2,
    });
  });

  it('counts a stored file with a gap in its chunks as unreadable without downloading it', async () => {
    const db = fakeDb({}, [HASH_A]);
    db.vaultBlobPresent.mockResolvedValue(false);
    const p = portal({
      objects: [history, stored(HASH_A, 0), stored(HASH_A, 2)],
      downloads: { [history.object_key]: new Uint8Array(8) },
    });

    const outcome = await restoreDrive({ db, ...restoreArgs });

    expect(outcome.blobs).toMatchObject({ restored: 0, unreadable: 1 });
    expect(db.vaultBlobRestore).not.toHaveBeenCalled();
    expect(p.calls.some(c => c.url.includes(idOf(HASH_A)))).toBe(false);
  });

  it('does not restore files from a backup file source', async () => {
    const db = fakeDb({}, [HASH_A]);
    const p = portal();

    const outcome = await restoreDrive({
      db,
      ...restoreArgs,
      source: async () => [
        { objectKey: history.object_key, sealed: new Uint8Array(8) },
      ],
    });

    expect(outcome.blobs).toBeUndefined();
    expect(p.calls).toHaveLength(0);
  });
});
