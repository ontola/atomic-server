# Server-side `did:ad:frozen` plan

Companion to [json-schema-code-first.md](./json-schema-code-first.md). That doc
decided the **identity model**: schema definitions are immutable, so they are
content-addressed as `did:ad:frozen:{blake3-hex}` instead of signed genesis DIDs.
The TypeScript producer side is built (`browser/lib/src/freeze.ts`,
`schema.ts#freezeSchema`). This doc plans the Rust/server and Store work needed
to **store, serve, resolve, and sync** frozen objects.

## Core decision: frozen objects are blob-like, not resource-like

A frozen object must NOT go through the Commit/Resource pipeline. The commit
validator hard-codes that a genesis resource's subject equals its signature
(`lib/src/commit.rs:318-341`); a signatureless content-addressed object cannot
satisfy that. Rather than bend the genesis path, model frozen objects on the
existing **blob** mechanism, which is already a commit-free, content-addressed
byte store:

| Concern | Blob (today) | Frozen (new, parallel) |
| --- | --- | --- |
| Storage | `Tree::Blobs`, key = 32-byte BLAKE3, value = raw bytes (`lib/src/db/trees.rs:29`) | `Tree::Frozen`, key = 32-byte BLAKE3, value = canonical JSON-AD bytes |
| Write | `PUT /blob/{hash}`, verify-by-rehash (`server/src/handlers/blob.rs:14-41`) | `PUT /frozen/{hash}`, verify-by-rehash |
| Read | raw bytes (`/download/...`) | **materialized read-only Resource** (parse JSON-AD) |
| Identity parse | `subject.rs#is_blob_did/blob_hash_hex/from_blob_hash` | mirror as `is_frozen_did/frozen_hash_hex/from_frozen_hash` |
| Sync | `BLOB_REQUEST/RESPONSE` frames | `FROZEN_REQUEST/RESPONSE` (or reuse the blob "fetch-if-missing" path) |

**The invariant that makes this simple:** every stored frozen object satisfies
`blake3(its canonical bytes) == its hash`. The server verifies on write and can
re-verify on read; the client always re-verifies. No host is ever trusted — a
frozen object is self-authenticating by content. Rust needs only BLAKE3 + a
JSON-AD parser; it never needs the freeze/SCC algorithm.

The one difference from blobs: a frozen object **resolves to a parsed Resource**,
not opaque bytes, so `get_resource`, datatype/required validation, forms, and
`getProperty` work against frozen schema resources with no special-casing at
those call sites.

## How resolution stays decentralized (and atomicdata.dev stays optional)

Because every fetch is verify-by-rehash, the source is irrelevant to
correctness. A well-known default server (e.g. `atomicdata.dev`) is therefore a
**cache/CDN, never a dependency**. Resolution order for a `did:ad:frozen` subject:

1. local `Tree::Frozen` / client ClientDb (OPFS) cache
2. app-bundled frozen objects (JSON-AD shipped with the app)
3. `?drive=` routing hint → pkarr (`discovery.rs`) → iroh peer → `FROZEN_REQUEST`
   by hash (the working p2p path today)
4. a **configurable** default-server list (defaults to `atomicdata.dev`) →
   `GET /frozen/{hash}` → verify-by-rehash. Removable; the spec never names it.
5. _(future)_ content-hash discovery: announce frozen hashes directly on a DHT so
   holders can be found without a drive hint. The dormant `mainline` crate
   (`server/Cargo.toml:65`, currently unused) or a pkarr record are the
   candidates. Not needed for v1.

"Not formally relying on atomicdata.dev" = the default-server entry is config,
documented as optional, and the protocol/spec never references it. If it is down
and the bytes exist in a bundle, on the author's drive, or on any peer, resolution
still succeeds and verifies.

## Decided + implemented: cyclic members freeze as one unit

This was the one place the producer and server models disagreed; it is now
resolved in `freeze.ts` so every stored frozen object satisfies
`blake3(canonical bytes) == hash`.

- **Acyclic** resources (the common case: ontology → classes → properties) each
  freeze to one self-verifying blob, `id = blake3(JCS(content))`.
- A **cycle** (e.g. `Person` class with a `friend` property whose classtype is
  `Person`) freezes to a single **unit** object,
  `{ "urn:atomic-freeze:unit": [ ...members ] }` (`UNIT_MEMBERS_KEY`), members in
  a deterministic canonical order with intra-cycle references rewritten to
  `did:ad:frozen:self:{index}` self tokens (`SELF_PREFIX`). The unit id is
  `blake3(JCS(unit))` and all members share it; they resolve together. This keeps
  the server invariant exact (one blob, verify-by-rehash) and respects "DIDs have
  no subpaths" (`docs/src/did.md`).

Consequence for the **server materializer**: when it parses a frozen object whose
top-level key is `urn:atomic-freeze:unit`, it must expand the array into multiple
read-only Resources and rewire each `did:ad:frozen:self:{index}` token to the
i-th member. The constants are exported from `browser/lib/src/freeze.ts` as the
frozen-format contract. (The Rust side still only ever verifies a hash; it does
not run the freeze algorithm.)

Deferred: independent addressing/reuse of a single member *inside* a cycle (would
need fragment addressing like `did:ad:frozen:{unit}#{shortname}`, which the DID
spec currently disallows). Co-dependent members travel together, so this is rarely
needed.

## Work breakdown

### Phase A — lib + server storage, parsing, materialization

- [ ] `lib/src/subject.rs`: add `is_frozen_did`, `frozen_hash_hex`,
      `from_frozen_hash`, mirroring the blob helpers. `pure_id()` already strips
      `?drive=`; subject equality is already string-based — reuse both.
- [ ] `lib/src/db/trees.rs`: add `Tree::Frozen` (key = 32-byte BLAKE3, value =
      canonical JSON-AD bytes).
- [ ] `lib/src/db.rs#get_resource`: if `is_frozen_did(subject)`, look up
      `Tree::Frozen`, verify hash, parse JSON-AD into a **read-only** Resource,
      return it — bypassing `Tree::Resources`/Loro. Cache in memory like any
      fetched resource.
- [ ] Reject any Commit whose subject is `did:ad:frozen:` (immutable; no edits).
- [ ] Use **RFC 8785 JCS** for the canonical JSON-AD bytes on the Rust side
      (`serde_jcs` / `serde_json_canonicalizer`) so it byte-matches the TS
      producer (`browser/lib/src/jcs.ts#jcsCanonicalize`, already used by
      `freeze.ts`). Lock it with shared test vectors (fixed schema → fixed hash,
      asserted in both Rust and TS). **This is the sharpest correctness risk** —
      a one-byte canonicalization difference makes ids diverge across languages,
      so JCS (a named standard with conformant impls on both sides) is required.

### Phase B — server endpoints

- [ ] `PUT /frozen/{hash}`: accept bytes, verify `blake3 == hash`, store
      idempotently (re-post is a no-op, like `/blob`). Auth: require an
      authenticated agent (forgery is impossible since content is hash-checked, so
      the only risk is storage spam — gate with auth + a size/rate limit).
- [ ] `GET /frozen/{hash}`: return canonical JSON-AD bytes
      (`content-type: application/ad+json`).
- [ ] Wire `did:ad:frozen:` subjects into the normal resource GET path so they
      resolve through the same `/` endpoint and the WebSocket `GET` frame, not
      only the dedicated route.

### Phase C — browser Store + registerSchema switch-over

- [ ] Store: detect `did:ad:frozen:` in `getResource`/`fetchResourceFromServer`,
      fetch (local cache → `GET /frozen` → sync), **re-hash to verify**, parse
      JSON-AD into a read-only Resource, cache. `getProperty` then works
      unchanged.
- [ ] Persist frozen objects in ClientDb (OPFS) keyed by hash for offline use.
- [ ] `Store.registerSchema`: replace genesis-DID minting with `freezeSchema`;
      write frozen objects locally and optionally `PUT /frozen` to the author's
      server; return the frozen ids. Keep the old path behind a flag during
      migration so existing tests/producers keep working until parity is proven.
- [ ] The signed **"latest version" pointer** stays a normal genesis-DID resource
      on the author's drive (`name → latest frozen ontology id`), plus any
      mutable display overlay the app chooses to keep editable.

### Phase D — sync (frozen travels with drives)

- [ ] Add `FROZEN_REQUEST/FROZEN_RESPONSE` frames (or generalize the blob
      fetch-if-missing path) in `lib/src/sync/protocol.rs` +
      `sync/engine.rs#import_sync_push`: when an imported resource references a
      `did:ad:frozen:` subject the receiver lacks, request it by hash — exactly
      how missing blobs are pulled today. Frozen objects are immutable and
      self-verifying, so they do **not** join version vectors or Loro merge.
- [ ] Route frozen fetches over iroh via the `?drive=` hint → pkarr → peer.

### Phase E — spec, docs, discovery polish

- [ ] `docs/src/did.md`: add `did:ad:frozen` as the next `did:ad` form —
      content-addressed, resolves to canonical JSON-AD (vs. `blob`'s opaque
      bytes), immutable, verify-by-rehash, optional `?drive=` hint.
- [ ] Update `docs/src/schema/*` per the companion doc's Phase 5.
- [ ] _(optional/future)_ content-hash DHT announce using the dormant `mainline`
      crate or pkarr, for hint-free discovery.

## Risks / open questions

- **Cross-language canonicalization** must be byte-identical (Phase A): RFC 8785
  JCS on both sides (`jcs.ts` ↔ `serde_jcs`). Lock it with shared test vectors
  before anything else depends on the hash.
- ~~**Cyclic addressing**~~ — decided: one unit per cycle (see above), implemented
  in `freeze.ts`.
- **Garbage collection / retention.** Frozen objects are immutable and
  accumulate. Refcount from referencing resources, or keep schema frozens
  forever? Open.
- **PUT /frozen auth + abuse.** Open vs. authenticated vs. quota'd.
- **`mainline` is dead weight today** — either wire it for content-hash discovery
  or drop the dependency; don't leave it implying capability that isn't there.
