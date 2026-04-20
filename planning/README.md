# Planning

This folder is for internal design notes and larger technical direction. It is
not public-facing product/spec documentation; that belongs in `docs/`.

Use this folder to stay aligned on active architectural plans before making
broad changes. Prefer updating an existing plan over adding a new root-level
scratch document. When a plan becomes obsolete, either delete it or mark it as
superseded at the top.

## Current Plans

| Document | Scope |
| --- | --- |
| [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) | Target architecture: `atomic_lib` as the complete HTTP-optional local node runtime. |
| [`unified-sync.md`](./unified-sync.md) | **Active:** one sync API over WS or Iroh; mobile same as browser; retire manual `peer_sync`. |
| [`authorization-sync.md`](./authorization-sync.md) | **Draft:** signed commit authorization, creator proof, grant-chain evidence, delegated/replica/indexer/DM/inbox patterns, and peer-sync trust boundaries. |
| [`sync.md`](./sync.md) | WS `COMMIT` / echo suppression (mostly done); query-semantics follow-up. |
| [`unified-data-layer.md`](./unified-data-layer.md) | Browser/JS data-layer simplification: one ingress, one outbox, one subscription model. |
| [`loro-source-of-truth.md`](./loro-source-of-truth.md) | Make the Loro doc authoritative; `PropVals` becomes a derived projection. |
| [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md) | Proposal: commits remain signed write certificates, but commit retention is optional node policy. |
| [`s3-blob-storage.md`](./s3-blob-storage.md) | Pluggable blob backend design for redb/S3/hybrid storage. |
| [`virtual-drive.md`](./virtual-drive.md) | Expose Atomic as a mountable filesystem (NFS / FUSE / native cloud-sync APIs); shared VFS backend trait for desktop and mobile. |
| [`canvas-undo-consolidation.md`](./canvas-undo-consolidation.md) | Consolidating the canvas undo/redo stacks across Flutter and Loro. |
| [`SDK-API-design.md`](./SDK-API-design.md) | SDK / developer-experience direction for app builders and LLM agents. |
| [`rust-dependency-upgrade-audit.md`](./rust-dependency-upgrade-audit.md) | Audit notes for the Rust dependency upgrade pass. |

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
