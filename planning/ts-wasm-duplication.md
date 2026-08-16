# TypeScript vs WASM / Rust duplication

## Status

Analysis (2026-08-16). Recommendation: **do not migrate `@tomic/lib` wholesale
into WASM**. Keep the JS `Resource`/`Store` as the browser cache/reactivity
layer. Continue pushing *node* work (query, persist, apply-commit, blobs) into
the existing `atomic_wasm` `ClientDb`, which is the
[`atomic-lib-runtime.md`](./atomic-lib-runtime.md) direction. Protocol
must-match helpers can move into WASM *selectively* if golden tests become
painful; they are not the performance problem.

Related: [`unified-data-layer.md`](./unified-data-layer.md) (JS cache layer),
[`atomic-lib-runtime.md`](./atomic-lib-runtime.md) (`AtomicNode` / WASM node
API), [`loro-source-of-truth.md`](./loro-source-of-truth.md).

Reproduce the numbers:

```sh
cargo run -p atomic_lib --example protocol_microbench --release
cd browser/lib && pnpm bench src/ts-vs-wasm.bench.ts   # needs wasm/pkg
```

## Short answer

There are **two different kinds of overlap**, and they should not be treated as
one "duplication" problem.

1. **Must-match protocol** (~1.5–2.5k lines of TS). Genesis certificates, commit
   canonical JSON, WS v2 frames, RBSR fingerprints, drive hashes, datatype
   tags, auth message format. These *must* be byte-identical with Rust or
   sync/signing silently diverges. They are already pinned with golden vectors.
   This is real duplication, but it is small and cold (runs on save/sync, not
   per render).

2. **Two embeddings of a Resource** (`resource.ts` 3.7k + `store.ts` 5.4k vs
   `resources.rs` + `loro.rs` + `db.rs`). Same *domain* (propvals, Loro,
   commits), completely different *jobs*. The TS types are an in-memory
   React cache with outbox, WebSocket, and TipTap/`loro-prosemirror`. The Rust
   types are a durable node (redb, indexes, rights, apply). Flutter already
   skipped this second embedding and calls `atomic_lib` directly.

Moving (2) into WASM would not delete (1)'s risk as much as it would put the
render hot path across a serialization boundary. Measured: a JS
`Resource.get(name)` cache hit is **~1,000× faster** than reading the same
resource back from in-process WASM as JSON-AD (`75 µs` vs `~0.07 µs`).

## Current shape

```
  React / TipTap / loro-prosemirror          (JS objects, main thread)
                    │
                    ▼
  @tomic/lib Resource + Store                (~9k LOC, JS cache + outbox + WS)
       │                         │
       │ loro-crdt WASM          │ Worker RPC (postMessage)
       │ (3.1 MB / 1.0 MB gz)    │
       ▼                         ▼
  LoroDoc on the main thread     atomic_wasm ClientDb
                                 (6.1 MB / 2.3 MB gz)
                                 redb + OPFS + query + applyCommit
                    │
                    ▼
              atomic_lib (Rust)
              server, Flutter, WASM
```

The browser already loads **two WASM modules**. `loro-crdt` owns live CRDT
docs on the main thread (required by `loro-prosemirror`). `atomic_wasm` owns
the durable cache in a DedicatedWorker because OPFS
`createSyncAccessHandle` is worker-only. That split is load-bearing, not an
accident.

WASM `ClientDb` already exposes the node-shaped surface: `getResource`,
`putResource`, `applyCommit`, `query` (including multi-filter, aggregations,
expression filters), blobs, version vectors, vault. See `wasm/src/lib.rs`.
JS still owns signing, Resource identity, React notifications, and the
editor's `LoroDoc`.

## Inventory

| Area | TS | Rust | Kind | In WASM today? | Verdict |
| --- | --- | --- | --- | --- | --- |
| Genesis cert encode/sign | `genesis.ts` (211) | `genesis.rs` (539) | **Must-match** | No (JS signs, WASM/server verifies) | Keep JS + golden tests. Optional: expose `encode`/`verify` on WASM later. |
| Commit canonical JSON + Ed25519 | `commit.ts` serialize (~150 of 545) | `commit.rs` `serialize_deterministically_json_ad` | **Must-match** | `applyCommit` only (no sign) | Same. Signing stays JS/`SubtleCrypto`. |
| WS v2 frames | `ws-v2.ts` (749) | `sync/protocol.rs` (969) | **Must-match** | No | Keep dual encoders; they are cheap and transport-local. |
| RBSR fingerprint | `rbsr.ts` (203) | `sync/rbsr.rs` (432) | **Must-match** | No | Golden vector exists. WASM only if the tree becomes hot. |
| Drive hash | `canonical-drive-hash.ts` | `engine::compute_drive_hash` | **Must-match** | VV extraction is in WASM; hash is JS | Fine. Hash is SHA-256 of a small string. |
| Datatype tags | `datatypes.ts` `datatypeTag` | `loro::datatype_tag` | **Must-match** | Applied at persist via snapshots | Keep; tags are a 15-line switch. |
| Auth `{subject} {timestamp}` | `authentication.ts` | `authentication.rs` | **Must-match** | No | Tiny. |
| JSON-AD parse | `parse.ts` (133) | `parse.rs` (1552) | Subset | `putResource` uses the Rust parser | Do not replace the JS parser for HTTP/WS ingress; WASM parse is for *store*. |
| Subject | branded `string` (83) | rich `enum` (1176) | Intentional split | `from_raw` at the WASM boundary | JS brand is a type-checker aid; Rust owns `internal:` / drive hints. |
| URLs / ontologies | generated `ontologies/*.ts` | `urls.rs` | Constants | n/a | Generated, not logic. |
| Agent / keys | `agent.ts` + `CryptoProvider.ts` | `agents.rs` | Parallel | Vault KDF/wrap is WASM | Keep `SubtleCrypto` on JS. |
| Resource + Loro | `resource.ts` (3680) | `resources.rs` + `loro.rs` (~5.3k) | **Two embeddings** | Snapshots only | Do not unify. |
| Store / Db | `store.ts` (5414) | `store.rs` + `db.rs` | **Two embeddings** | `ClientDb` is the durable half | JS Store stays the cache. |
| Collections / query | `collection.ts` (1131) | `collections.rs` (1528) | Client vs node | `ClientDb.query` | Already the right split: WASM for indexed query, JS for paging/UI. |
| Outbox / WS client | `local-outbox.ts`, `websockets.ts` | server adapters | JS-only | No | Belongs in JS (or a future node outbox *service*, not a Resource rewrite). |

Line counts are non-test source. `@tomic/lib` is ~22.5k LOC; `atomic_lib` is
~44k. The must-match slice is under 10% of the TS library.

Comments in the TS files already say "byte-identical counterpart of Rust" for
genesis, RBSR, and the drive hash. That is the duplication that actually
hurts when it drifts — and it is already tested that way (`known byte vector
v1`, `itemFingerprint matches the Rust golden vector`, `canonicalDriveHash`
golden hex, `sign.test.ts` vs a pinned Rust serialization).

## What would get worse if Resource lived in WASM

### 1. Per-render reads

Sidebar / table / `useResource` call `Resource.get()` on every render. Today
that is a JS object property (~70–100 ns).

If the authority is a WASM `Resource` and the UI still wants JSON-AD (the
current `ClientDb.getResource` shape):

| Op | Mean | vs `Resource.get` |
| --- | --- | --- |
| JS `Resource.get(name)` | ~0.07 µs | 1× |
| `JSON.parse` typical resource | ~0.5 µs | ~7× |
| `structuredClone` typical resource | ~1.4 µs | ~21× |
| **WASM `getResource` → JSON string** | **~75 µs** | **~1,000×** |
| WASM `putResource` (parse + index) | ~575 µs | ~8,000× |

Those WASM numbers are **in-process Node**, no Worker. Production `ClientDb`
adds a `postMessage` hop on top. Putting `get()` on that path would make
every React render pay a full resource serialization.

A finer `get_property(subject, prop) -> string` binding would still copy
UTF-8 through `wasm-bindgen` (microseconds, not nanoseconds) and would not
give TipTap a `LoroDoc`.

### 2. TipTap / `loro-prosemirror` needs a JS `LoroDoc`

`Resource.getLoroDoc()` is handed to `LoroSyncPlugin`. That plugin mutates
the `doc` map on the main thread and checks `instanceof` against the
`loro-crdt` WASM instance. A Loro doc that lives in `atomic_wasm`'s heap is
a different module: you cannot pass it into the editor without exporting
snapshots on every keystroke (the expensive path this architecture avoided).

Unifying the two WASM heaps (drop npm `loro-crdt`, use only `atomic_lib`'s
`loro`) would save ~3.1 MB / 1.0 MB gzipped, but it requires either:

- rewriting `loro-prosemirror` against `atomic_wasm` exports, or
- compiling one shared Loro WASM and binding it twice,

neither of which is a `@tomic/lib` migration.

### 3. Signing and keys

Browser agents prefer `SubtleCrypto` so the private key is non-extractable
(XSS). WASM Ed25519 would take a raw seed in linear memory. Native Dalek
signs an auth line in ~24 µs; noble JS is ~284 µs. Saves are not in a
tight loop. Moving signing into WASM is a security and API regression for a
~10× micro-optimization nobody will feel.

WASM **is** a win for bulk hashing: `ClientDb.blake3Hash` on 1 KiB is
~1.4 µs vs noble's ~16 µs (native ~0.74 µs). That binding already exists.

### 4. Binary size and two runtimes

| Artifact | Raw | gzip |
| --- | --- | --- |
| `atomic_wasm_bg.wasm` | 6.1 MB | 2.3 MB |
| `loro-crdt` web WASM | 3.1 MB | 1.0 MB |

`atomic_wasm` already embeds Loro + redb + ed25519 + argon2 + blake3. Moving
Store/Resource logic in would grow the worker module without removing the
main-thread Loro module. Cold start and memory both get worse.

### 5. `@tomic/lib` is an npm library

Node scripts, CLI generators, and non-browser apps depend on it. A WASM-only
core forces `wasm-pack` artifacts on every consumer, or a dual JS/WASM
implementation — which is the duplication you were trying to delete.

## Where more WASM *is* the right call

This is already the plan in `atomic-lib-runtime.md` Phase 6:

- **Query / aggregations / expression filters** — index walks belong in
  `atomic_lib`. `ClientDb.query` is the offline table path. Do not reimplement
  in JS.
- **Persist + applyCommit** — one worker op writes JSON-AD index + Loro
  snapshot (`putResourceWithSnapshot`). Keep going; do not add a third write
  path in JS.
- **Version vectors / drive export** — already in WASM (`getVersionVectorsForDrive`,
  `exportAllResources`).
- **Vault / Argon2 / envelope wrap** — already WASM, correctly (KDF is slow
  on purpose; JS should not reimplement it).
- **Optional later:** genesis encode/verify and commit canonicalization as
  WASM helpers *called at sign/sync time* (once per save), if the golden
  tests become expensive to maintain. Not on the read path.

Flutter is the existence proof that a native `atomic_lib` runtime works —
because there is no TipTap on the same heap and no React render loop reading
`Resource.get()`.

## Pros / cons of "migrate `@tomic/lib` to WASM"

**Pros**

- One implementation of apply/query/persist (true for the node half; already
  happening).
- Drift in genesis/commit/RBSR becomes structurally impossible if JS stops
  encoding them.
- Aligns browser, Flutter, and server on `AtomicNode`.
- Some crypto (blake3, argon2) is faster in WASM than JS.

**Cons**

- Render-path `get` becomes 2–3 orders of magnitude slower unless you keep a
  JS cache — at which point you still have two representations
  (`unify-resource-representations.md`).
- Breaks `loro-prosemirror` unless Loro stays on the main thread (second WASM
  heap, snapshot copies).
- Loses `SubtleCrypto` non-extractable keys if signing moves.
- Larger worker WASM, slower startup.
- Worker + OPFS already serializes durability; folding the cache into that
  worker couples UI jank to fsync.
- npm consumers of `@tomic/lib` should not need a 6 MB WASM to sign a commit.
- Debug/HMR story for a 3.7k-line `Resource` in Rust/WASM is worse than TS.

## Recommendation

Keep the current three-layer split, and name it so future work does not
collapse the wrong boundary:

1. **JS cache / editor** — `Resource`, `Store`, React, TipTap, `loro-crdt`.
   Hot reads, local edits, `LoroDoc` identity. Never block this on WASM or a
   Worker.
2. **WASM node** — `ClientDb` → future `AtomicNode.open({ storage: 'opfs' })`.
   Query, persist, apply, blobs, VV, vault. This is where duplication with
   the server should die.
3. **Must-match protocol in JS** — genesis, canonical commit JSON, WS frames,
   RBSR, drive hash. Small, tested with golden vectors, runs off the render
   path. Move to WASM only if a specific helper is painful to keep in sync,
   one function at a time.

That is not "use less WASM"; it is "use WASM for the node, not for the
view-model." The expensive duplication to delete is still the one
`atomic-lib-runtime.md` describes: server handlers and browser Store both
pretending to be the node. It is not `Resource.get`.
