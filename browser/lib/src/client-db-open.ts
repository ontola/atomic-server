/**
 * Opening the WASM ClientDb, with self-healing for an OPFS file that cannot be
 * decrypted with the key we have.
 *
 * Each signed-in agent gets its own OPFS file encrypted under a per-agent key
 * (see the data-browser's `localDbKey.ts`). If that key is ever lost — site
 * data cleared, the identity re-created, an interrupted key migration — the
 * existing file stays behind and every open fails with "wrong encryption key
 * for local database", on every page load, forever.
 *
 * That file is a pure cache: everything in it is re-fetchable from the server,
 * and its contents are unreadable anyway once the key is gone. So the fix is to
 * throw it away and start a fresh (still encrypted) one under the current key.
 *
 * Deliberately narrow. Deletion requires ALL of:
 *   - the WASM side tagged the failure with `WRONG_KEY_MARKER` (only the header
 *     key check does that — a corrupt file, an unsupported version, or an
 *     unavailable OPFS produce untagged errors),
 *   - a `dbKey`, so the shared plaintext anonymous database is never a target,
 *   - a `dbName`, so we only ever delete the exact file we just tried to open —
 *     never another agent's.
 * Anything else rethrows untouched.
 */

/**
 * Token spliced into the error message by `ClientDb::new`. Keep in sync with
 * `WRONG_KEY_MARKER` in `wasm/src/lib.rs`.
 */
export const WRONG_KEY_MARKER = 'ATOMIC_DB_WRONG_KEY';

/** The subset of the generated WASM module that opening a database needs. */
export interface ClientDbWasm {
  /** wasm-bindgen renders the async constructor as a Promise-returning `new`. */
  ClientDb: new (
    baseUrl?: string,
    dbName?: string,
    dbKey?: Uint8Array,
  ) => Promise<unknown>;
  /** Added alongside the self-heal; absent in older WASM builds. */
  deleteClientDb?: (dbName: string) => Promise<boolean>;
}

export interface OpenClientDbOptions {
  baseUrl?: string;
  dbName?: string;
  dbKey?: Uint8Array;
}

export interface OpenClientDbResult {
  db: unknown;
  /** Whether an undecryptable file had to be discarded and recreated. */
  recreated: boolean;
}

/**
 * Whether this open failure means "the file exists, is a valid encrypted
 * database, and this key does not open it" — the single recoverable case.
 */
export function isWrongKeyDbError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return message.includes(WRONG_KEY_MARKER);
}

/**
 * Token spliced into the error message by `ClientDb::new` when the browser
 * refuses this origin storage outright. Keep in sync with
 * `STORAGE_BLOCKED_MARKER` in `wasm/src/lib.rs`.
 */
export const STORAGE_BLOCKED_MARKER = 'ATOMIC_DB_STORAGE_BLOCKED';

/**
 * Whether the local database is unavailable because the browser is withholding
 * storage from this origin — Safari private browsing, tracking prevention on a
 * partitioned origin, or site data blocked by the user.
 *
 * This is a property of the browsing session, not of our data: there is
 * nothing to repair, nothing to delete, and retrying cannot help. Callers
 * degrade to server-only mode and say so in one sentence, rather than logging
 * a wasm stack trace on every page load for a state the user may have chosen.
 */
export function isStorageBlockedDbError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return message.includes(STORAGE_BLOCKED_MARKER);
}

/**
 * Open the OPFS-backed ClientDb, recreating it once if the existing file is
 * undecryptable. Any other failure — and any failure of the retry itself —
 * propagates to the caller.
 */
export async function openClientDb(
  wasm: ClientDbWasm,
  { baseUrl, dbName, dbKey }: OpenClientDbOptions,
): Promise<OpenClientDbResult> {
  try {
    return {
      db: await new wasm.ClientDb(baseUrl, dbName, dbKey),
      recreated: false,
    };
  } catch (e) {
    if (
      !isWrongKeyDbError(e) ||
      !dbName ||
      !dbKey ||
      typeof wasm.deleteClientDb !== 'function'
    ) {
      throw e;
    }

    console.warn(
      `[ClientDb] local cache ${dbName} cannot be decrypted with this ` +
        "agent's key (the key was lost, or the identity was re-created). " +
        'Discarding the file and rebuilding the cache from the server.',
      e,
    );

    await wasm.deleteClientDb(dbName);

    // No second recovery attempt: a fresh file opens or something else is
    // wrong, and a delete loop would be worse than a clear error.
    return {
      db: await new wasm.ClientDb(baseUrl, dbName, dbKey),
      recreated: true,
    };
  }
}
