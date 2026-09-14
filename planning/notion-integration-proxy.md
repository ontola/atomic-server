# Notion integration-proxy migration

- [x] Trace current Notion OAuth, discovery, installer and sync paths.
- [x] Inspect the shared browser proxy authorization and rotating-code transport.
- [x] Preserve two-way sync; browser execution is manual while the tab is open.
- [x] Implement Notion proxy connection and provider operations with regression coverage.
- [x] Remove obsolete Notion-specific AtomicServer OAuth/discovery routes.
- [x] Verify focused tests, frontend typecheck and translation changes; document limits.
- [x] Gate the embedded plugin runtime build on the default-enabled `wasm-plugins` feature so runtime-off Cargo builds do not invoke nested WASM compilation.

The existing Notion plugin uses synchronous sandbox reads and server-journaled
effects. Merely replacing its setup UI with ConnectLocalThought would lose
two-way sync, view/property mapping and background execution. Proxy connection
codes are browser-owned and must not be written to synced resources or treated
as static server secrets. Existing working-tree edits belong to other work.

## Publication and live verification still pending

The deployed proxy catalog currently does not include Notion. Companion generic
proxy changes and Notion OpenAPI/OAuth metadata are staged under
`planning/notion-proxy/`. They need publication with immutable OAD/overlay pins,
proxy deployment and a configured Notion OAuth app before real consent works.
The generic proxy implementation is merged in integration-proxy PR #67. No OAuth settings or live provider data have been changed.

Verified locally: both full default and `--no-default-features --features light`
AtomicServer binaries pass `cargo check`; Notion Vitest tests and a browser
journey cover local import, both edit directions and checkpoints without a
running AtomicServer. A title normalization bug exposed by that journey is
fixed: display name and mapped title agree before checkpointing.

Bundles remain in this repository as requested. Future bundle hosting option: source in a separately owned integrations repo
(or the existing `localthought/devonian` package), built bundles on immutable
GitHub releases, catalog entries pinning version/URL/SHA-256, verification before
execution, locally cached installed versions and explicit upgrades. npm with
trusted publishing/provenance is an alternative for build-time package consumers.
Moving the bundles and switching the loader are separate from this local proxy
migration; no remote executable loading was introduced here.

## Publication work

- Worktree: `/private/tmp/atomic-plugin-model-improvements`
- Branch: `feat/plugin-model-improvements`
- Base: `feat/plugin-model` at `4f5f2804d` (unmerged dependency; PR targets it).
- [x] Isolate task-owned changes, excluding concurrent Devonian discovery and table loading edits.
- [x] Publish Atomic PR #1482 against feat/plugin-model.
- [ ] Inspect exact-commit CI.
- [ ] Merge companion proxy PR and verify Heroku deployment.
