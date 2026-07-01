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
  unrestricted (`OpenPolicy`), `/node-info` reports `managed: false`, never
  phones home. FOSS UX never changes.

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
- ❌ **Not covered: Iroh live-sync `UPDATE`/`DESTROY`.** `peer.rs`'s
  `AtomicHandler::accept` has no peer allowlist, and once a connection reaches
  "live mode" (any `SYNC` that yields `SYNC_OK`/an empty diff is enough — no
  `AUTH` frame required), the read loop calls `ws_apply::apply_state_update` /
  `apply_destroy` directly with **no rights check and no policy check at all**
  (pre-existing since ~April 2026, predates this feature). This is a full
  bypass of both the ACL and the admission gate, reachable by any Iroh peer
  that completes a handshake — not just an admission-gate gap. Needs a design
  decision (peer allowlist vs. gate-check inside `ws_apply`) before a managed
  node's Iroh port can be considered safe from either angle. See
  `atomic-saas/planning/ENFORCEMENT_GATE.md`.
- The `AllowlistPolicy`, `set_sync_policy`, `allowed_drive_subjects`, and
  `has_resource_locally` plumbing is shared with the proactive pull.
- Note: enrollment itself requires a verified-email session (`require_user` →
  magic-link); there is no payment/plan gate yet (billing concern, separate).

## Status

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
