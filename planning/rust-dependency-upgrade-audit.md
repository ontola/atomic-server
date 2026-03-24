# Rust dependency upgrade audit

Scope: `atomic-server` (`server/`) and `atomic_lib` (`lib/`), including shared workspace lockfile impact.

## Checklist

- [x] Inventory direct dependencies and current locked versions.
- [x] Apply compatible lockfile refresh.
- [x] Upgrade low-risk `atomic_lib` direct dependencies and patch Loro 1.12 API fallout.
- [x] Upgrade `atomic-server` direct dependencies across Actix multipart, Tantivy, rustls, ACME, telemetry, ureq, Wasmtime, zip, static-files, and related utilities.
- [x] Patch compile fallout for Tantivy 0.26, actix-multipart 0.7, lol_html 2.9, rustls 0.23, instant-acme 0.8, rcgen removal from cert generation path, ureq 3, and Wasmtime 45.
- [x] Run focused Rust tests.
- [x] Plan the remaining Iroh/pkarr transport migration.

## Notes

- Leave unrelated worktree changes untouched.
- `cargo update` now reports no compatible updates remaining.
- Remaining direct dependency migrations in the requested crates:
  - `atomic_lib`: `iroh 0.35 -> 0.98`, `pkarr 3.10 -> 6`, and direct `rand 0.8 -> 0.10`.
  - These are coupled through `lib/src/sync/peer.rs`, `lib/src/discovery.rs`, sync tests, and key generation. Treat this as a dedicated transport migration, not a routine version bump.
- `cargo update --dry-run --verbose` still reports older versions from other workspace crates / transitive constraints, including CLI/example/desktop-side `base64 0.21`, `colored 2`, `dirs 4`, `toml 0.8/0.9`, and `zip 0.6`.
- Verification completed:
  - `cargo check -p atomic_lib --features "config db-redb rdf discovery iroh ring ws telemetry"`
  - `ATOMICSERVER_SKIP_JS_BUILD=true cargo check -p atomic-server --no-default-features`
  - `ATOMICSERVER_SKIP_JS_BUILD=true cargo check -p atomic-server`
  - `ATOMICSERVER_SKIP_JS_BUILD=true cargo test -p atomic_lib --features "config db-redb rdf discovery iroh ring ws telemetry" --lib`
  - `ATOMICSERVER_SKIP_JS_BUILD=true cargo test -p atomic-server --lib`
- Broader verification pass:
  - `ATOMICSERVER_SKIP_JS_BUILD=true cargo clippy -p atomic_lib -p atomic-server --all-targets --all-features -- -D warnings` passes after lint-only cleanup.
  - `cargo fmt --check` fails on unrelated pre-existing formatting in multiple Rust files.
  - `ATOMICSERVER_SKIP_JS_BUILD=true cargo test -p atomic-server --lib --tests` fails on `server/tests/multi_client_sync.rs`; isolated rerun also fails waiting for `QUERY_UPDATE`.
  - `pnpm lint` exits 0 with existing warnings.
  - `pnpm typecheck` fails in `@tomic/lib` (`resource.test.ts`, `store.ts`, `websockets.ts`).
  - `pnpm test` passes.
  - `pnpm build` exits 0, but `@tomic/lib` prints a declaration-generation `tsc` failure.
  - `pnpm test-e2e` passes: 50 passed, 7 skipped.
