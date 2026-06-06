# Planning

This folder is for internal design notes and larger technical direction. It is
not public-facing product/spec documentation; that belongs in `docs/`.

Use this folder to stay aligned on active architectural plans before making
broad changes. Prefer updating an existing plan over adding a new root-level
scratch document. When a plan becomes obsolete, delete it.

## Current Plans

| Document                                                                                         | Scope                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`atomic-lib-runtime.md`](./atomic-lib-runtime.md)                                               | Target architecture: `atomic_lib` as the complete HTTP-optional local node runtime.                                                                                                                                                               |
| [`unified-sync.md`](./unified-sync.md)                                                           | **Active:** one sync API over WS or Iroh; mobile same as browser; retire manual `peer_sync`.                                                                                                                                                      |
| [`reticulum-sync.md`](./reticulum-sync.md)                                                       | Proposal: carry the existing Atomic sync protocol over Reticulum as another transport beside WS and Iroh.                                                                                                                                         |
| [`authorization-sync.md`](./authorization-sync.md)                                               | **Draft:** signed commit authorization, creator proof, grant-chain evidence, delegated/replica/indexer/DM/inbox patterns, and peer-sync trust boundaries.                                                                                         |
| [`encryption.md`](./encryption.md)                                                               | **Exploration / undecided:** E2EE, verifier vs blind-replica roles, per-drive keys, encrypted checkpoints, backups, and local encryption at rest.                                                                                                 |
| [`sync.md`](./sync.md)                                                                           | WS `COMMIT` flow, echo suppression, and the unified `UPDATE` / `DESTROY` channel. Mostly shipped; tracks remaining test gaps.                                                                                                                     |
| [`unified-data-layer.md`](./unified-data-layer.md)                                               | Browser/JS data-layer simplification: one ingress, one outbox, one subscription model.                                                                                                                                                            |
| [`loro-source-of-truth.md`](./loro-source-of-truth.md)                                           | Make the Loro doc authoritative; `PropVals` becomes a derived projection.                                                                                                                                                                         |
| [`json-schema-code-first.md`](./json-schema-code-first.md)                                       | Proposal: JSON Schema compatible, code-first schema definitions that create local DID-backed Atomic Class and Property resources.                                                                                                                 |
| [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md)     | Proposal: commits remain signed write certificates, but commit retention is optional node policy.                                                                                                                                                 |
| [`genesis-self-verifying.md`](./genesis-self-verifying.md)                                       | Proposal: a resource carries its own genesis as an inline, binary, self-verifying certificate; verify authorship offline, no commit fetch.                                                                                                        |
| [`s3-blob-storage.md`](./s3-blob-storage.md)                                                     | Pluggable blob backend design for redb/S3/hybrid storage.                                                                                                                                                                                         |
| [`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md) | **Proposal:** why store size + boot time degrade with age (full-snapshot writes, no auto-compaction, O(file) open fsync) and how to fix it.                                                                                                       |
| [`virtual-drive.md`](./virtual-drive.md)                                                         | Expose Atomic as a mountable filesystem (NFS / FUSE / native cloud-sync APIs); shared VFS backend trait for desktop and mobile.                                                                                                                   |
| [`canvas-undo-consolidation.md`](./canvas-undo-consolidation.md)                                 | Consolidating the canvas undo/redo stacks across Flutter and Loro.                                                                                                                                                                                |
| [`SDK-API-design.md`](./SDK-API-design.md)                                                       | SDK / developer-experience direction for app builders and LLM agents.                                                                                                                                                                             |
| [`llm-wasm-gui-plugins.md`](./llm-wasm-gui-plugins.md)                                           | Proposal for browser-built JS/TS applications with scoped Loro documents, blob checkpoints, and optional future WASM modules.                                                                                                                     |
| [`rust-dependency-upgrade-audit.md`](./rust-dependency-upgrade-audit.md)                         | Audit notes for the Rust dependency upgrade pass.                                                                                                                                                                                                 |
| [`cleanup-update-encoding.md`](./cleanup-update-encoding.md)                                     | **Active:** Refactor UPDATE frame encoding/decoding, unify parser, and remove magic numbers.                                                                                                                                                      |
| [`commit-fanout-drive-isolation.md`](./commit-fanout-drive-isolation.md)                         | **Active:** Drive-scoped WS commit fan-out — closes the cross-tenant commit leak and the e2e 401-spillover flake; tracks the chatroom guest-drive client-hydration regression and its fix.                                                        |
| [`structural-problems-index.md`](./structural-problems-index.md)                                 | 2026-05-28 audit: ranked open structural issues with per-item plan files. Covers React Compiler / Resource proxy mismatch, subscription unification, save-state signals, Loro-as-authority, subject typing, and remaining actor-message Arc-wrap. |

Protocol reference lives in the public docs: [`docs/src/websockets.md`](../docs/src/websockets.md).
Planning documents may discuss how that protocol is used internally, but should
not duplicate the wire reference.

## Agent Workflow

Before architectural work, read:

1. [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) for the long-term boundary.
2. [`unified-sync.md`](./unified-sync.md) for sync/transport work (Flutter, WS, Iroh).
3. Any other domain-specific plan that matches the task.
4. Relevant code and tests; treat plans as direction, not proof that code already matches.

Keep `planning/` concise. Avoid session transcripts, stale estimates, and
postmortems that duplicate current plans.
