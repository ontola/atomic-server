# Self-Verifying Genesis Certificate

> **Status:** Proposal (2026-06-03). Builds on
> [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md),
> [`sign-at-drain.md`](./sign-at-drain.md), and
> [`loro-source-of-truth.md`](./loro-source-of-truth.md).
>
> Reframes a DID resource's identity as a small, **inline, binary,
> self-verifying genesis certificate** carried on the resource itself — no
> commit fetch, verifiable offline.

## Thesis

A DID resource's identity is its genesis: `did:ad:<signature>`. Today that
signature is over the first **commit** (which embeds the initial `loroUpdate`),
and anything wanting to show or verify "who created this, when" must fetch the
`did:ad:commit:<sig>` resource. Under sign-at-drain that commit is not reliably
refetchable, so creation metadata silently disappears on reload (the chatroom
author/date bug).

The resource should instead **carry its own genesis proof inline** — a compact
binary certificate, stored as an immutable propval, serialized in JSON-AD with
everything else. Then:

- `createdBy` / `createdAt` are read from it (and materialized into propvals for
  query/sort/display).
- "Verify signature" is a pure-local Ed25519 check — no network.
- It travels with the object: hand someone the resource and they can verify its
  authorship and identity.

## Background: what already shipped (the metadata bug fix)

Independent of this proposal, the immediate chatroom bug is fixed:

- The server (and the WASM ClientDb) derive `createdAt` (genesis Loro-change
  timestamp) and `createdBy` (genesis Loro-change message = signing agent) in
  `materialize_propvals_from_loro_doc`, storing them as propvals — so they are
  **indexable** (collection `sort_by: createdAt`) and **serialized in JSON-AD**.
- The client reads them **propval-first, oplog-fallback**
  (`Resource.getCreatedAt` / `getCreatedBy`); React hooks `useCreatedAt` /
  `useCreatedBy`.
- The chatroom no longer depends on commits for display (`CommitDetail` takes
  `createdAt` / `createdBy`; message views pass no `commitSubject`).
- e2e: chatroom + offline-chatroom assert creator + date survive a reload.

Three things this required, found while getting the e2e green — they also
foreshadow the certificate design:

- **The genesis change is selected by Lamport, not timestamp.** The server adds
  a `lastCommit` change after apply with a *second-resolution* timestamp that
  can sort before the client's millisecond genesis within the same second.
  Timestamp-based selection mis-picked that later, message-less change as the
  genesis → empty `createdBy`. `genesis_change()` (Rust) and `getGenesisChange`
  (TS) now pick the lowest Lamport (causal order); the founding change is always
  the minimum.
- **The creation metadata must ride on the FIRST commit.** `signChanges` calls
  `writeDatatypeTags`, whose `doc.commit({origin: system})` is the first commit
  on a new doc and thus creates the genesis change. A later `commit({message})`
  is a no-op (no pending ops). So the agent subject + ms timestamp are set on
  *that* first commit (passed through from `signChanges` at genesis).
- **No rejection of client-set `createdAt`/`createdBy`.** An earlier attempt to
  reject commits that set them broke legitimate saves: the materialized values
  round-trip to clients in JSON-AD, so a later edit (e.g. saving an agent's
  name) re-sends them and was rejected, stalling the outbox. Forge-resistance is
  the certificate's job (identity signed into the DID, not a settable propval),
  not a server-side reject.

This proposal supersedes the *source* of that metadata: instead of reading the
genesis Loro change, both come from the genesis certificate.

This proposal supersedes the *source* of that metadata: instead of reading the
genesis Loro change, both come from the genesis certificate.

## The certificate

A single immutable propval on every DID resource:

```
https://atomicdata.dev/properties/genesis  →  bytes (base64 in JSON-AD)
```

It is the **signed payload only**. The signature is *not* stored in it — the
signature is the subject (`did:ad:<base64url(signature)>`), so storing it again
would be redundant.

### Binary layout (v1)

All multi-byte integers little-endian. Fixed fields first, the one
variable-length field (`parent`) last.

```
offset  size  field
------  ----  -----------------------------------------------------------
0       1     version        (0x01)
1       1     flags          bit0 = has stateHash; bits1-7 reserved (0)
2       32    signerPubKey   Ed25519 public key of the creating agent
34      8     createdAt      i64, Unix milliseconds
42      16    nonce          CSPRNG random (uniqueness; see below)
58      32    stateHash      Blake3 of the canonical genesis projection
                             (present iff flags.bit0; omitted otherwise)
58|90   var   parent         u16 length-prefix + UTF-8 subject
                             (DID or HTTP URL of the ORIGINAL parent)
```

- With `stateHash`: 90 bytes + `parent`. Without: 58 bytes + `parent`.
- **`version` is load-bearing.** A signed layout can never change retroactively
  — only new versions can be added. Verifiers dispatch on `version`.
- **`flags.bit0`** lets `stateHash` be optional without a second format.

### Field rationale

- **`signerPubKey`** — the agent's Ed25519 public key, raw (32 bytes). Carrying
  it inline makes the cert self-contained for verification; the verifier still
  cross-checks it against the `createdBy` / signer agent.
- **`createdAt`** — the single source of the creation timestamp (ms).
- **`nonce`** — **required.** Ed25519 is deterministic: `sign(key, msg)` is a
  pure function, so `{signer, parent, createdAt}` alone would produce identical
  signatures — hence identical DIDs — for two resources created by the same
  agent under the same parent in the same millisecond (tight loops, batch
  creates). Today the `loroUpdate`'s random Loro peer-id supplies this entropy;
  dropping `loroUpdate` means re-supplying it. Use a **dedicated CSPRNG nonce**,
  not the Loro `peerId` — the peer-id is a CRDT-internal detail with its own
  lifecycle (can be reset/set/reused), and identity must not depend on the
  storage engine's internals.
- **`stateHash`** (optional, **DECIDED OUT for v1 — reserved via the flag**) —
  Blake3 over the **canonical materialized projection** (sorted-key JSON-AD,
  `loroUpdate` excluded), per `commit-retention-and-state-certificates.md`.
  Would bind the *initial content* so verifying the cert also proves "this agent
  authored this exact starting state." **Deliberately left out of v1**: it
  re-introduces the cross-language JSON-canonicalization determinism problem
  that the binary cert was specifically designed to avoid (TS and Rust would
  have to hash the projection to byte-identical bytes). The cert stays a pure,
  fully-binary, JSON-free identity blob. The `flags` bit is reserved so a future
  version can add content-binding **additively, with no format/version bump**,
  for resources that need tamper-evident initial state (regulated records, etc.).
- **`parent`** — hierarchy is authorization in Atomic, so the cert binds the
  birth context. NB: this is the **original** parent (immutable provenance);
  the resource's *current* `parent` propval is mutable and drives *live*
  authorization. They are different facts and must not be conflated.

### Why binary, not JSON

1. **Determinism.** The signature is verified against byte-identical input. JSON
   canonicalization (key order, number formatting, unicode) is a classic
   verification footgun — `serialize_deterministically_json_ad` exists to fight
   it. A fixed binary layout has no canonicalization ambiguity: the signed bytes
   *are* the blob.
2. **Size.** ~90 bytes + parent vs. several hundred bytes of JSON-AD keys +
   base64 + URLs.

## DID derivation (changes!)

```
payload   = genesis cert bytes (layout above)
signature = Ed25519_sign(agentPrivKey, payload)
subject   = "did:ad:" + base64url(signature)
```

This **replaces** today's derivation (signing the first commit, which embeds the
`loroUpdate`). Foundational change — see Migration.

## Creation flow (DECIDED: identity-only)

The cert mints *identity*; it does **not** carry content. Creation splits the
two concerns that are one today, and maps onto the existing sign-at-drain
"genesis envelope + delta" shape:

1. Build the initial doc (propvals) as now.
2. Generate the `nonce` (CSPRNG), gather `signer` / `createdAt` / original
   `parent`, build the `GenesisCert`, sign it → `DID = did:ad:<sig>`.
3. The **genesis envelope is the cert** (no `loroUpdate`) — it mints the DID and
   creates the resource shell.
4. The **initial content is the first delta commit** — the normal, already-built
   signed-commit path, POSTed under the new DID.

So the genesis envelope changes type (commit-with-loroUpdate → cert), but the
content path is unchanged. One signature mints identity; content is signed
separately by the existing machinery. `createdBy` / `createdAt` / original
`parent` are materialized from the cert.

## Verification (pure-local, no fetch)

```
1. blob   = resource.get(genesis)                  // already in hand
2. sig    = base64url_decode(subject - "did:ad:")
3. pubkey = blob.signerPubKey
4. ok     = Ed25519_verify(sig, blob, pubkey)
5. assert "did:ad:" + base64url(sig) == subject     // (trivially true; the
          // meaningful check is step 4 binding pubkey+payload to that sig)
6. cross-check pubkey resolves to blob's signer agent (createdBy)
7. if blob.stateHash present: recompute Blake3 of the canonical projection at
   genesis and compare (content-authorship check)
```

`@noble/ed25519` (already a dependency, via `CryptoProvider`) provides `verify`.

## Immutability

`genesis` is **reserved and server-managed**: written once when the resource is
created, never by a later commit. Any commit that sets it is rejected — the same
mechanism already guarding `createdAt` / `createdBy` in
`validate_and_build_response`.

## Materialized facts vs. the proof

The binary cert is the *proof*. The human-readable, queryable facts are
materialized as ordinary propvals from it at apply time:

- `createdBy`  ← cert `signerPubKey` → agent DID
- `createdAt`  ← cert `createdAt`
- `parent`     ← (current parent is its own mutable propval; the *original* is in
  the cert)

No redundancy concern: the cert is the source, the propvals are the derived
projection used for sorting/display/querying. Binary is not eyeball-able in the
data view, so `verifyGenesis()` decodes it for display (signer, time, parent,
✓/✗).

## Decisions made

- **`stateHash`: OUT for v1** (identity-only cert). It binds initial content but
  re-introduces JSON-canonicalization determinism across TS/Rust — the very
  thing the binary cert avoids. The `flags` bit is reserved so it can be added
  additively later, no version bump. See `stateHash` under "Field rationale."
- **Creation = identity cert + separate content commit** (see "Creation flow").
- **DID derivation changes** (breaking) — accepted on this branch; see Migration.

## Code impact / implementation order

1. **Spec freeze** — the v1 byte layout above (version + flags).
2. **DID derivation** — sign the binary cert instead of the loroUpdate-bearing
   commit: `lib/src/commit.rs` `create_did`, browser `lib/src/resource.ts`
   `signChanges`, and the wasm path.
3. **Store + reserve** — write the `genesis` blob onto the resource at apply
   (server `commit.rs` + `wasm`), reject overwrites.
4. **Materialize** — derive `createdBy` / `createdAt` (and original `parent`)
   from the cert (reuses the existing materialization chokepoint).
5. **`verifyGenesis(resource)`** in `@tomic/lib` — decode + Ed25519 verify + DID
   check (+ optional stateHash check). Returns `{ valid, signer, error? }`.
6. **UI** — decoded display + "Verify signature" button in `DataRoute`.

## Migration

DID derivation changes, so existing resources' DIDs were minted the old way and
have no `genesis` cert. On this branch (`did-rebased2`) that is acceptable to
reset, but note:

- Old DID resources won't have a `genesis` propval → `verifyGenesis` returns
  "not available" (a first-class state, not an error), and `createdBy` /
  `createdAt` fall back to the genesis Loro-change path already implemented.
- A one-time backfill could synthesize certs only where the original genesis
  commit is still retained; otherwise leave unverifiable. Out of scope for the
  first cut.

## Datatype

Transport binary as base64 in JSON-AD (the `loroUpdate` value is already
`Vec<u8>` carried this way). `genesis` gets a bytes datatype or reuses that
binary-value path.
