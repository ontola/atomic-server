# Planning

This folder is for internal design notes and larger technical direction. It is
not public-facing product/spec documentation; that belongs in `docs/`.

Use this folder to stay aligned on active architectural plans before making
broad changes. Prefer updating an existing plan over adding a new root-level
scratch document. When a plan becomes obsolete, delete it. Fully-shipped
checklists that are still useful as as-built notes stay here, listed under
**Landed**.

The status in this index should match the document's own status line. The
document wins if they disagree.

Protocol reference lives in the public docs:
[`docs/src/websockets.md`](../docs/src/websockets.md). Planning documents may
discuss how that protocol is used internally, but should not duplicate the
wire reference.

## Decisions

Decision documents: one question each, written as an RFC with a recommendation.
Each starts with a decision box and ends with the consequences for open PRs.
All five below were **accepted on 2026-09-01**; the status line at the top of
each document records the outcome. Fold each outcome into the owning plan, then
move the document to `completed/`.

| Document | Question | Outcome (accepted 2026-09-01) | Affects |
| --- | --- | --- | --- |
| [`runtime-boundary-decision.md`](./runtime-boundary-decision.md) | Rust-only runtime vs twinned-by-design between `atomic_lib` and `@tomic/lib`. | `AtomicNode` in `lib/src/runtime/` is the binding runtime; #1277/#1241 bind it, no parallel `simple.rs`/`ffi/`. First slice on `feat/atomic-node-slice`. | #1273, #1274, #1277, #1241, #1278 |
| [`authority-unit-decision.md`](./authority-unit-decision.md) | Drive vs zone as the unit of authority; additive creator chain vs replace-and-replay. | Drive stays the authority unit; #1254 restores the drive fast path, drops `collect_zone_subjects`, keeps the zone chain hybrid/additive. | #1254, #1307, #1310 |
| [`commit-retention-floor-decision.md`](./commit-retention-floor-decision.md) | What must be retained for authorization and audit before commits become envelopes. | Envelope-on-resource. #1313 on hold until `Tree::Envelopes` exists; sequence #1274 → #1313 → #1254. | #1313, #1274, #1254 |
| [`trust-model-decision.md`](./trust-model-decision.md) | Blind vs trusted server. | The node that owns the URL is trusted with plaintext; anything that only stores is blind. `encryption.md` closed to at-rest + vault. Sync F1 closed by the signed state root, not provenance-per-push. | #1310, #1307, #1254 |
| [`schema-routes-decision.md`](./schema-routes-decision.md) | Optional schema vs `did:ad:frozen` vs `lib/defaults/*.json`; the `--repopulate-defaults` gap. | Accepted as policy (#1316): `did:ad:frozen` is the on-ramp, optional schema is the write-path policy. #1251 to become a frozen ontology; bootstrap sentinel-gate fix on `fix/defaults-bootstrap-gate`. | #1316, #1245, #1262, #1209, #1251, #1309 |

## Active

Remaining work, not "this file exists."

| Document | Status |
| --- | --- |
| [`unified-sync.md`](./unified-sync.md) | **Active.** One sync API over WS or Iroh. Remaining: AUTH-before-SYNC fail-closed, signed destroys on the wire, outbox port to `atomic_lib`, Layer 2 provenance. |
| [`serverless-p2p.md`](./serverless-p2p.md) | **Planned.** Device sync without a hub (written same-agent-first; admission is rights-based since 2026-07-17). P0 remaining: AUTH-before-SYNC, bind `AUTH.requestedSubject` to the drive, OQ5 bootstrap admission. |
| [`foss-public-host-mode.md`](./foss-public-host-mode.md) | **Proposal.** A FOSS node on a public address must not host strangers' workspaces. `HostMode { Open, Owner }`, owner claimed by agent DID. Closes unified-sync OQ5 for Owner. |
| [`authorization-sync.md`](./authorization-sync.md) | **Draft.** Signed commit authorization, grant-chain evidence, peer-sync trust boundaries. |
| [`encryption.md`](./encryption.md) | **Exploration.** Live E2EE / blind replicas undecided. Shipped since the draft: local cache at rest ([`opfs-per-agent-encryption.md`](./opfs-per-agent-encryption.md)) and the encrypted archive ([`encrypted-vault-format.md`](./encrypted-vault-format.md), candidate model 2). |
| [`unified-data-layer.md`](./unified-data-layer.md) | Browser/JS: one ingress, one outbox, one subscription model. Sign-at-drain (S4a) shipped separately. |
| [`loro-source-of-truth.md`](./loro-source-of-truth.md) | **Partial.** Sparse `datatypes` map + Phase 2a–2c shipped (`Tree::Resources` is a derived cache). Remaining: drop the untagged heuristic, Phase 1.6 `Value` reshape, Flutter undo. |
| [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) | Target: `atomic_lib` as the complete HTTP-optional local node runtime. |
| [`genesis-self-verifying.md`](./genesis-self-verifying.md) | **Partial.** Server and browser mint and verify inline genesis certs. Remaining: DataRoute verify UI, `genesis` propval immutability. |
| [`drive-reconciliation.md`](./drive-reconciliation.md) | **Partial.** Algorithm core in `lib/src/sync/rbsr.rs`. Not on the WS/Iroh wire yet; fingerprint tree still O(range). |
| [`zones.md`](./zones.md) | **Proposal.** Nothing built. Structural fix for the permission-check half of [`index-performance.md`](./index-performance.md). |
| [`partial-sync.md`](./partial-sync.md) | **Proposal.** Replicate part of a drive per device. |
| [`drafts-and-suggestions.md`](./drafts-and-suggestions.md) | **Mechanism shipped** (`Fork` class, `diffFork`/`mergeFork`, document body CRDT merge). Review/diff UI, suggest-for-non-writers, Canvas fork still open. |
| [`device-pairing.md`](./device-pairing.md) | **Proposal.** One-scan pairing; QR is routing only (no secret). C0 and M6 closed. Remaining: extra-workspace inventory, M4. |
| [`pairing-ux-field-test.md`](./pairing-ux-field-test.md) | **Field notes (through 2026-08-20).** C0 and M6 closed. Open: M4 (pre-0.40 auth), M8 (desktop "saved locally" toast), M12 (presence over Iroh), extra-workspace inventory. |
| [`json-ad-compact.md`](./json-ad-compact.md) | **Phase 1–2 shipped** (resolver, tool I/O, context providers). Remaining: rebase `create_table.rows` on `fromCompact`; server `format=compact`. |
| [`table-view-filters.md`](./table-view-filters.md) | **Views shipped** — Default View (filters, sort, columns, operators) and the multi-view switcher (`TableViewTabs`, `?view=`). Remaining: index-accelerated range scans. |
| [`table-templates-and-mini-apps.md`](./table-templates-and-mini-apps.md) | Steps 3–6 shipped (computed columns, aggregates, assistant tools, catalogue). Remaining: derived columns in filters/aggregates. |
| [`dashboards.md`](./dashboards.md) | **First slice shipped.** Remaining: the sixth action verb, parameters, reaching a dashboard from its table. |
| [`content-i18n.md`](./content-i18n.md) | **LocalizedText + template locales shipped.** Remaining: TranslationsBar, `useTranslation`, `/query` `lang`, search language filter. |
| [`website-templates.md`](./website-templates.md) | Template repair complete (DID). Remaining CMS product: drafts-from-site, i18n tooling, canonical paths. |
| [`structural-problems-index.md`](./structural-problems-index.md) | Ranked structural issues. Highest remaining: React Compiler / Resource proxy (#1) — still open as of 2026-08, compiler now enabled. |
| [`react-compiler-resource-proxy.md`](./react-compiler-resource-proxy.md) | **Planned, audit not started.** Stale UI from Compiler memoizing Resource proxy reads; compiler on since 2026-08-19, field instance M15a. |
| [`canvas-undo-consolidation.md`](./canvas-undo-consolidation.md) | Phase A + C landed (browser). Phase B (Flutter action-stack removal) open. |
| [`index-performance.md`](./index-performance.md) | First tranche shipped. Structural permission-check fix is `zones.md`, not built. |
| [`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md) | **Proposal.** Full-snapshot writes, no auto-compaction, O(file) open fsync. |
| [`virtual-drive.md`](./virtual-drive.md) | **Shipped** as a local NFS mount in the Tauri desktop app (`desktop/src/vfs.rs`). Still proposal: headless-server mount, FUSE/WinFSP, native cloud-sync APIs, mobile providers. |
| [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md) | **Proposal** (DID wording predates the genesis-cert model, see its *Current* note). Commits stay signed write certificates; retention is node policy. |
| [`p2p-presence.md`](./p2p-presence.md) | **Proposal.** Ephemeral presence over Iroh (`EPHEMERAL 0x40`). Scoped to your own devices by product choice (the transport is no longer same-agent-gated). |
| [`reticulum-sync.md`](./reticulum-sync.md) | **Proposal.** Atomic sync protocol over Reticulum. |
| [`json-schema-code-first.md`](./json-schema-code-first.md) | **Proposal**; `defineSchema` + frozen `did:ad:` schemas in flight in PR #1262 (not on `develop`). Code-first JSON Schema → local DID-backed Class/Property resources. |
| [`SDK-API-design.md`](./SDK-API-design.md) | SDK / agent DX direction. |
| [`plugins.md`](./plugins.md) | **Partial** — one plugin model (`run` end to end, per-app agents, unattended runs). The code lives on `feat/plugin-model` (PR #1307), not `develop`. Absorbed `llm-wasm-gui-plugins.md`, `importers.md`, `habits-app.md` (2026-09-01); the habits RPC-`query` blocker is a line in it. |
| [`personal-information-suite.md`](./personal-information-suite.md) | Exploration: contacts, calendar, email. |
| [`social-apps.md`](./social-apps.md) | Requirements for social-network-shaped apps. Companion to `zones.md`. |
| [`android-data-reuse.md`](./android-data-reuse.md) | **Draft.** One store/agent/Iroh node per Android device. Supersedes `on-device-atomic-daemon.md` (deleted 2026-09-01; desktop remainder is a note in `virtual-drive.md`). |
| [`nextgraph-interop.md`](./nextgraph-interop.md) | **Proposal.** `did:ng:` via a scheme-routed Store backend. |
| [`s3-blob-storage.md`](./s3-blob-storage.md) | Pluggable blob backend (redb/S3/hybrid). |
| [`atomic-assistant-browser-extension.md`](./atomic-assistant-browser-extension.md) | **Proposal.** Local-first Chromium extension. |
| [`tours.md`](./tours.md) | Design, not built. |
| [`e2e-light-heavy.md`](./e2e-light-heavy.md) | **Landing.** Playwright light on feature branches; full on `develop` / tags / opt-in. Steps 1–3 shipped. Remaining: grow vitest + `jsTestIntegration` before shrinking heavy. |
| [`atomic-forms.md`](./atomic-forms.md) | **Planned.** Forms/Survey feature — schema, builder UI, agent-less submission endpoint, `/form/:id` runtime, results in Tables. Research: [`atomic-forms-research.md`](./atomic-forms-research.md). |
| [`outbox-drain-data-loss-race.md`](./outbox-drain-data-loss-race.md) | **Confirmed bug, not yet root-caused.** A resource save can report success while the outbox drain silently drops the write — reproduced independent of React/Forms. `forms.spec.ts`'s reload-persistence assertions are deliberately kept strict as regression signal. |

## Slices and companions

Not top-level plans. Indexed so they do not go missing.

| Document | Status |
| --- | --- |
| [`unify-subscription-primitives.md`](./unify-subscription-primitives.md) | Planned. Server-side: one `Subscription` shape. Slice of [`unified-data-layer.md`](./unified-data-layer.md). |
| [`unify-subscription-actors.md`](./unify-subscription-actors.md) | Planned. Fold LoroSyncBroadcaster into CommitMonitor. |
| [`unify-resource-representations.md`](./unify-resource-representations.md) | Planned. Browser dual of [`loro-source-of-truth.md`](./loro-source-of-truth.md) (`Resource._cache`). |
| [`unify-resource-dirty-signals.md`](./unify-resource-dirty-signals.md) | Planned. Single `getSaveState(subject)` enum. |
| [`subject-types-end-to-end.md`](./subject-types-end-to-end.md) | Partial. Brand type in `@tomic/lib`; Rust `DidKind` shipped. Consumer migration open. |
| [`arc-actor-message-payloads.md`](./arc-actor-message-payloads.md) | Partial. WS encode-once shipped; `CommitMessage` Arc-wrap deferred. |
| [`sync-onboarding-ux.md`](./sync-onboarding-ux.md) | Cross-client copy for what can reach what. Companion to [`device-pairing.md`](./device-pairing.md). |
| [`main-drive-and-paths.md`](./main-drive-and-paths.md) | Strategy. DID-branch deployment: root drive, legacy URLs, human-readable paths. |
| [`actions.md`](./actions.md) | **Step 1 shipped** (registry + ⌘M menu, 2026-07-08). Remaining: ⌘K section, hotkeys/shortcuts page derived from the registry, AI-tool derivation. |
| [`table-creation-ux-audit.md`](./table-creation-ux-audit.md) | Observation log (2026-07-03). First pass addressed. |
| [`kanban-views-test-spec.md`](./kanban-views-test-spec.md) | Manual test spec for kanban + `create_table`. |
| [`silent-failures.md`](./silent-failures.md) | Running list of error-handling failures that reported success (2026-08-21). Companion to [`pairing-ux-field-test.md`](./pairing-ux-field-test.md). |

Fixed notes live in [`completed/`](./completed/).

## Landed

As-built notes. Remaining follow-ups, if any, live in the Active table or in
the document itself.

| Document | What shipped |
| --- | --- |
| [`deterministic-personal-drive.md`](./deterministic-personal-drive.md) | Personal-drive DID derived from the Agent key. Repeat genesis merges. Pointer is not identity. `Db::create_drive` lists on the personal drive. |
| [`multi-property-filter.md`](./multi-property-filter.md) | AND filters, full-stack (Rust → server → lib → WASM → React → e2e). UI lives in `table-view-filters.md`. |
| [`commit-fanout-drive-isolation.md`](./commit-fanout-drive-isolation.md) | Drive-scoped WS commit fan-out + server-side drive safety net. |
| [`cleanup-update-encoding.md`](./cleanup-update-encoding.md) | Unified `decode_update`; TS client exports compact Loro deltas. |
| [`sign-at-drain.md`](./sign-at-drain.md) | One signed commit per dirty subject per drain pass. |
| [`sync.md`](./sync.md) | WS `COMMIT`, echo suppression, unified `UPDATE`/`DESTROY`; Flutter WS session shipped. Remaining: test gaps. |
| [`encrypted-vault-format.md`](./encrypted-vault-format.md) | Vault backup v1 in `lib/src/vault/` (2026-08-04). |
| [`opfs-per-agent-encryption.md`](./opfs-per-agent-encryption.md) | One encrypted OPFS database per agent. Session isolation on sign-out. |
| [`meetings.md`](./meetings.md) | Meeting resource, page, prepare-then-start flow. |
| [`node-did-canonicalization.md`](./node-did-canonicalization.md) | `did:ad:node:<hex>` is the only user-facing node ID form. |
| [`migrate-jsonarray-to-json.md`](./migrate-jsonarray-to-json.md) | Canvas `strokeData` datatype is `json`. |
| [`emoji-cover-images.md`](./emoji-cover-images.md) | Emoji + cover images on resources. |
| [`presence-views.md`](./presence-views.md) | Presence on canvas, tables, navbar, sidebar. |
| [`demo-experience.md`](./demo-experience.md) | v1 demo workspace. |
| [`cloud-sync-managed-node.md`](./cloud-sync-managed-node.md) | Bootstrap-grace admission gate for managed nodes. Verified against the SaaS `LocalProcessNodeProvider` only; provisioned nodes still run the unmanaged binary (fix in flight). |

## Agent Workflow

Before architectural work, read:

1. [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) for the long-term boundary.
2. [`unified-sync.md`](./unified-sync.md) for sync/transport work (Flutter, WS, Iroh).
3. Any other domain-specific plan that matches the task.
4. Relevant code and tests; treat plans as direction, not proof that code already matches.

Keep `planning/` concise. Avoid session transcripts, stale estimates, and
postmortems that duplicate current plans.
