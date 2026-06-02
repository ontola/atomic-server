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

- [x] `lib/src/frozen.rs`: `frozen_id` / `verify_frozen`. Done + cross-language
      tested.
- [x] `lib/src/subject.rs`: `is_frozen_did`, `frozen_hash_hex`,
      `from_frozen_hash` (+ `DID_AD_FROZEN_PREFIX`), mirroring the blob helpers.
      Done + tested (`test_frozen_did_parsing`, incl. `?drive=` hint stripping).
- [x] `lib/src/db/trees.rs`: `Tree::Frozen` (key = BLAKE3 hex, value = canonical
      JSON-AD bytes), wired through both backends (`sled_store`, `redb_store`).
      Done + storage round-trip test (`db::test::frozen_storage`).
- [x] `lib/src/db.rs#get_resource`: if `is_frozen_did(subject)`,
      `materialize_frozen` looks up `Tree::Frozen`, **verifies by re-hash**
      (trustless), and parses the JSON-AD into a read-only Resource via
      `parse_json_ad_map_to_resource` with `SaveOpts::DontSave` — bypassing
      `Tree::Resources`/Loro and, crucially, class-`requires` validation (a frozen
      definition is valid by its hash, not by completeness, so omitting
      `description` is fine). Cycle "unit" objects error for now. Done + tested
      (`db::test::frozen_materialization`, incl. re-hash rejection of a mismatched
      body).
- [x] Reject any Commit whose subject is `did:ad:frozen:` (immutable). Done:
      `commit.rs#validate_and_build_response` rejects frozen subjects up front
      (before signature checks). Tested (`commit_to_frozen_subject_is_rejected`).
- [x] Use **RFC 8785 JCS** for the canonical JSON-AD bytes on the Rust side.
      Done: `lib/src/frozen.rs#frozen_id` uses the already-present `serde_jcs` +
      `blake3`, and `test-vectors/frozen.json` pins the contract. Both
      `browser/lib/src/frozen-vectors.test.ts` (TS) and the `frozen.rs` test
      assert identical ids; verified byte-for-byte across all vectors (incl.
      unicode key ordering and a cycle unit). **The sharpest correctness risk is
      retired.**

### Phase B — server endpoints

- [x] `PUT /frozen/{hash}`: parses the JSON-AD body, verifies
      `frozen_id(body) == did:ad:frozen:{hash}` (blake3 of JCS, not raw bytes),
      stores the canonical bytes in `Tree::Frozen` idempotently. Public, like
      `/blob` (the hash is the capability). Done: `server/src/handlers/frozen.rs`.
- [x] `GET /frozen/{hash}`: returns the stored JSON-AD bytes
      (`content-type: application/ad+json`), 404 if absent.
- [x] End-to-end HTTP test (`server::tests::frozen_endpoint_roundtrip`):
      PUT -> GET round-trips, a wrong-hash PUT is rejected, and the stored body
      resolves through the normal `get_resource` materialization path.
- [ ] _(optional)_ Wire `did:ad:frozen:` into the WebSocket `GET` frame / sync so
      frozen objects travel with drives (Phase D), not only the dedicated route.
      `get_resource` already resolves them for the HTTP `/` path.

### Phase C — browser Store + registerSchema switch-over

- [x] Store: `fetchFrozenResource` detects `did:ad:frozen:` in the fetch path,
      fetches `GET /frozen/{hash}`, **re-hashes to verify** (`frozenIdFor`), and
      materializes a read-only Resource via `JSONADParser`. `getProperty` was
      relaxed to treat `description` as optional (presentation, not identity), so
      frozen properties resolve. Tested (`frozen-resolve.test.ts`).
- [x] `Store.registerFrozenSchema` (additive — leaves the signed-DID
      `registerSchema` intact): freezes the schema, materializes the frozen bodies
      into the local store (offline-resolvable immediately), and with
      `{ save: true }` PUTs each to `/frozen/{hash}`. Returns the `FrozenSchema`
      (frozen ids per key + `presentation`). Tested.
- [x] **Capstone e2e** (`tests/frozen-e2e.integration.test.ts`, real server):
      producer `registerFrozenSchema(..., { save: true })` PUTs frozen bodies; a
      fresh agent-less consumer `getProperty`/`getResource` resolves them over
      `GET /frozen` (verify-by-rehash), refs intact, and builds an instance
      against the frozen class + property. Proves the whole producer→server→
      consumer loop live.
- [ ] Persist frozen objects in ClientDb (OPFS) keyed by hash for offline reload
      (currently in-memory only).
- [x] The signed **"latest version" pointer**: `Store.createSchemaPointer(frozen)`
      builds a mutable, signed Ontology (genesis DID) on the author's drive whose
      `classes`/`properties` reference the immutable frozen ids. Its stable subject
      is the durable name and its commit history is the version log; old frozen
      ids stay permanently resolvable. Tested (construction). Explicit `replaces`
      links would need a new bootstrapped property — deferred.

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
