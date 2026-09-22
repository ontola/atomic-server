# API plugins

**Status:** Exploratory, on `feat/api-plugins` (branched from `feat/plugin-model`,
PR #1307). Rebuilds part of the direction from
[PR #1383](https://github.com/ontola/atomic-server/pull/1383) — OpenAPI-discovered,
live OAuth provider imports — on top of the plugin model instead of a separate
Reflector-backed importer.

## Where PR #1383 left off

PR #1383 discovered integrations under a `REFLECTOR_ROOT/spec` folder (declarative
OpenAPI + OAuth overlays), and ran live imports through `reflector-rs` /
`atomic_lib`'s importer, either from the CLI or from a running server with
signed browser-bound OAuth. That work is not being ported wholesale: this
branch is instead re-deriving the same end state — a user picks a provider,
signs in, and gets data — as an ordinary plugin installed from `integrations/`,
so it shares one review, secrets, and sandbox story with every other plugin
instead of a parallel one.

## First step: `pets`

[`integrations/pets`](../integrations/pets/) is the first commit here, and is
deliberately trivial: a static demo collection with a small code-first
ontology (species, breed, age, mood), no provider, no OAuth, no secret. It
exists only to walk every touch point a real API plugin needs, before adding
the parts that make a provider real:

- an ontology, ensured into the drive with `ensureSchema` (`schema.ts`)
- an import mapping into the shared sandbox (`plugin.ts` + `import-records.ts`)
- a committed, reproducible `plugin.js` bundle (`esbuild --bundle --format=esm`)
- registration as a bundled integration (`IntegrationDiscovery.tsx`)
- an installable connection resource + table + view (`ConnectPets.tsx`)
- a server-side sandbox test (`server/src/plugins/pets_tests.rs`)
- [x] a browser flow that installs, reviews, applies and displays all five pets
  (`browser/e2e/tests/plugins.spec.ts`)
- certification metadata (`package.json` `atomicCertification`)

## LocalThought and Syncables follow-up

Work continues on `codex/localthought-api-plugins`: dynamic catalog discovery,
signed account handoff, rotating host-owned credentials, Syncables pagination,
platform-specific typed ontologies, and a paginated Pets mock integration proxy.
See [the integration README](../integrations/localthought/README.md) for its
configuration, behavior and tests.

- [x] Replace public demo discovery with the live platform catalog.
- [x] Implement signed account connection and return flow using `TENANT_SECRET`.
- [x] Use Syncables with the catalog OAD for discovery, pagination and ontology.
- [x] Add the mock proxy and wire the updated Pets browser journey into CI.
- [x] Verify live GitHub OAuth, fetch and reviewed import (29 issue/PR records; proxy v38).
- [x] Verify Google Calendar OAuth/import against the live service (54 records, including 32 events; proxy v39).

Calendar live follow-up: proxy PR #30 fixes catalog base paths (deployed v39).
OAuth and paginated reads work, but an unbounded import exceeds 5,000 records.
- [x] Add explicit UTC event date bounds and verify a scoped live import.

- [x] Rebase onto `2ca03bd2c`, verified tree-identical to requested `550cc5f`.
- [ ] Make branch CI pass. Local JS suite, lint, typecheck, Rust handler tests
  and focused Pets E2E pass. Main run 34349742940 exposed independent Cargo
  cache locks around a shared registry; link the locks into the shared volume.

Main run 34350517612 passed dependency installation with the shared locks, then
failed the full-app compiler sweep at its 5-second default (7.8 seconds actual).
Give only that bulk test a 30-second budget; retain all compilation assertions.

Run 34352390180 was canceled before jobs started when another branch replaced
it in the default single pending slot. Set `queue: max` on main-pipeline so
pending validations can wait sequentially instead of displacing one another.

## Browser migration

`codex/browser-integrations` moves the LocalThought flow off AtomicServer.
Catalog parsing and pagination run in the Atomic WASM bundle; the browser owns
the tenant handoff and rotating connection code, then maps fetched records into
locally reviewed proposals. Companion branches in Syncables and integration-proxy
provide WASM compatibility and CORS. See `integrations/localthought/README.md`.
Legacy direct integrations, action infrastructure and scheduling remain separate.

## Reflector supersedes the browser/WASM path

[Issue #1599](https://github.com/ontola/atomic-server/issues/1599) (2026-09-21)
decides that `localthought/reflector` — a working TS service that already syncs
Google Calendar via `localthought/syncables` (the OpenAPI+overlay sync engine
above) and its own OAuth/PKCE handshake — supersedes the browser/WASM/
integration-proxy mechanism above for LocalThought platforms going forward, and
that the Rust `integrations/localthought/syncables` crate and
`wasm/src/integrations.rs` are retired once every platform has migrated.
Migration is per platform, not a flag-day cutover:

- [ ] Google Calendar first — reflector already supports it live.
- [ ] Todoist and Clockify keep using the browser/WASM/integration-proxy path
  above until each is ported.
- A plugin consumes a self-hosted reflector instance the same way it consumes
  any other third-party API: through the sandboxed `fetch` capability
  (`plugin-runtime/wit/plugin-runtime.wit`), with reflector's origin declared
  in the plugin manifest and its credentials handled via the existing
  `secret:<name>` substitution. This needs no new host capability.
- Reflector's own bidirectional reflection engine (id-map, origin markers,
  reflect loop — see its README's "Reflecting between two systems" section) is
  being generalized and extracted as a new `localthought/devonian` package,
  superseding the narrower, GitHub-issues-specific copy currently nested in
  `atomic-plugins/integrations/github-issues/devonian/`; reflector will depend
  on that package instead of keeping its own copy.
- Reflector's OAuth/PKCE handshake stays in reflector, exposed as a
  fetch-wrapper factory that feeds `syncables`' `ApiClientOptions.fetch`;
  `syncables` itself stays auth-agnostic.
- PR #1383 (`reflector-rs`, the Rust OpenAPI-import approach) remains
  closed/unmerged; nothing in it is being ported forward.

Once every LocalThought platform has migrated: delete `wasm/src/integrations.rs`,
the `integrations/localthought/syncables` Rust crate, and the `syncables` path
dependency in `wasm/Cargo.toml`.

## Handoff (2026-09-22): the deletion above already happened, ahead of plan

Session context: moving the standalone `localthought/syncables` (TypeScript)
repo into `atomic-plugins` as `syncables/` surfaced that
`integrations/localthought/syncables/` in *this* repo is a different thing —
a vendored Rust port ("syncables-rs") that `wasm/Cargo.toml` depends on by
path, backing `wasm/src/integrations.rs`'s `describeIntegration`/
`fetchIntegration` WASM exports. At explicit user direction, both sides were
removed now, ahead of the per-platform migration above (none of whose
checkboxes are checked):

- `ontola/atomic-plugins#35` — removes `integrations/localthought/syncables/`
  (the Rust crate) and the `Engine`/`describeIntegration`/`fetchIntegration`
  bridge from `integrations/localthought/browser.ts`. Merged/mergeable
  independently; `atomic-plugins` is unaffected by whatever this repo decides
  below.
- `ontola/atomic-server#1618` (this repo, `feat/plugin-debug`) — removes the
  `wasm/Cargo.toml` dependency, `wasm/src/integrations.rs`,
  `wasm/src/calendar_import.rs` (used only by it), and this repo's own copy
  of the vendored crate. **Not yet merged** — deliberately, see below.

### The open question neither PR answers

Two different target architectures could follow from here, and nobody has
decided between them:

1. **Reflector per-platform** (the plan already in this file): each
   LocalThought platform ports to consuming a self-hosted `reflector`
   instance via the sandboxed `fetch` capability. Calendar first, then
   Todoist/Clockify, then presumably Pets/Notion/GitHub-issues. Real
   per-platform engineering work, one platform at a time; `wasm/src/integrations.rs`
   would stay until the last platform ports.
2. **`atomic-plugins`-hosted, runtime-loaded WASM**: discussed in the same
   session (not written up anywhere before this). `atomic-plugins`'
   `integrations/` is already served live over plain HTTP at
   https://ontola.github.io/atomic-plugins/integrations/ (confirmed: GitHub
   Pages serves that repo's `main` branch directly, no build step). The
   stated intent for `feat/plugin-debug` is that it should hold only
   plugin-*loading* code, not plugin code itself — and the WASM sync engine
   arguably was plugin code that happened to be compiled directly into this
   repo's own frontend bundle via a Cargo path dependency, rather than
   fetched at runtime the way `catalog.json`/`plugin.js` already are for the
   sandboxed-plugin runtime.

**(2) does not exist today and is not a small gap.** Today the engine is a
Rust path dependency, statically linked into this repo's own `data-browser`
build via `wasm-bindgen`/`wasm-pack` (`build.rs`) — nothing loads it at
runtime. Making (2) real needs, at minimum:
- A Rust→WASM build pipeline in `atomic-plugins` (`wasm-pack`) compiling the
  `syncables` engine plus a thin browser bridge (what
  `wasm/src/integrations.rs` did) into a hosted `.wasm`/`.js` artifact.
  Nothing like this exists in `atomic-plugins` right now — it has no Rust
  build infrastructure at all as of #35.
- Hosting for that artifact (extending the existing GitHub Pages
  `catalog.json`/`plugin.js` hosting).
- New loader code in this repo's frontend: a runtime `import()`/fetch of
  that hosted artifact, replacing the static Cargo dependency entirely.
  `integrations/localthought/browser.ts` in `atomic-plugins` currently has
  *no* WASM-calling code at all post-#35 — under this architecture it would
  need to come back, but as a runtime loader, not a compile-time dependency.

### What merging #1618 as-is actually does

Pets, Notion, GitHub-issues, Calendar, Todoist and Clockify all currently
depend on `wasm/src/integrations.rs` live in the browser (see the
"LocalThought and Syncables follow-up" checklist above — all `[x]`).
Merging #1618 today removes that capability for all six at once, with
neither replacement (1) nor (2) built. #1618's description carries the same
warning; repeating it here since this is the living plan document for this
work.

### Remaining work

**In `atomic-server`:**
1. Decide (1) vs (2) above, or some third option — this is a real,
   undecided architecture call, not an implementation detail. Whoever owns
   Issue #1599 should make it and update this file's status accordingly.
2. If (1): hold #1618 (or revert it if already merged) until Calendar,
   then Todoist/Clockify, then the rest, have each ported to `reflector` per
   the checklist above.
3. If (2): build the runtime WASM loader in this repo's frontend once
   `atomic-plugins` can produce and host the artifact (see below);
   `wasm/src/integrations.rs`'s removal in #1618 then stands as-is.
4. Independent of the above: `wasm/tests/vault.rs` has pre-existing,
   unrelated compile failures under `cargo clippy --all-targets` (argument-count
   mismatches against `vault_export`/`vault_import` in `wasm/src/lib.rs`,
   reproduced on the unmodified base branch) — not introduced by #1618, but
   blocks a clean clippy run for anyone next touching this crate.

**In `atomic-plugins`:**
1. `syncables/`'s npm Trusted Publisher (npmjs.com) needs re-pointing at
   `ontola/atomic-plugins` and `syncables-publish.yml` — external, can't be
   done from either repo's code.
2. If (2) above is chosen: stand up the Rust→WASM build pipeline and
   artifact hosting described above, then reintroduce a WASM-calling bridge
   in `integrations/localthought/browser.ts` — as a runtime loader this
   time, not the removed compile-time dependency.
3. If (1) is chosen: no further `atomic-plugins` work follows from this
   specific thread; `integrations/localthought/browser.ts` stays as #35
   left it (OAuth/PKCE + generic proxy `request()` only).
