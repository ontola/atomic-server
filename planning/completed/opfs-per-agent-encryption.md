# Per-agent OPFS databases with at-rest encryption

> **Status:** Implemented (2026-07). This realizes the "Local cache and
> session isolation" requirement from [`encryption.md`](./encryption.md):
> after sign-out or an agent switch, a session can no longer read the
> previous agent's cached private data — without wiping the cache.

## What shipped

### 1. One OPFS database file per agent

The browser ClientDb used to be a single plaintext `atomic_data.redb` at the
OPFS root, shared by whoever used the origin. Now:

- Signed in as agent `A`: `atomic_data.<fp>.redb`, where `<fp>` is the first
  16 hex chars of SHA-256 of the agent subject
  (`agentDbFingerprint`, `data-browser/src/helpers/localDbKey.ts`).
- Signed out: shared plaintext `atomic_data.anon.redb` (public data only).
- The leader lock and RPC BroadcastChannel are scoped per database name
  (`browser/lib/src/client-db.ts`), so different-identity tabs never share a
  leader.
- On agent change (`StoreEvents.AgentChanged`), `initClientDb` destroys the
  worker and restarts it against the new identity's database. Restarts are
  serialized. The in-memory seed runs only on the first start of a page load —
  re-seeding on a switch would copy the previous session's in-memory private
  resources into the next identity's database.

### 2. At-rest encryption, block-level, in Rust

`lib/src/db/encrypted_backend.rs` — `EncryptedBackend`, a generic
`redb::StorageBackend` wrapper (native-testable, used over `OpfsBackend` in
wasm):

- XChaCha20-Poly1305 per 4096-byte logical block; each write uses a fresh
  random 24-byte nonce; the block index is authenticated as associated data
  (no block transplants). RustCrypto, per the vault-architecture convention
  that new crypto lives in Rust/WASM, not WebCrypto.
- 64-byte header: magic, version, block size, logical length, and a key-check
  AEAD tag so a wrong key (or a plaintext file) fails fast on open instead of
  corrupting anything.
- All-zero nonce = never-written block (reads as zeros); `set_len` zeroes
  truncated tails so shrink-then-grow can't resurrect stale plaintext.
- The whole file is encrypted — resources, Loro snapshots, blobs, and all
  derived indexes (prop/val, query members, search input), closing the
  "indexes leak plaintext" hole value-level encryption would have left.

Key plumbed through `RedbStore::new_opfs(filename, Option<&[u8; 32]>)` →
`Db::init_redb_opfs` → wasm `ClientDb::new(base_url, db_name, db_key)` →
worker `init` message → `ClientDbWorker` options.

### 3. Key hierarchy (per `CLOUD_VAULT_ARCHITECTURE.md` conventions)

The agent's Ed25519 key wraps keys; it never encrypts bulk data.

```text
agent raw Ed25519 private key (present in JS only during sign-in)
  → KEK = HKDF-SHA256(ikm=raw key, salt="atomic.clientdb.kek.v1",
                       info="clientdb-key-wrap:" + subject) → AES-GCM-256
      → wraps the per-agent DbKey (random 256-bit)
          → encrypts that agent's OPFS database (XChaCha20-Poly1305)
```

Two persisted records per agent (IndexedDB, `localDbKey.ts`):

- `atomic.clientdb.session-key.<fp>` — the raw DbKey, present only while the
  agent is the active session; deleted by sign-out
  (`saveAgentToIDB(undefined)` → `clearSessionDbKeys`). This is what lets a
  reload reopen the encrypted DB without re-entering the secret.
- `atomic.clientdb.wrapped-key.<fp>` — DbKey wrapped under the KEK; survives
  sign-out. Unwrapped on the next sign-in with the secret
  (`ensureDbKeyOnSignIn`, called from `agentStorage.storeSecret`), so the
  same agent regains their intact cache: **encrypt, don't wipe**.

Security model: after sign-out the on-disk cache is ciphertext this session
cannot read; only re-entering the agent secret can unwrap the DbKey. While
signed in, the raw DbKey sits in IDB — an attacker with full disk access to a
*live signed-in* profile gets it, same as they'd get the fallback agent key on
insecure contexts. Hardening that (WebAuthn-PRF wrapping, biometric unlock) is
the deferred work `BACKUP_SECURITY.md` describes; the wrapped-record format is
versioned so it can move under envelope v2 later.

### 4. Migration

`migrateLegacyClientDb` (wasm export; `migrate_legacy_db` in
`lib/src/db/opfs_backend.rs`): on first start after upgrade, the legacy
`atomic_data.redb` is copied — encrypting on the way — into the active
identity's database, then deleted. It may hold local-only data with no server
fallback, so it is adopted, never dropped. No-ops when absent or when the
target already exists; a failed migration leaves the legacy file for the next
attempt.

## Known gaps / accepted tradeoffs

- **Legacy adoption goes to whoever is active at upgrade time** (including the
  anonymous plaintext DB when signed out). No worse than the pre-split world,
  where the file was plaintext for everyone.
- **Secretless sign-ins** (agent restored as a non-extractable keypair, e.g.
  pairing paths that never pass the secret through JS) can't unwrap the
  wrapped DbKey. `initClientDb` waits ~3 s for a sign-in to deliver the
  session key, then generates a fresh one; if an encrypted file from an
  earlier era exists, the DB parks in server-only mode until a sign-in with
  the secret heals it. Cache-only loss; re-syncs.
- **Pre-feature signed-in sessions** get a session key without a wrapped copy
  (no secret available). Signing out before any secret re-entry orphans that
  cache (unreadable → effectively lost). Acceptable per `encryption.md`: it
  is a cache that re-syncs from a verifier.
- **In-memory Store state is not cleared on sign-out** — the previous agent's
  resources stay readable in that tab's JS memory until reload. Tab-lifetime
  only; OPFS is the durable surface this work protects.
- **Sign-out is per-tab**: other open tabs keep their in-memory session (as
  before). Their worker holds the old DB; the signed-out tab's anon DB is
  separate, so no cross-contamination.
- The block-granular AEAD adds ~1% size overhead and per-block crypto on
  I/O; redb page alignment keeps read-modify-write rare.
- **Writes issued during the identity-switch window are dropped** with a
  logged `[ClientDb] put failed … worker not initialized` — the old worker is
  destroyed before the new one is ready. Cache-writes only (the server copy
  is unaffected); observed for the agent resource itself during sign-in.

## Relationship to other plans

- `encryption.md` § "Local cache and session isolation" — this is that
  mechanism, shipped (single per-agent cache key, the "minimal first step").
  Per-drive keys, encrypted replication, and blind replicas remain open.
- `CLOUD_VAULT_ARCHITECTURE.md` — same conventions (random 256-bit key,
  agent-key-wraps-never-encrypts, Rust crypto). When `DriveVaultKey` +
  envelope v2 land as a shared module, the DbKey wrap can migrate onto them;
  the versioned records make that a re-wrap, not a format break.
- `BACKUP_SECURITY.md` — the wrapped record is the local sibling of the
  recovery blob; PRF wrappers are the upgrade path for both.
