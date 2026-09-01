# Trust model: the node that owns the URL is trusted; anything that only stores is blind

**Status:** Decision requested (2026-09-01).

> **Decision needed by maintainer**
>
> Question: Is an Atomic node that serves a drive a trusted plaintext verifier, or must it be a blind (E2EE) replica?
> Options: (A) trusted node everywhere, no blind tier. (B) blind node: server stores ciphertext, clients do everything. (C) split by role: the node that owns the URL is trusted with plaintext; the Vault (backup/escrow) is blind.
> Recommendation: **C** — every shipped server function needs plaintext, and the blind store already exists as a separate product (`lib/src/vault/`).
> Blocked PRs: #1310, #1307, #1254; sequencing for #1313.

## Context

[`encryption.md`](./encryption.md) is marked "Exploration / undecided (2026-06)" and lists
"blind replica" and "trusted verifier" as open roles. Two pieces have since shipped and
fixed the shape of the answer:

- **At-rest cache encryption** (browser only): `lib/src/db/encrypted_backend.rs`, wired in
  `RedbStore::new_opfs` (`lib/src/db/redb_store.rs:207`). The native server path
  `Db::init_redb_file` (`lib/src/db.rs:506`) takes no key: a self-hosted or managed
  `atomic-server` keeps `atomic.redb` **plaintext on disk** today. See
  [`opfs-per-agent-encryption.md`](./opfs-per-agent-encryption.md).
- **Blind vault backup v1**: `lib/src/vault/` (envelope, pack, keys, store, sync). The store
  holding vault objects cannot read subjects, values, or counts
  (`a_restore_without_the_right_key_fails`, `sealed_packs_do_not_reveal_subjects`). See
  [`encrypted-vault-format.md`](./encrypted-vault-format.md).

The SaaS side already sells these as two tiers on a "trust spectrum" (`atomic-saas`
`OSS_STRATEGY.md`: Blind = recovery + Cloud Vault; Trusted = Cloud Sync managed node) and
`TIER_SWITCHING_FLOWS.md` §1 states it as a key matrix: Local-Only and Cloud Vault have no
host plaintext access; Hosted Server has plaintext "for index & query".

### What the server reads in plaintext today (verified)

Every row is a function a blind node cannot perform. This list is the cost of option B.

| # | Function | Where | Plaintext it needs |
| --- | --- | --- | --- |
| 1 | Rights check on every read/write/append | `lib/src/hierarchy.rs:214` `check_rights` (`read`/`write`/`parent` propvals, ancestor walk); `RightsCache` `:122` | ACL arrays and `parent` of the resource and its ancestors |
| 2 | Commit apply: Loro merge + atom diff | `lib/src/commit.rs:1014` `apply_changes` → `import_update_with_diff`; `check_append`/`check_write` at `:822`, `:864` | The Loro update and the current snapshot |
| 3 | Full-text search index | `server/src/search.rs:136-160`: `to_json_ad`, title, description, `extract_document_plain_text` into tantivy | Whole resource, document body text |
| 4 | Vector search / embeddings | `server/src/vector_search/common.rs:35` builds plain-text chunks; `embeddings/openrouter.rs` sends them to `openrouter.ai` | Document text, leaves the node when `OPENROUTER_API_KEY` is set |
| 5 | Collections and queries | `lib/src/db.rs:2273` `query_basic` (rights memo); `lib/src/db/query_index.rs` `resource_matches_filter`, `sort_key_for` (drive-scoped, `:31`) | Property values for filter, sort, and the `PropValSub`/`ValPropSub` indexes |
| 6 | WS fan-out and sync readability | `server/src/commit_monitor.rs:355-380` `check_read` on the drive at `SubscribeDrive`; `lib/src/sync/engine.rs:1180` `collect_readable_snapshots` (`check_read` per subject) | Drive and per-resource ACLs; drive membership of each commit |
| 7 | Plugin execution | `server/src/plugins/wasm.rs:709` `get_resource` hands materialized resources to WASM guests; `PluginMeta.agent_secret` `lib/src/db/plugin_meta.rs:10` | Resources the plugin reads, plus a plaintext plugin agent secret on `develop` |
| 8 | Invites, replicate, export | `server/src/plugins/invite.rs:183` writes `read`/`write`; `server/src/plugins/replicate.rs:91` `check_write` on the drive; `server/src/handlers/export.rs:80` `get_resource_extended` per agent | ACLs and full resource bodies |
| 9 | Image renditions | `server/src/handlers/download.rs:216-251` decodes blob bytes, caches renditions in `Tree::Blobs` | Plaintext file bytes |
| 10 | AI | No server-side chat endpoint exists (`server/src/handlers/` has none; chat streams browser→OpenRouter, `browser/data-browser/src/chunks/AI/ClientOnlyTransport.ts`). Server-side AI today is row 4 only. | Row 4; any future hosted proxy (`AI_ACCESS_AND_PRICING.md` option B) reads prompts that contain drive content |

Rows 1, 2, 5, 6 are structural: without them the node cannot decide whether to accept a
commit, whom to fan it out to, or answer a collection. Rows 3, 4, 7, 9, 10 are the
product surface (search, plugins, previews, AI). `encryption.md` § "Search, queries, and
server features" reaches the same list from the other direction.

### What is blind today

Only the vault. `lib/src/vault/store.rs` writes opaque objects keyed under
`vault/<pseudonym>/lanes/<device>/seg-NNNNNN.pack`; the operator sees kind, size, epoch,
lane, timing (`CLOUD_VAULT_ARCHITECTURE.md` "Visible metadata"). The SaaS control plane
brokers presigned URLs and never receives object bytes (`LORO_ENCRYPTED_VAULT.md:117`,
`ENCRYPTED_BLOB_VAULT_MOAT.md:87`).

## Options

| | (A) Trusted node everywhere | (B) Blind node (E2EE) | (C) Split by role |
| --- | --- | --- | --- |
| What it is | Every node that stores a drive may read it. No blind tier; vault is "encrypted backup" only as a courtesy. | The server stores ciphertext envelopes. Clients merge, index, authorize, fan out. | The node that **owns the URL** (serves `GET`, accepts `/commit`, fans out, indexes, runs plugins/AI) is a trusted plaintext verifier. Anything that **only stores** (vault, S3 bucket, escrow) is blind. |
| Rows 1, 2, 6 (auth, apply, fan-out) | unchanged | Needs a blind authorization model: `encryption.md` lists four candidates, none chosen; ACLs live inside the ciphertext | unchanged on the node; the vault does no authorization (v1 is same-agent drives only, `CLOUD_VAULT_ARCHITECTURE.md` decision 7) |
| Row 5 (queries) | unchanged | Gone on the server; every client re-derives `QueryMembers` locally; no `/query` for external apps | unchanged |
| Rows 3, 4 (search) | unchanged | Gone; client-only search, no hosted full-text | unchanged |
| Row 7 (plugins) | unchanged | Scheduled / server-placed runs impossible (`plugin-secrets.md`: "a plugin importing at 3am has nobody to ask for a passkey") | unchanged |
| Rows 9, 10 (previews, AI) | unchanged | Gone | unchanged |
| Blob GC, compaction | unchanged | Blind replica cannot see `File` refs or validate a checkpoint (`encryption.md` § Compaction, § Blobs) | node does GC; vault GC uses signed coverage maps it already has |
| Product | Contradicts the SaaS "Blind" tier already sold (`OSS_STRATEGY.md` Trust Spectrum) | Contradicts Cloud Sync, hosted URLs, hosted AI, every plugin | Matches `TIER_SWITCHING_FLOWS.md` key matrix exactly |
| Verdict | Loses the blind vault for nothing | Rebuilds the server as a relay; ships nothing until a blind-authorization design exists | Names what is already built |

## Recommendation

**C.** The rule, quotable:

> **The node that owns the URL is trusted with plaintext; anything that only stores is blind.**

"Owns the URL" means: it is the node a subject resolves to for `GET`/`/commit`/WS — the
one that checks rights, materializes Loro, indexes, fans out, runs plugins and serves AI.
That node holds the drive key (or the plaintext directly) and protects it **at rest** with
a node-held key. "Only stores" means: it never decrypts, never authorizes on content,
never indexes — vault objects, S3 blob bytes, recovery blobs. Trust is a property of the
role, not of who operates the machine: a self-hosted node and a managed Cloud Sync node
are both trusted; a self-hosted MinIO bucket and the SaaS Vault are both blind.

Consequences per area:

- **[`encryption.md`](./encryption.md)** — close the E2EE / blind-replica question as
  **"at-rest + vault"**: local cache at rest (shipped), server at rest (to build, see
  step 2), blind vault (shipped). Mark "Blind replica" and "Optional trusted verifier"
  candidate models as *not planned*. Reopen only if a concrete design demonstrates, on
  ciphertext, all three of: (a) **authorization** — accept/reject a commit against
  `read`/`write`/`append`/`parent` without reading them; (b) **indexing** — answer a
  drive-scoped `QueryFilter` and full-text search; (c) **fan-out** — decide which
  subscribers may receive a commit. Anything short of all three is a vault, and the vault
  exists.
- **Zones plaintext ACLs** ([`zones.md`](./zones.md), #1254) — fine. Rights arrays stay
  plaintext propvals read by `check_rights`; the zone index is a derived plaintext index on
  the trusted node. `zones.md`'s aside that "ACL properties stay plaintext containers even
  in an encrypted zone, so blind hubs can enforce admission" is compatible but not required
  by this decision; do not build blind-hub admission.
- **Plugin secrets** (`plugin-secrets.md`, #1307) — node-held, encrypted at rest under a
  node key beside `config.toml` (`server/src/node_key.rs` on `origin/feat/plugin-model`,
  wrapper kind `NodeKey` in `lib/src/vault/secret_envelope.rs`). Correct under C: the node
  spends the secret in unattended runs, so the node must be able to open it. Never a
  resource, never synced.
- **S3 blobs** ([`s3-blob-storage.md`](./s3-blob-storage.md)) — the bucket is a blind
  store. Its v1 "rely on S3-side SSE" is not enough under the rule: encrypt blob bytes with
  a node-held key before `put`, so the bucket operator sees ciphertext keyed by a hash the
  node chooses (the vault already keys blobs by `blake3::keyed_hash`, reuse it). The node
  decrypts to serve `/download` and renditions (row 9). `ENCRYPTED_BLOB_VAULT_MOAT.md:179`
  already states the S3 backend keeps the node "a queryable, plaintext-indexing node".
- **OIDC root keys on the node** (#1310, `planning/oidc-oauth.md` §4a on
  `origin/cursor/oidc-oauth-reconsider-1cb5`): "The node mints the root Agent, wraps it
  with a node-held KEK, stores it keyed by `(iss, sub)`. The private key does not go to the
  browser." The PR calls this "custodial of the root, on purpose." Under C that is the
  trusted node holding a secret at rest — allowed, and it must use the same node key as
  plugin secrets, not a second KEK.
- **SaaS tier switching** (`TIER_SWITCHING_FLOWS.md`) — what moves between tiers is the
  `DriveVaultKey`, nothing else. Local→Vault: client keeps the key, uploads ciphertext (Flow
  A). Vault→Hosted: client wraps the key to the hosted node's pubkey; node decrypts the
  vault into redb + tantivy and switches to live plaintext sync (Flow C; UI must say the
  server can read the drive). Hosted→Vault: node flushes to vault, volume scrubbed, key
  forgotten (Flow D). Vault stays an incremental backup target beside a hosted node; its
  privacy benefit is superseded while the node exists (§4 Q2).
- **AI access** (`AI_ACCESS_AND_PRICING.md`) — the node reads plaintext to serve AI. Today
  that is only embeddings (row 4); BYOK chat stays browser→OpenRouter and blind to us. A
  hosted proxy (that doc's option B) moves hosted AI to the trusted side; it must run on,
  or with the same disclosure as, the trusted node, with no prompt retention. A blind tier
  never gets AI over drive content.
- **Sync peers** — a peer that receives a drive over `SYNC` is a node that owns the data
  for its own reads: trusted by construction (`collect_readable_snapshots` already filters
  per agent). Same-agent P2P ([`serverless-p2p.md`](./serverless-p2p.md)) is unaffected.

Sequencing:

1. Edit `encryption.md` status to "Closed: at-rest + vault (2026-09)"; keep the "Keys"
   and "Blobs" sections as the reference for steps 2–3; move the blind-replica sections
   under a "Not planned" heading with the three-part reopen test above.
2. **Server at rest.** Give `Db::init_redb_file` (`lib/src/db.rs:506`) the same
   `Option<&[u8; 32]>` that `new_opfs` has and open native redb through
   `EncryptedBackend`, keyed by the node key from #1307. This is what makes "trusted with
   plaintext" mean *in process*, not *on disk*. Behind a flag; migration copies like
   `migrate_legacy_db` (`lib/src/db/opfs_backend.rs:151`).
3. **One node key.** Land `server/src/node_key.rs` (#1307) first; #1310's root-agent KEK and
   `s3-blob-storage.md` Phase 2a's `Secret` DEK derive from it.
4. **Blob encryption** before any S3 backend ships (`s3-blob-storage.md` phase 1b): the
   `BlobBackend` trait takes ciphertext; `RedbBlobBackend` may skip it once step 2 lands.
5. `zones.md` and `index-performance.md` proceed unchanged; nothing in them assumed a
   blind node.

## Consequences for open PRs

- **#1310** (OIDC/OAuth retarget) — merge-as-is on the trust question: node-held root key
  is the trusted node holding a secret at rest. Change: wrap under the shared node key from
  #1307 rather than a PR-local KEK; rebase-after-#1307.
- **#1307** (plugin model, `plugin-secrets.md`) — merge-as-is on the trust question. Its
  node-key encryption at rest (`server/src/node_key.rs`, `NodeKey` wrapper) is the first
  concrete piece of step 2/3; the unbuilt "user-wrapped half" stays not built. Ask: land
  the node-key module in a way #1310 and step 2 can import.
- **#1254** (ACL zones) — merge-as-is on the trust question: plaintext ACLs on the trusted
  node are the model. No blind-hub admission work.
- **#1313** (commits as signed envelopes) — unaffected by A/B/C, but relevant to step 1:
  dropping stored content commits removes the "blind replica must retain every encrypted
  update" concern from `encryption.md` § Compaction; note it there when closing.
- **#1300** (ecosystem integrations / webhooks) — planning only; outbound webhooks read
  plaintext resource events on the trusted node, consistent with C.
- **#1259** (single OpenAI-compatible AI endpoint, draft) — browser-side; keep BYOK
  browser→provider as the blind path per `AI_ACCESS_AND_PRICING.md`.
- **#659** (s3 uploads, 2024), **#1110** (OpenDAL persistable), **#1117** (SQLite storage)
  — stale storage-backend PRs predating `s3-blob-storage.md`. Close, or rebase-after step 4
  with blob bytes encrypted before leaving the node.
- No open PR proposes a blind live replica; nothing is blocked on option B (unverified
  only for PR branches whose diffs exceed the 20k-line API limit, #1307).
