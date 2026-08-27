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

## Active

Remaining work, not "this file exists."

| Document | Status |
| --- | --- |
| [`unified-sync.md`](./unified-sync.md) | **Active.** One sync API over WS or Iroh. Remaining: AUTH-before-SYNC fail-closed, signed destroys on the wire, outbox port to `atomic_lib`, Layer 2 provenance. |
| [`serverless-p2p.md`](./serverless-p2p.md) | **Planned.** Same-agent device sync without a hub. P0 remaining: AUTH-before-SYNC, bind `AUTH.requestedSubject` to the drive, OQ5 bootstrap admission. |
| [`foss-public-host-mode.md`](./foss-public-host-mode.md) | **Proposal.** A FOSS node on a public address must not host strangers' workspaces. `HostMode { Open, Owner }`, owner claimed by agent DID. Closes unified-sync OQ5 for Owner. |
| [`authorization-sync.md`](./authorization-sync.md) | **Draft.** Signed commit authorization, grant-chain evidence, peer-sync trust boundaries. |
| [`encryption.md`](./encryption.md) | **Exploration.** E2EE / blind replicas undecided. Local cache at rest **shipped** — see [`opfs-per-agent-encryption.md`](./opfs-per-agent-encryption.md). |
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
| [`table-view-filters.md`](./table-view-filters.md) | **Default View shipped** (filters, sort, columns, operators). Remaining: multi-view switcher; index-accelerated range scans. |
| [`table-templates-and-mini-apps.md`](./table-templates-and-mini-apps.md) | Steps 3–6 shipped (computed columns, aggregates, assistant tools, catalogue). Remaining: derived columns in filters/aggregates. |
| [`dashboards.md`](./dashboards.md) | **First slice shipped.** Remaining: the sixth action verb, parameters, reaching a dashboard from its table. |
| [`content-i18n.md`](./content-i18n.md) | **LocalizedText + template locales shipped.** Remaining: TranslationsBar, `useTranslation`, `/query` `lang`, search language filter. |
| [`website-templates.md`](./website-templates.md) | Template repair complete (DID). Remaining CMS product: drafts-from-site, i18n tooling, canonical paths. |
| [`structural-problems-index.md`](./structural-problems-index.md) | Ranked structural issues. Highest remaining: React Compiler / Resource proxy (#1). |
| [`react-compiler-resource-proxy.md`](./react-compiler-resource-proxy.md) | **Planned.** Stale UI from Compiler memoizing Resource proxy reads. |
| [`canvas-undo-consolidation.md`](./canvas-undo-consolidation.md) | Phase A + C landed (browser). Phase B (Flutter action-stack removal) open. |
| [`index-performance.md`](./index-performance.md) | First tranche shipped. Structural permission-check fix is `zones.md`, not built. |
| [`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md) | **Proposal.** Full-snapshot writes, no auto-compaction, O(file) open fsync. |
| [`virtual-drive.md`](./virtual-drive.md) | Mountable filesystem (NFS / FUSE / native cloud-sync APIs). |
| [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md) | **Proposal.** Commits stay signed write certificates; retention is node policy. |
| [`p2p-presence.md`](./p2p-presence.md) | **Proposal.** Ephemeral presence over Iroh (`EPHEMERAL 0x40`). Same-agent only. |
| [`reticulum-sync.md`](./reticulum-sync.md) | **Proposal.** Atomic sync protocol over Reticulum. |
| [`json-schema-code-first.md`](./json-schema-code-first.md) | **Proposal.** Code-first JSON Schema → local DID-backed Class/Property resources. |
| [`SDK-API-design.md`](./SDK-API-design.md) | SDK / agent DX direction. |
| [`llm-wasm-gui-plugins.md`](./llm-wasm-gui-plugins.md) | **Proposal.** Browser-built JS/TS apps with scoped Loro docs. |
| [`personal-information-suite.md`](./personal-information-suite.md) | Exploration: contacts, calendar, email. |
| [`oidc-oauth.md`](./oidc-oauth.md) | **Proposal.** Optional OIDC/OAuth on the node (operator’s IdP, envelope index). Commits stay Ed25519. Retargets [#277](https://github.com/ontola/atomic-server/issues/277). |
| [`social-apps.md`](./social-apps.md) | Requirements for social-network-shaped apps. Companion to `zones.md`. |
| [`android-data-reuse.md`](./android-data-reuse.md) | **Draft.** One store/agent/Iroh node per Android device. Supersedes `on-device-atomic-daemon.md`. |
| [`nextgraph-interop.md`](./nextgraph-interop.md) | **Proposal.** `did:ng:` via a scheme-routed Store backend. |
| [`s3-blob-storage.md`](./s3-blob-storage.md) | Pluggable blob backend (redb/S3/hybrid). |
| [`importers.md`](./importers.md) | Analysis: sandboxed mapping functions; host owns acquire/parse/commit. |
| [`habits-app.md`](./habits-app.md) | **Proposal.** External-app dogfood; RPC `query` is the hard blocker. |
| [`atomic-assistant-browser-extension.md`](./atomic-assistant-browser-extension.md) | **Proposal.** Local-first Chromium extension. |
| [`tours.md`](./tours.md) | Design, not built. |
| [`rust-dependency-upgrade-audit.md`](./rust-dependency-upgrade-audit.md) | Audit notes for a Rust dependency upgrade pass. |
| [`e2e-light-heavy.md`](./e2e-light-heavy.md) | **Landing.** Playwright light on feature branches; full on `develop` / tags / opt-in. Steps 1–3 shipped. Remaining: grow vitest + `jsTestIntegration` before shrinking heavy. |

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
| [`on-device-atomic-daemon.md`](./on-device-atomic-daemon.md) | Draft. Android transport superseded by [`android-data-reuse.md`](./android-data-reuse.md); may still fit desktop. |
| [`main-drive-and-paths.md`](./main-drive-and-paths.md) | Strategy. DID-branch deployment: root drive, legacy URLs, human-readable paths. |
| [`actions.md`](./actions.md) | Unified action registry (menus, shortcuts, AI tools). |
| [`table-creation-ux-audit.md`](./table-creation-ux-audit.md) | Observation log (2026-07-03). First pass addressed. |
| [`kanban-views-test-spec.md`](./kanban-views-test-spec.md) | Manual test spec for kanban + `create_table`. |

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
| [`sync.md`](./sync.md) | WS `COMMIT`, echo suppression, unified `UPDATE`/`DESTROY`. Remaining: test gaps, Flutter WS session. |
| [`encrypted-vault-format.md`](./encrypted-vault-format.md) | Vault backup v1 in `lib/src/vault/` (2026-08-04). |
| [`opfs-per-agent-encryption.md`](./opfs-per-agent-encryption.md) | One encrypted OPFS database per agent. Session isolation on sign-out. |
| [`meetings.md`](./meetings.md) | Meeting resource, page, prepare-then-start flow. |
| [`node-did-canonicalization.md`](./node-did-canonicalization.md) | `did:ad:node:<hex>` is the only user-facing node ID form. |
| [`migrate-jsonarray-to-json.md`](./migrate-jsonarray-to-json.md) | Canvas `strokeData` datatype is `json`. |
| [`emoji-cover-images.md`](./emoji-cover-images.md) | Emoji + cover images on resources. |
| [`presence-views.md`](./presence-views.md) | Presence on canvas, tables, navbar, sidebar. |
| [`demo-experience.md`](./demo-experience.md) | v1 demo workspace. |
| [`cloud-sync-managed-node.md`](./cloud-sync-managed-node.md) | Bootstrap-grace admission gate for managed nodes. |

## Agent Workflow

Before architectural work, read:

1. [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) for the long-term boundary.
2. [`unified-sync.md`](./unified-sync.md) for sync/transport work (Flutter, WS, Iroh).
3. Any other domain-specific plan that matches the task.
4. Relevant code and tests; treat plans as direction, not proof that code already matches.

Keep `planning/` concise. Avoid session transcripts, stale estimates, and
postmortems that duplicate current plans.
