# Agent workflow

Know-how for short-lived, per-feature agent sessions, collected from the
long-lived workers that used to carry it. `AGENTS.md` covers the codebase; this
covers how work gets in: branches, CI, builds that bite, and decisions that are
already made.

Each claim was checked against the code and CI config on 2026-09-30. Claims
marked **(unverified)** come from a worker's notes and could not be confirmed
from this repository; treat them as likely, and fix this file when you learn
more.

## Getting work into `develop`

- **Never merge into `develop` yourself.** Only the trekmeester merges (see
  `CONTRIBUTING.md`), in squash batches. It also rebases stale PRs itself, so
  don't rebase or merge `develop` into your PR just to keep it fresh (#1869).
- **PR branches get no CI by themselves.** `.github/workflows/main.yml` runs
  on pushes to `develop`, `v*` tags and `workflow_dispatch` only. To test a PR
  branch, dispatch it: `gh workflow run main.yml --ref <branch>` (or the
  equivalent GitHub API call). A docs-only change needs no dispatch.
- **Paired atomic-saas branch.** The `Downstream` job in `main.yml` builds
  ontola/atomic-saas against your commit. It uses an atomic-saas branch with
  the *same name* as yours only if that branch has an open PR; otherwise it
  builds atomic-saas `main`. It runs `cargo check --locked` and fails on a
  `Cargo.lock` diff. So a change that moves shared Rust dependencies (or
  breaks an API atomic-saas uses) needs a same-named atomic-saas branch with an
  open PR and an updated `Cargo.lock`. See "Coordinated Rust updates" in
  `CONTRIBUTING.md` and `scripts/check-rust-alignment.py`. The job only runs
  on the Mancave runner.

## Plugin pin candidates

ontola/atomic-plugins builds against `claude/atomic-plugins-pin` in this repo.
That branch is moved forward from numbered candidates,
`claude/atomic-plugins-pin-candidateN`, which carry plugin work that is not on
`develop` yet.

- Host branches (`claude/plugin-*-host`, based on a candidate) come in with a
  `git merge --no-ff`.
- `develop`-based PRs come in with `git cherry-pick -x` of **only the PR's own
  commits**. Never merge `develop` into a candidate: `develop` has many commits
  the candidates lack.
- Note hand edits in the commit message. Put merge-resolution notes in PR
  comments.
- Once the candidate's CI is green, post its SHA on atomic-plugins#227. The
  coordinator fast-forwards `claude/atomic-plugins-pin` (fast-forward only).
- On 2026-09-30 the pin pointed at `06c6e1b5f` (candidate17b). Candidate17 is
  red and must not be used. Candidates 18 and 19 exist; their status is on
  atomic-plugins#227, not here.

Candidate-line code that `develop` does not have yet (checked on candidate19):
the `plugin-routes` feature, `--trusted-proxies`, route `authOptional`,
`fetches`, `isEmbeddedVocabulary` additions for plugin vocabulary.

## Builds

**`develop`** (after #1830): the "Fresh Worktrees" steps in `AGENTS.md`.

**Candidate line** (branched before #1830):

- Build `@tomic/lib` first, then
  `SKIP_WASM_BUILD=1 pnpm -r --filter '!@tomic/lib' run build`.
- wasm-pack comes from `cargo-bin` (`cargo bin wasm-pack`, i.e.
  `cargo run --package cargo-bin -- wasm-pack`).
- Set `ATOMICSERVER_SKIP_JS_BUILD=true` for Rust runs that don't need the
  frontend.
- The build rewrites `browser/data-browser/src/chunks/Website/runtime/` there;
  revert that churn before committing. On `develop` those bundles are
  gitignored.

**Both lines:**

- `cargo build` in `server/` runs the JS build and rewrites `dist/`
  (`server/build.rs`). Don't typecheck the browser packages at the same time.
- A worktree's Rust `target/` is 6–30 GB **(unverified size)**. Delete it after
  pushing.

## Checks before pushing

- The pre-commit hook (`scripts/pre-commit.mjs`) runs lint and Clippy, **not
  rustfmt**. Run `cargo fmt --all -- --check` yourself.
- Never `--no-verify`.
- If you build with `--features plugin-routes` (candidate line), run Clippy
  with that feature too; the hook's Clippy uses `light`.
- vitest on Node 26 on the candidate line needs
  `NODE_OPTIONS=--no-experimental-webstorage` **(unverified)**.
- The Dagger containers that build the plugin runtime need the `wasm32-wasip2`
  target and `ATOMICSERVER_REQUIRE_PLUGIN_RUNTIME=true`; without them the
  build silently ships an empty runtime (`.dagger/src/index.ts`, e2e build and
  `rustTest`). On the candidate line `rustBuildSlim` needs these too, plus
  `libclang-dev` and `clang` for bindgen in `rquickjs-sys`.
- Local e2e: `cd browser && pnpm test-e2e:local --workers=2 <specs>`. Add
  `--skip-build` only after test-only edits; it reuses the built artifacts.

### Reported flaky tests (unverified)

`TESTING_COVERAGE.md` lists no known flaky tests. The workers reported these;
check the linked issue before calling a failure a flake, and never skip a test:

- `db::compaction::tests::startup_compaction_shrinks_a_bloated_store_and_keeps_every_resource`
  (`lib/src/db/compaction.rs`), on macOS (#1886).
- `reconcile_skips_empty_hosts_and_drives` (`lib/src/db.rs`), occasionally.
- The money "New app" e2e, before #1920.

## UI text and vocabulary

- Missing UI strings render **empty** in a production build. After adding UI
  text, run `pnpm clean-translations` (`wuchale --clean`) in
  `browser/data-browser` and commit the `.po` changes. See the translation
  section in `AGENTS.md`. Machine translation needs `OPENROUTER_API_KEY`
  **(unverified; not referenced in `wuchale.config.js`)**.
- Identifiers are `atomic:…`. Test with `isAtomicIdentifier()`
  (`browser/lib/src/subject.ts`) or `identifiers::is_atomic_identifier`
  (`lib/src/identifiers.rs`), never `startsWith('did:')`.
- Vocabulary not published on atomicdata.dev (forms, notifications, plugins)
  must be in `isEmbeddedVocabulary` (`browser/lib/src/store.ts`).

## Decisions already made

Don't reopen these without asking Michiel.

- Never reinterpret an existing property. Add a new one and deprecate the old
  (#1803).
- All applicable views stay reachable (#1806).
- Plugin routes (candidate line):
  - `authOptional` is explicit for every auth kind.
  - `ctx.blobs.fetch` needs a `fetches` declaration
    (`docs/src/plugins/creating-plugins.md`).
  - Forwarded headers count for plugin routes only from `--trusted-proxies`
    (#1903).
  - Sidecar requests are v2-signed with the installation's app agent
    **(unverified)**.

## Rules

- Product questions go to Michiel through the coordinator: post
  "Question for Michiel: …" on atomic-plugins#227.
- Stage paths explicitly. Never commit `.lane-store/`, data or config dirs,
  `node.key`, `*.redb`, `.env` or credentials.
- Invented data only, in fixtures and screenshots.
- Push work in progress to your `claude/*` branch at least hourly; containers
  are reclaimed.
