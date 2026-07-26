import { describe, expect, it, vi } from 'vitest';

import {
  isWrongKeyDbError,
  openClientDb,
  WRONG_KEY_MARKER,
} from './client-db-open.js';

const DB_NAME = 'atomic_data.a1b2c3d4e5f60718.redb';
const DB_KEY = new Uint8Array(32).fill(7);

/** The message `ClientDb::new` produces for an undecryptable OPFS file. */
const wrongKeyMessage =
  `OPFS unavailable [${WRONG_KEY_MARKER}]: Failed to open encrypted OPFS ` +
  'backend: wrong encryption key for local database';

/**
 * A stand-in for the generated WASM module. `openFailures` are thrown by the
 * first N constructor calls; later calls succeed with a marker object.
 */
function fakeWasm(openFailures: Error[]) {
  const opened: Array<{ dbName?: string; dbKey?: Uint8Array }> = [];
  const deleted: string[] = [];
  let call = 0;

  const wasm = {
    ClientDb: function (
      this: unknown,
      _baseUrl?: string,
      dbName?: string,
      dbKey?: Uint8Array,
    ) {
      opened.push({ dbName, dbKey });
      const failure = openFailures[call++];

      return failure
        ? Promise.reject(failure)
        : Promise.resolve({ handle: `db:${dbName}` });
    } as unknown as ClientDbCtor,
    deleteClientDb: vi.fn(async (dbName: string) => {
      deleted.push(dbName);

      return true;
    }),
  };

  return { wasm, opened, deleted };
}

type ClientDbCtor = new (
  baseUrl?: string,
  dbName?: string,
  dbKey?: Uint8Array,
) => Promise<unknown>;

describe('isWrongKeyDbError', () => {
  it('matches only the marked undecryptable failure', () => {
    expect(isWrongKeyDbError(new Error(wrongKeyMessage))).toBe(true);

    // Everything else must be left alone — these are the failures that would
    // destroy recoverable data (or hide a real bug) if they deleted the file.
    expect(
      isWrongKeyDbError(
        new Error(
          'OPFS unavailable: Failed to open OPFS backend: JsValue(...)',
        ),
      ),
    ).toBe(false);
    expect(
      isWrongKeyDbError(
        new Error(
          'OPFS unavailable: Failed to open encrypted OPFS backend: not an ' +
            'encrypted atomic database (bad magic bytes)',
        ),
      ),
    ).toBe(false);
    expect(
      isWrongKeyDbError(
        new Error(
          'OPFS unavailable: block 3 failed authentication (wrong key or ' +
            'corrupted data)',
        ),
      ),
    ).toBe(false);
    expect(isWrongKeyDbError(new Error('ClientDb not initialized'))).toBe(
      false,
    );
    expect(isWrongKeyDbError(undefined)).toBe(false);
  });
});

describe('openClientDb', () => {
  it('opens normally without touching anything', async () => {
    const { wasm, opened, deleted } = fakeWasm([]);

    const result = await openClientDb(wasm, {
      baseUrl: 'https://example.com',
      dbName: DB_NAME,
      dbKey: DB_KEY,
    });

    expect(result.recreated).toBe(false);
    expect(opened).toHaveLength(1);
    expect(deleted).toEqual([]);
  });

  it('deletes and recreates a database it cannot decrypt', async () => {
    const { wasm, opened, deleted } = fakeWasm([new Error(wrongKeyMessage)]);

    const result = await openClientDb(wasm, {
      baseUrl: 'https://example.com',
      dbName: DB_NAME,
      dbKey: DB_KEY,
    });

    expect(result.recreated).toBe(true);
    expect(result.db).toEqual({ handle: `db:${DB_NAME}` });
    // Exactly the file we failed to open, and only that one.
    expect(deleted).toEqual([DB_NAME]);
    // Recreated under the SAME key — never as a plaintext fallback.
    expect(opened).toHaveLength(2);
    expect(opened[1]).toEqual({ dbName: DB_NAME, dbKey: DB_KEY });
  });

  it('rethrows other open failures without deleting', async () => {
    const failure = new Error(
      'OPFS unavailable: Failed to open OPFS backend: JsValue(NotAllowedError)',
    );
    const { wasm, deleted } = fakeWasm([failure]);

    await expect(
      openClientDb(wasm, { dbName: DB_NAME, dbKey: DB_KEY }),
    ).rejects.toBe(failure);
    expect(deleted).toEqual([]);
    expect(wasm.deleteClientDb).not.toHaveBeenCalled();
  });

  it('never deletes an unencrypted database', async () => {
    // The shared signed-out `atomic_data.anon.redb` has no key, so it can't
    // produce this error — but if it somehow did, it must not be deleted.
    const { wasm, deleted } = fakeWasm([new Error(wrongKeyMessage)]);

    await expect(
      openClientDb(wasm, { dbName: 'atomic_data.anon.redb' }),
    ).rejects.toThrow(WRONG_KEY_MARKER);
    expect(deleted).toEqual([]);
  });

  it('gives up after one recreate instead of looping', async () => {
    const second = new Error('OPFS unavailable: Failed to open OPFS backend');
    const { wasm, opened, deleted } = fakeWasm([
      new Error(wrongKeyMessage),
      second,
    ]);

    await expect(
      openClientDb(wasm, { dbName: DB_NAME, dbKey: DB_KEY }),
    ).rejects.toBe(second);
    expect(deleted).toEqual([DB_NAME]);
    expect(opened).toHaveLength(2);
  });

  it('rethrows when the WASM build has no delete export', async () => {
    const failure = new Error(wrongKeyMessage);
    const { wasm } = fakeWasm([failure]);
    const withoutDelete = { ClientDb: wasm.ClientDb };

    await expect(
      openClientDb(withoutDelete, { dbName: DB_NAME, dbKey: DB_KEY }),
    ).rejects.toBe(failure);
  });
});
