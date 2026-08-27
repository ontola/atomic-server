# Cloud Sync, Onboarding & Managed-Node Integration

Tracks the **relevant files** for the cloud-sync / onboarding / managed-node
work, spanning `atomic-server` (this repo: data plane + browser) and
`atomic-saas` (control plane + portal). Companion to
`atomic-saas/planning/SAAS_ATOMIC_SERVER_CONTRACT.md` (the cross-repo contract).

## Concept

- **atomic-server identity** = local DID agent secret (IndexedDB). Independent
  of the account **session** (email + `session_token` cookie). Both can be
  signed-in/out independently.
- **The control-plane client is NOT in the open core** (FOSS guardrail #3). The
  open `atomic-server` exposes only a generic embedder hook
  (`serve::serve_with_hook(config, on_ready)`), a generic `managed` flag on
  `AppState`, `GET /node-info`, and the generic `SyncPolicy` mechanism — all
  permissive/false by default, no phone-home.
- A **managed node** = the closed `atomic-saas/managed-node` binary, which
  embeds `atomic_server_lib` and, via the hook, flips `managed`, installs an
  `AllowlistPolicy`, and spawns the heartbeat / policy poll / usage report /
  replication pull. Enabled by `ATOMIC_MANAGED_URL`.
- **FOSS / self-hosted** runs the plain `atomic-server` binary (no-op hook):
  unrestricted (`OpenPolicy`) on localhost, `/node-info` reports
  `managed: false`, never phones home. Putting that same binary on a public
  address without a local allowlist is an open sync hub — the proposed FOSS
  fix is [`foss-public-host-mode.md`](./foss-public-host-mode.md), which
  reuses `AllowlistPolicy` without a control plane. FOSS localhost UX does
  not change.

> **Do not put the control-plane client back in the open `atomic-server`.** The
> recovery restored a pre-deletion `server/src/saas.rs`; it was renamed `node.rs`
> and re-wired into `serve.rs`, which re-violated guardrail #3. Removed again
> (commit on `did`); it lives in `atomic-saas/managed-node`.

## Relevant files — atomic-server (data-browser)

| Area | File |
| --- | --- |
| Onboarding / sign-in / restore flow | `browser/data-browser/src/views/getting-started/GettingStartedFlow.tsx` |
| New-identity (username, drive, recovery backup) | `browser/data-browser/src/components/NewIdentitySection.tsx` |
| Node managed-info + `accountCreationTarget` (+ test) | `browser/data-browser/src/helpers/managedServer.ts` (`.test.ts`) |
| Drive sign-in guard decision (+ test) | `browser/data-browser/src/helpers/isDriveSignInError.ts` (`.test.ts`) |
| Guard redirect → welcome `?next=` | `browser/data-browser/src/views/ErrorPage.tsx` |
| Welcome route search params (`next`, `from_cloud`) | `browser/data-browser/src/routes/WelcomeRoute.tsx` |
| Cloud API base / session / enrollment / recovery | `browser/data-browser/src/helpers/cloud/*.ts` |
| Drive usage helper (Sync route) | `browser/data-browser/src/helpers/cloudUsage.ts` |

## Relevant files — atomic-server OPEN core (generic mechanism only, NO client)

| Area | File:def |
| --- | --- |
| Embedder hook (calls `on_ready(&appstate)`) | `server/src/serve.rs` (`serve_with_hook`); `serve` passes a no-op |
| Generic `managed` flag + learned portal URL | `server/src/appstate.rs` (`managed: AtomicBool`, `managed_dashboard_url`) |
| `GET /node-info` → `{ managed, dashboardUrl }` (reads the generic flag) | `server/src/routes.rs` (`node_info_handler`) |
| `DriveUsage` + `Db::per_drive_usage(&[drive])` + `has_resource_locally` | `lib/src/db.rs` |
| Sync admission/quota policy + `allowed_drive_subjects` | `lib/src/sync/policy.rs` (`AllowlistPolicy`, `SyncPolicy`, `OpenPolicy`) |
| Per-drive resource grouping (used by usage + replication) | `lib/src/sync/engine.rs` (`collect_drive_subjects`) |
| Iroh peer sync + pkarr discovery (generic) | `lib/src/sync/peer.rs` (`sync_drive_with_peer_outcome`, `get_node_id`); `lib/src/discovery.rs` (`resolve_node_id_filtered`) |
| Replication e2e test (generic) | `lib/src/sync/iroh_e2e.rs::e2e_managed_node_replicates_missing_drive` |

## Relevant files — control-plane CLIENT (closed: `atomic-saas/managed-node`)

| Area | File:def |
| --- | --- |
| Wrapper: embeds the open server via the hook | `managed-node/src/main.rs` (`main` → `serve_with_hook`, `install_managed`) |
| Heartbeat (+iroh id) / policy poll / usage report | `managed-node/src/main.rs` (`send_heartbeat`, `refresh_policy`, `send_usage`) |
| Decoupled replication pull (own task, 8s/drive) | `managed-node/src/main.rs` (`spawn_replication_pull`, `pull_allowed_drives`) |
| Config from env (`ATOMIC_MANAGED_URL`, `_NODE_ID`, `_REGION`, `_HEARTBEAT_INTERVAL`) | `managed-node/src/main.rs` (`ManagedConfig::resolve`) |

## Relevant files — atomic-saas (control plane + portal)

| Area | File |
| --- | --- |
| Cross-repo contract (canonical) | `planning/SAAS_ATOMIC_SERVER_CONTRACT.md` |
| Node routes: heartbeat / node-policy / node-usage | `src/main.rs`, `src/enrollments.rs` |
| Enrollment + node models (incl. `http_origin`) | `src/models.rs`, `src/enrollments.rs` |
| Portal: drives list, drive links, post-verify redirect | `portal/src/App.tsx` |

## Control-plane API contract (node ⇆ control plane)

Matches `atomic-saas` exactly (locked by its `node_policy_matches_managed_node_wrapper_contract` test):

- `POST /api/nodes/heartbeat` — `{ id, iroh_node_id?, http_origin?, region?, capacity_bytes?, used_bytes?, active_drive_count? }` → `{ status: "ok" }`. `http_origin` flows heartbeat → `SyncNode` → enrollment, so drives gain a clickable origin.
- `GET /api/node-policy?node_id=` — `{ portal_url?, allowed_drives: [{ drive_subject, quota_bytes? }] }`. Installed as `AllowlistPolicy`; `portal_url` → `managed_dashboard_url` → `/node-info`.
- `POST /api/node-usage` — `{ node_id, drives: [DriveUsage{ drive_subject, name?, resource_count, blob_bytes, loro_bytes }] }` → `{ updated }`.

## Enrollment ⇆ node matching (the join key)

- The control plane picks a node at **enrollment creation** (`nodes::get_available_node`) and writes `enrollment.node_id`. In dev that's the seeded `Node.id = "local-dev"` (`atomic-saas/src/nodes.rs::seed_dev_node`).
- A node's heartbeat `id` **must equal** that `node_id`. The wrapper's `ManagedConfig::resolve` reads it from **`ATOMIC_MANAGED_NODE_ID`** (falling back to the server origin), so a managed node must be configured with its control-plane id (dev: `local-dev`).
- With the ids aligned: `GET /api/node-policy` returns the enrollment in `allowed_drives`; the node installs it as `AllowlistPolicy`; `enrich_node_identity` backfills `node_iroh_id` + live `http_origin` onto the enrollment; and the usage report flips the enrollment **Active** (`record_usage`).

## Admission enforcement (paid-service abuse prevention)

A managed node should only accept writes/sync for drives it actually hosts (the
control-plane allowlist) — otherwise a random user (no SaaS account, no email)
could point a drive at the paid node and use it for free.

**Status: implemented (2026-07) as a bootstrap-grace admission gate.** The
commit-time approach described below as "reverted/dead" was reintroduced with a
grace window that specifically fixes the ordering/agent problems that sank the
first attempt. Design + status: `atomic-saas/planning/ENFORCEMENT_GATE.md`.

- ✅ **`SyncPolicy::admit_drive_write`** (`lib/src/sync/policy.rs`) — allowlist +
  quota, plus a bootstrap grace (default 10 min) keyed on **first-seen-on-node**,
  so a drive can sync while its enrollment is still propagating. No-op under the
  default `OpenPolicy` (self-hosted / FOSS unaffected).
- ✅ Enforced in `commit.rs::validate_and_build_response` (HTTP `POST /commit` +
  WS `COMMIT`, both via `apply_commit_json` with `validate_rights: true`) and in
  `sync::engine::import_sync_push` (bulk `SYNC_PUSH`). This is the commit-time
  approach the earlier note called dead — the two problems that broke it before
  are now handled explicitly:
  - **Create-before-enroll ordering** → covered by the bootstrap grace: the
    drive's genesis + setup commits land during the grace window; once enrolled,
    admission is permanent regardless of grace expiry.
  - **Agents caught in the net** → the exemption is keyed on
    `commit.subject.is_agent_did()` (the commit's actual signed DID structure),
    **not** a claimed `IS_A` propval — an earlier version of this exemption used
    `IS_A`, which is an ordinary client-controlled property with no required-props
    gate on the `Agent` class, and let any client skip the gate by tagging
    arbitrary data `IS_A: [Agent]`. Fixed; regression tests in `commit.rs`
    (`admission_gate_rejects_spoofed_agent_tag_on_unenrolled_drive`,
    `admission_gate_admits_real_agent_did_on_unenrolled_node`) lock this in.
- ✅ **Fixed 2026-07: Iroh live-sync `UPDATE`/`DESTROY`.** Was a full bypass of
  both the ACL and the admission gate (pre-existing since ~April 2026, predates
  this feature) — `AtomicHandler::accept` had no peer allowlist, and once a
  connection reached "live mode" the read loop wrote with no rights check and
  no policy check at all. Fixed uniformly (no inbound/outbound branching):
  mutual best-effort `AUTH` (acceptor now also authenticates back, existing
  frame type, not required — so anonymous access to genuinely public
  resources is unaffected), the resulting identity threaded into
  `register_live_peer`, and `admit_drive_write` + `check_write` checked once
  per (connection, drive) — cached, not per-frame, to keep live typing/collab
  fast. See `atomic-saas/planning/ENFORCEMENT_GATE.md` for the full design and
  `lib/src/sync/peer.rs::live_write_admission_tests` for the regression
  coverage.
- The `AllowlistPolicy`, `set_sync_policy`, `allowed_drive_subjects`, and
  `has_resource_locally` plumbing is shared with the proactive pull.
- Note: enrollment itself requires a verified-email session (`require_user` →
  magic-link); there is no payment/plan gate yet (billing concern, separate).

## Status

> **Qualified 2026-09-01.** Every "verified end-to-end" / "confirmed live"
> line below was exercised against the SaaS `LocalProcessNodeProvider`
> (`atomic-saas/src/infrastructure/local_process.rs`), which launches the
> managed-node binary with `ATOMIC_MANAGED_URL` / `ATOMIC_MANAGED_NODE_SECRET`
> wired. Production nodes are provisioned by
> `atomic-saas/src/provisioning/templates/cloud-init.yaml`, which today
> downloads the plain release `atomic-server` and starts it with
> `--port 8080 --domain … --server-url …` — no managed wiring at all. So the
> managed path is verified; the template fix (atomic-saas #22, merged
> 2026-09-01) makes newly provisioned nodes run it. Read the checkmarks as "works when the node is
> run managed".

- ✅ **Signed enrollment proof (client half).** `createManagedSyncEnrollment`
  (`helpers/managed/enrollment.ts`) now requests `POST /api/sync-enrollments/challenge`,
  signs `"{challenge} {timestamp}"` with the agent's key via `@tomic/lib`'s
  `createAuthentication`, and sends `proof: { nonce, public_key, timestamp, signature, genesis_cert? }`
  — `genesis_cert` (the drive's `genesis` propval) only for a drive that is not the
  agent's personal drive. A 404 on the challenge route (older control plane) falls back
  to the unsigned request; 403 `enrollment_proof_required` / `enrollment_proof_invalid`
  surface as a plain-language error. Server half: atomic-saas PR #24
  (`ATOMIC_SAAS_REQUIRE_ENROLLMENT_PROOF` can be flipped on once this ships).

- ✅ Onboarding: new user (username-from-email, auto cloud-sync, recovery backup), sign-in, restore (forgot secret).
- ✅ Managed-node detection: `Create account` → portal when managed, else local (FOSS).
- ✅ Drive sign-in guard: returning user on a new device → sign-in/recover → lands in the clicked drive.
- ✅ Naming: `saas` scrubbed from FOSS code (`node.rs`, `cloud*`, `from_cloud`, `VITE_CLOUD_API_BASE`).
- ✅ Heartbeat/policy/usage verified end-to-end against the control plane (zero failures; node registered; `portal_url` learned).
- ✅ Enrollment ⇆ node matching via `ATOMIC_MANAGED_NODE_ID`: enrolled drive lands in `allowed_drives`, enrollment goes **Active**, node identity (iroh id + `http_origin`) shown.
- ✅ Usage report scoped to the **allowlisted** (hosted) drives, not the node's own agent drives (`per_drive_usage(drive_subjects)` + `AllowlistPolicy::allowed_drive_subjects`).
- ✅ **End-to-end onboarding → Active verified.** New user onboards → drive genesis is pushed to the node over WS `COMMIT` (`COMMIT_OK`; the drive is private so an unauthenticated GET returns "not found" even though it's there — don't be fooled) → the enrollment flips **Active** with `resource_count ≥ 1`. Confirmed live.
  - **Root cause of an earlier "stuck Pending" bug (fixed):** `pull_allowed_drives` ran *inside* the policy-poll loop, and with many accumulated drives it stalled on Iroh connect-timeouts, so `refresh_policy` never re-ran → the allowlist froze → new enrollments never got a usage report → stuck Pending. Fix: `spawn_replication_pull` runs the pull on its **own task** (never blocks policy refresh / usage reporting), and each drive's attempt is bounded to 8s (`node.rs`, `serve.rs`).
- ✅ **Proactive replication pull wired**: on its own task, the node walks its allowlist and, for every drive it doesn't already host (`Db::has_resource_locally`), resolves a peer via pkarr (`discovery::resolve_node_id_filtered` — drive DID → Iroh NodeIDs) and Iroh-pulls it (`sync::peer::sync_drive_with_peer_outcome`). In `node.rs::pull_allowed_drives`, driven by `spawn_replication_pull` (NOT the policy poll). Idempotent; skips already-hosted drives; per-drive 8s timeout. Discovery is **pkarr, not the control plane** (decoupled; the control plane could carry the source node as an optimization later).
  - Verified the loop runs against the live control plane (resolves peers, attempts Iroh sync).
  - **Replication itself is verified by an automated localhost test** — `sync::iroh_e2e::e2e_managed_node_replicates_missing_drive`: a drive on endpoint A that B doesn't have is Iroh-pulled to B (the same `sync_drive_with_peer` call the managed node uses), after which B hosts it (`has_resource_locally` → true) and reports `resource_count > 0`. No relay needed — two endpoints on localhost connect via direct address (`add_node_addr`), which is why this works in the sandbox even though the public iroh.network relays are unreachable. Run: `cargo test -p atomic_lib --features "iroh,db-redb" --lib sync::iroh_e2e -- --test-threads=1`.
  - The only piece NOT exercised locally is the pkarr discovery hop (drive DID → NodeID), which needs a pkarr relay; the test substitutes a direct address for it. Full prod path (pkarr resolve + relay-assisted connect) needs a real network.
  - ⏳ Follow-ups: parallelize the pull + backoff for no-peer drives (still sequential, just no longer blocking); re-announce pulled drives via pkarr; and the sync-path admission gate (below).

> **Note:** Status entries above that name `node.rs` / `serve.rs` spawn wiring now
> refer to `atomic-saas/managed-node/src/main.rs` — the client was moved out of the
> open core (see the correction note near the top). The open server's
> `serve_with_hook` was also fixed to actually invoke `on_ready` (recovery gap).

## Test coverage

| What | Test | Where |
| --- | --- | --- |
| Replication (drive A→B via Iroh, then hosts + reports usage) | `e2e_managed_node_replicates_missing_drive` | `lib/src/sync/iroh_e2e.rs` (open, generic) |
| `accountCreationTarget` (managed→portal / FOSS→local) | `managedServer.test.ts` | data-browser (open) |
| Drive sign-in guard decision | `isDriveSignInError.test.ts` | data-browser (open) |
| Onboarding create + fresh-device sign-in (e2e) | `onboarding.spec.ts` | browser/e2e |
| Full onboard → enrollment Active via the wrapper | manual (this session) | needs full stack; not automated |
| Control-plane wire contract | `node_policy_matches_managed_node_wrapper_contract` | atomic-saas (closed) |

Gaps: no automated e2e for the wrapper's onboard→Active (needs the full stack +
control plane). The pkarr discovery hop isn't exercised locally.

## Open items (TODO)

1. **Browser de-branding:** strip `cloud`/`saas` from the data-browser
   (`helpers/cloud/*`, `getCloudApiBase`, `CloudAccount`, `from_cloud`,
   `IdentityReconcileGate` copy). Neutral term TBD ("control plane" for code,
   "account"/"sync" for UI). **Held pending the agreed term.**
2. **IdentityReconcileGate:** wired into `RootRoutes` this session (silent
   convergence at boot; boot verified, no-op with no session). Verify against a
   real session + mismatch; will be de-branded with #1.
3. **Replication pull:** parallelize + backoff for no-peer drives; re-announce
   pulled drives via pkarr.
4. **Sync-path admission gate** (paid-service abuse): the reverted commit-time
   gate was the wrong layer; a reaper (accept, then reap un-enrolled drives after
   a grace) is the leading design. Not built.
5. **atomic-saas unpushed:** ~17 commits on `main` (incl. `from_cloud` portal
   redirect) + the managed-node ports, all committed locally, not pushed.

## Resolution: the node relays and serves, it never signs as a principal

**Decision (2026-07-10).** The core design rule, prompted by the same-agent
refusal (`peer.rs::is_same_agent_as_ours`) exposing that a managed node was
trying to be a peer principal it isn't:

> **Current (2026-07-17).** The same-agent refusal this section leans on was
> removed one week later (`683a25d4a`, "authorize relayed sync by owned drive,
> not peer identity"): `is_same_agent_as_ours` no longer exists, peer AUTH
> admits any agent, and what crosses is decided per subject by `check_read`
> and per drive by `may_accept_drive_write` (`lib/src/sync/engine.rs`). The
> "rights-based on both sides" generalization the Deferred section below asks
> for is therefore the shipped model, and the "same-agent" wording in the
> boundary table and tier mapping is superseded — read "same-agent `AUTH`" as
> "`AUTH` + per-subject rights". The rule itself (the node never signs as a
> principal to pull) still stands; see
> [`sync-onboarding-ux.md`](./sync-onboarding-ux.md) for the current wording.

> The client holds the key and signs. The node stores, forwards, and serves —
> it never authenticates to another peer *as itself* to obtain a user's private
> data.

Most of the stack already obeys this, which is why the fix is narrow:

- **Writes are already client-signed, node-forwarded.** A signed `COMMIT` is
  self-authorizing; the node applies it by verifying the signature + signer
  rights, never by signing. The WS commit monitor is exactly "client signs,
  server forwards": it stores a pushed commit and fans it to subscribers as
  `UPDATE` frames.
- **Serving is already per-request, no impersonation.** The node holds the
  drive in plaintext (received via push) and serves it by evaluating **the
  requester's** rights (`check_read` for the *caller's* agent), not its own. An
  unauthenticated GET gets "not found"; a request signed by the user gets the
  data. So the node holding plaintext is *not* the violation — indexing/search
  keep working — as long as the node never acts as a principal toward peers.

**The single violation: `managed-node`'s Iroh pull.** `pull_allowed_drives`
called `sync_drive_with_peer_outcome`, which signs `AUTH` as the node's *own*
server agent (`peer.rs:1238` `encode_auth(&get_default_agent(), drive)`) and
dials a peer to pull a drive. That is the node pretending to be a principal
entitled to read a private drive it isn't. The same-agent refusal correctly
rejects it — the answer is to remove the impersonating pull, not to loosen the
refusal.

### The boundary this draws

| Path | Transport | Auth | Who signs |
| --- | --- | --- | --- |
| A user's own devices | Iroh peer sync | same-agent `AUTH` | each device (the user) |
| A device ⇄ its managed node | authenticated WS/HTTP | per-request user signature | the client, per request |
| Node → other peers (pull) | — | — | **nobody — the node does not pull** |

Iroh peer sync is the **personal-device mesh** (same-agent). The node is **not
an Iroh peer**; it is reached over WS/HTTP and populated by client push +
WS relay. Node population therefore no longer depends on the node being able to
read a private drive it doesn't hold.

### Tier mapping (aligns with `atomic-saas/planning/TIER_SWITCHING_FLOWS.md`)

- **Local** — device mesh, same-agent Iroh. No node in the path.
- **Hosted** — node holds plaintext, serves per-request, indexes/searches. The
  node reads what it was *pushed*; it never impersonates to *pull*.
- **Cloud Vault (blind)** — node stores opaque encrypted commits and forwards
  them; it can't read, only relay. Greenfield; the purest form of the rule.

### Deferred: autonomous replication needs a client-signed capability, not a node signature

The one thing push+relay can't do: a fresh/empty node acquiring an
already-existing **private** drive with **no key-holder online**. That can't be
"forwarding" — someone holding the key must authorize the read. The principled
form is a **client-signed, scoped, revocable read grant** for the node's agent
(ordinary Atomic `read`-ACL: a signed commit adding the node's agent DID to the
drive's `read`), which the node *presents* rather than a signature it *mints*.
That in turn requires generalizing peer-sync admission from **same-agent** to
**rights-based** on *both* sides:

- **Accept (serving):** serve iff the authenticated peer has `read` on the drive
  (same-agent is the current special case).
- **Dial (pulling raw state):** trust a peer's raw `SYNC_PUSH` state iff that
  peer has **write** on the drive (an authoritative replica). A read-only node
  may relay *signed commits* (verifiable) but its raw state is not authoritative
  — this is the delicate part, and why the dial-side refusal stays same-agent
  for now.

This is the `authorization-sync.md` grant model — sequenced concretely for this
use case in its
[Node-as-granted-replica](./authorization-sync.md#node-as-granted-replica-making-autonomous-replication-work)
section (grant = signed `read` commit; rights-based admission; commit-backed
verify-don't-trust ingest; phase order P2→P5). **Not built**, and not needed for
the push+relay path. Until it exists, "enroll a drive and the node backfills it
by itself" does **not** work for private drives and must not be promised;
push-on-enroll (already the primary path) covers real onboarding.

### Change made now

`managed-node`'s impersonating Iroh pull is removed: the node no longer signs
`AUTH` as itself to pull drives. Population is push (WS `COMMIT`) + WS relay.
The `pull_allowed_drives` scaffold is retained behind the grant model above as
the future home of a *capability-presenting* (non-impersonating) pull.
