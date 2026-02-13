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
| [`unified-data-layer.md`](./unified-data-layer.md) | Browser/JS data-layer simplification: one ingress, one outbox, one subscription model. |
| [`s3-blob-storage.md`](./s3-blob-storage.md) | Pluggable blob backend design for redb/S3/hybrid storage. |

Protocol reference lives in the public docs: [`docs/src/websockets.md`](../docs/src/websockets.md).
Planning documents may discuss how that protocol is used internally, but should
not duplicate the wire reference.

## Agent Workflow

Before architectural work, read:

1. [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) for the long-term boundary.
2. Any domain-specific plan that matches the task.
3. Relevant code and tests; treat plans as direction, not proof that code already matches.

Keep `planning/` concise. Avoid session transcripts, stale estimates, and
postmortems that duplicate current plans.
