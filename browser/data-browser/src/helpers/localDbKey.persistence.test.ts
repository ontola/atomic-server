import { beforeEach, describe, expect, it, vi } from 'vitest';
const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock('idb-keyval', () => ({
  get: async (key: string) => records.get(key),
  set: async (key: string, value: unknown) => {
    records.set(key, value);
  },
  del: async (key: string) => {
    records.delete(key);
  },
  keys: async () => [...records.keys()],
  // IndexedDB update reads and writes in one readwrite transaction.
  update: async (key: string, updater: (value: unknown) => unknown) => {
    records.set(key, updater(records.get(key)));
  },
}));
import {
  agentDbFingerprint,
  clearSessionDbKeys,
  deriveKek,
  ensureDbKeyOnSignIn,
  generateDbKey,
  getOrCreateSessionDbKey,
  getSessionDbKey,
  hasWrappedDbKey,
  wrapDbKey,
  type DbKeyWrapOps,
  type SignInCredentials,
} from './localDbKey';

const subject = 'did:ad:agent:concurrent-key-test';

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const credentials: SignInCredentials = {
  privateKey: b64url(new Uint8Array(32).fill(7)),
  vaultProof: b64url(new Uint8Array(64).fill(3)),
};
const otherCredentials: SignInCredentials = {
  privateKey: b64url(new Uint8Array(32).fill(8)),
  vaultProof: b64url(new Uint8Array(64).fill(4)),
};

/**
 * Stand-in for the wasm `vaultWrapKey` / `vaultUnwrapKey`: keyed on the proof
 * and refusing any other, which is the property these tests depend on. The
 * real envelope is covered by `secret_envelope.rs` and `wasm/tests/vault.rs`.
 */
const fakeOps: DbKeyWrapOps = {
  wrap: (dbKey, proof) =>
    JSON.stringify({
      format_version: 2,
      key: Array.from(dbKey),
      proof: Array.from(proof),
    }),
  unwrap: (envelope, proof) => {
    const parsed = JSON.parse(envelope);

    if (parsed.proof.join() !== Array.from(proof).join()) {
      throw new Error('no wrapper in this envelope accepted that credential');
    }

    return new Uint8Array(parsed.key);
  },
};
const withWasm = async () => fakeOps;

const withoutWasm = async (): Promise<DbKeyWrapOps> => {
  throw new Error('failed to fetch /wasm/atomic_wasm.js');
};

async function recordKeys() {
  const fingerprint = await agentDbFingerprint(subject);

  return {
    v1: `atomic.clientdb.wrapped-key.${fingerprint}`,
    v2: `atomic.clientdb.wrapped-key-v2.${fingerprint}`,
  };
}

beforeEach(() => records.clear());

describe('persistent local database keys', () => {
  it('concurrent database openers receive the same persisted key', async () => {
    const keys = await Promise.all(
      Array.from({ length: 8 }, () => getOrCreateSessionDbKey(subject)),
    );
    for (const key of keys) expect(key).toEqual(await getSessionDbKey(subject));
  });

  it('concurrent sign-in and database initialization preserve the key across sign-out', async () => {
    const [openedWith, signedInWith] = await Promise.all([
      getOrCreateSessionDbKey(subject),
      ensureDbKeyOnSignIn(subject, credentials, withWasm),
      ensureDbKeyOnSignIn(subject, credentials, withWasm),
    ]);
    expect(signedInWith).toEqual(openedWith);
    await clearSessionDbKeys();
    expect(await ensureDbKeyOnSignIn(subject, credentials, withWasm)).toEqual(
      openedWith,
    );
  });

  it('writes new keys only in the v2 envelope scheme', async () => {
    const { v1, v2 } = await recordKeys();
    await ensureDbKeyOnSignIn(subject, credentials, withWasm);

    expect(records.has(v1)).toBe(false);
    expect(records.get(v2)).toMatchObject({ version: 2 });
    expect(await hasWrappedDbKey(subject)).toBe(true);
  });

  it('opens a legacy v1 record, rewraps it as v2 and keeps v1 for rollbacks', async () => {
    const { v1, v2 } = await recordKeys();
    const legacyKey = generateDbKey();
    const legacyRecord = await wrapDbKey(
      await deriveKek(credentials.privateKey, subject),
      legacyKey,
    );
    records.set(v1, legacyRecord);

    // Signed out: no session key, only the old-format wrapped record.
    expect(await ensureDbKeyOnSignIn(subject, credentials, withWasm)).toEqual(
      legacyKey,
    );
    expect(await getSessionDbKey(subject)).toEqual(legacyKey);
    expect(records.get(v1)).toEqual(legacyRecord);
    expect(records.get(v2)).toMatchObject({ version: 2 });

    // The next sign-in reads the v2 record, even with v1 gone.
    records.delete(v1);
    await clearSessionDbKeys();
    expect(await ensureDbKeyOnSignIn(subject, credentials, withWasm)).toEqual(
      legacyKey,
    );
  });

  it('does not hand the key to a different secret', async () => {
    const original = await ensureDbKeyOnSignIn(subject, credentials, withWasm);
    await clearSessionDbKeys();

    expect(
      await ensureDbKeyOnSignIn(subject, otherCredentials, withWasm),
    ).not.toEqual(original);
  });

  it('does not open a legacy v1 record with a different secret', async () => {
    const { v1 } = await recordKeys();
    const legacyKey = generateDbKey();
    records.set(
      v1,
      await wrapDbKey(
        await deriveKek(credentials.privateKey, subject),
        legacyKey,
      ),
    );

    expect(
      await ensureDbKeyOnSignIn(subject, otherCredentials, withWasm),
    ).not.toEqual(legacyKey);
  });

  it('keeps a v2 record when wasm cannot load, and opens it on the next try', async () => {
    const { v2 } = await recordKeys();
    const original = await ensureDbKeyOnSignIn(subject, credentials, withWasm);
    const stored = records.get(v2);
    await clearSessionDbKeys();

    await expect(
      ensureDbKeyOnSignIn(subject, credentials, withoutWasm),
    ).rejects.toThrow(/wasm/);
    expect(records.get(v2)).toEqual(stored);
    expect(await getSessionDbKey(subject)).toBeUndefined();

    expect(await ensureDbKeyOnSignIn(subject, credentials, withWasm)).toEqual(
      original,
    );
  });

  it('falls back to a v1 record without wasm, then migrates it', async () => {
    const { v1, v2 } = await recordKeys();
    const original = await ensureDbKeyOnSignIn(
      subject,
      credentials,
      withoutWasm,
    );

    expect(records.get(v1)).toMatchObject({ version: 1 });
    expect(records.has(v2)).toBe(false);

    await clearSessionDbKeys();
    expect(await ensureDbKeyOnSignIn(subject, credentials, withWasm)).toEqual(
      original,
    );
    expect(records.get(v2)).toMatchObject({ version: 2 });
  });

  it('recovers from a corrupt v2 record through the v1 record', async () => {
    const { v1, v2 } = await recordKeys();
    const legacyKey = generateDbKey();
    records.set(
      v1,
      await wrapDbKey(
        await deriveKek(credentials.privateKey, subject),
        legacyKey,
      ),
    );
    records.set(v2, { version: 2, envelope: '{"not":"an envelope"}' });

    expect(await ensureDbKeyOnSignIn(subject, credentials, withWasm)).toEqual(
      legacyKey,
    );
    expect(
      fakeOps.unwrap(
        (records.get(v2) as { envelope: string }).envelope,
        new Uint8Array(64).fill(3),
      ),
    ).toEqual(legacyKey);
  });
});
