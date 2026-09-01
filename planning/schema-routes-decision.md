# Schema routes: one on-ramp for Classes and Properties

**Status:** Decision requested (2026-09-01).

> **Decision needed by maintainer**
>
> Question: Which of three competing schema on-ramps is *the* way a Class/Property comes into existence, and what happens to the other two?
> Options: (A) optional schema only — no schema resources required, `lib/defaults/*.json` stays the only shared vocab (#1316, #1245). (B) `did:ad:frozen` content-addressed schema for app/shared vocab, with (A) as the permissive write path and `lib/defaults/*.json` kept only as the serialization of the built-in set (#1262). (C) `lib/defaults/*.json` + `https://atomicdata.dev/...` URLs for every new vocabulary, as #1251 does today.
> Recommendation: **B** — it is the only option whose identity works offline and across hosts without trusting atomicdata.dev, and the write path already tolerates missing schema, so (A) is a policy statement, not a competing mechanism.
> Blocked PRs: #1316, #1245, #1262, #1209, #1251 (and #1309 sequencing).

## Context

What ships on `develop` today, verified against code.

**Subject form of built-in vocab.** Every core Class/Property is an `https://atomicdata.dev/...`
URL: `lib/src/urls.rs:4-15` (`CLASS`, `PROPERTY`, `COMMIT`, ...; 188 occurrences of
`atomicdata.dev` in that file). `lib/defaults/*.json` (`table.json`, `ontologies.json`,
`meeting.json`, `i18n.json`, ...) use the same form for `@id`, `isA` and `parent`. There is
no `did:ad:frozen` anywhere in `lib/src`, `server/src`, `browser/lib/src` or `docs/src`
(grep). `docs/src/did.md` documents `did:ad:agent` and `did:ad:blob` only.

**How defaults reach a store.** `lib/src/populate.rs`:

- `populate_base_models` (line 18) hard-codes the bootstrap Properties/Classes and is
  **add-only**: it skips any subject already present (lines 231-263, comment: "Only ever ADD ...
  on atomicdata.dev itself those resources are the site's own authored content").
- `populate_default_store` (line 268) runs `store.import(include_str!("../defaults/X.json"),
  &ParseOpts::default())`. `ParseOpts::default()` is `SaveOpts::Save`, `overwrite_outside: true`
  (`lib/src/parse.rs:73-84`); `SaveOpts::Save` calls `store.add_resource` (`parse.rs:773-780`),
  which is `add_resource_opts(resource, check_required_props: true, update_index: true,
  overwrite_existing: true)` (`lib/src/storelike.rs:260-273`). So JSON defaults are **upserted
  with required-prop validation**, not add-only.
- `bootstrap` (line 338) gates on two sentinels, `SHORTNAME` and `LORO_UPDATE`; if both are
  stored it returns early (lines 355-361). `Db::init` / `init_memory` / `init_redb` /
  `init_redb_opfs` all call `bootstrap` on open (`lib/src/db.rs:435,464,497,741`). The comment
  at `db.rs:432` ("Re-run on every startup so new vocabulary ... is available") is wrong: the
  sentinel gate skips it for every already-seeded store.

**`--repopulate-defaults` exists.** `server/src/config.rs:21-23` (`ATOMIC_REPOPULATE_DEFAULTS`);
`server/src/appstate.rs:156-178` runs `populate_base_models` + `populate_default_store` when
set and the store is not being initialized. It is manual, server-only, and does not touch
existing base-model definitions (add-only above). The gap as claimed in planning:
[`drafts-and-suggestions.md`](./drafts-and-suggestions.md) §Known gap ("a store that was already
populated never picks up a newly-added `lib/defaults/*.json`"; browser WASM needs a rebuilt
bundle *and* a store that repopulates), inherited verbatim by
[`content-i18n.md`](./content-i18n.md) (lines 88-91, 327). `--repopulate-defaults` is not
wired into the WASM/OPFS path at all (`db.rs:714` `init_redb_opfs` only calls `bootstrap`).

**How the write path validates.** The Loro commit path (`/commit`, WS, Iroh) builds
`CommitOpts { validate_schema: true, ... }` in `lib/src/sync/engine.rs:420-421`;
`validate_schema` only runs `check_required_props` (`lib/src/commit.rs:966-969`), which iterates
`get_classes` (`lib/src/resources.rs:313-335`). `get_classes` **skips** a class the store cannot
resolve (`resources.rs:566-600`, with the field incident that motivated it). No per-property
datatype lookup happens on the commit path; datatypes come from the Loro `datatypes` tag map
(`resources.rs:104-117`). `Resource::set` (Rust API path, `resources.rs:1340`) is the one place
that still hard-fails on an unknown Property. TS `Resource.set` already skips validation when
`getProperty` fails (`browser/lib/src/resource.ts:3389-3405`). Conclusion: schema is already
optional on every network write path; only the Rust in-process API and the data-browser form gate
(`browser/data-browser/src/components/forms/ResourceForm.tsx:167`, "Only resources with valid
classes can be created or edited") still force it.

**Codegen.** `@tomic/cli` `ad-generate ontologies` fails on `did:ad:` ontologies; #1309 makes
`https://host/did:ad:...` an alias of the DID (`browser/lib/src/parse.ts`,
`subjectsReferToSameResource`) and routes raw DIDs through `/did?subject=` using `serverUrl`.

## Options

| | (A) Optional schema | (B) `did:ad:frozen` + code-first | (C) `lib/defaults/*.json` |
| --- | --- | --- | --- |
| PRs | #1316, #1245 | #1262 (contains #1209) | #1251 (pattern shared by every existing default) |
| How a class is minted | Not minted; app writes URL-keyed props with no `isA` | `defineSchema()` in code → `freezeSchema` → JCS-canonical body → `blake3` → id (`browser/lib/src/schema.ts`, `lib/src/frozen.rs` `frozen_id`, shared `test-vectors/freeze-schema.json`) | Hand-edit JSON under `lib/defaults/`, add `urls.rs` consts, add an `import` call in `populate.rs` |
| Subject form | Any URL; none required | `did:ad:frozen:{blake3-hex}` (`lib/src/subject.rs` `DID_AD_FROZEN_PREFIX`); core vocab it points at stays `https://atomicdata.dev/...` | `https://atomicdata.dev/{classes,properties,ontology}/...` |
| Immutable / content-addressed | n/a | Yes: `Tree::Frozen` keyed by hash, verify-by-rehash on read (`lib/src/db.rs` `materialize_frozen`), commits to a frozen subject rejected (`lib/src/commit.rs`) | No; mutable https resources, upserted by `import` |
| Works offline / without atomicdata.dev | Yes | Yes: resolve order in-memory → `defineSchema` body registry → `GET /frozen/{hash}` (any host, rehash) | Only because the bytes are embedded via `include_str!`; any subject *not* embedded resolves by HTTP fetch of atomicdata.dev (`populate.rs:154,206,347-349`) |
| Write-path validation | `check_required_props` on resolvable classes; unknown class skipped; #1316 makes `Resource::set` match | Same, once the store can load the frozen Class/Property. **Gap found:** frozen bodies are identity-only (no `description`, `schema.ts` "Frozen bodies hold identity only"), but `Property::from_resource` / `Class::from_resource` still require `description` (`lib/src/schema.rs:34,109`, unchanged on the branch) → Rust `get_property`/`get_class` fail for frozen ids and `requires` is silently skipped (code reading; not run) | Full: datatype + `allowsOnly` on `Resource::set`, `requires` on commit |
| Updating defaults on an existing store | n/a | Never needed: a changed definition is a new hash; old data keeps pointing at the old id | Manual `--repopulate-defaults` (server) / no path at all (WASM); sentinel gate skips `bootstrap` |
| `@tomic/cli` codegen | n/a (no ontology to generate from) | #1262 rewrites `browser/cli/src/generate*.ts` to fetch through a `Store`; overlaps #1309 in `browser/cli/src/{config,store}.ts` (both PRs touch them) | Works today (https ontology) |
| Cost against shipped systems | None; matches `get_classes` and TS behaviour | New tree, two handlers (`server/src/handlers/frozen.rs` `PUT/GET /frozen/{hash}`), 9k-line diff, 237 commits behind `develop`, Phase D (Iroh `FROZEN_REQUEST`) and ClientDb/OPFS persistence not done | Zero new code; every new feature repeats the bootstrap gap |
| Verdict | Necessary policy, not an on-ramp | The on-ramp for app and shared vocab | Serialization format for the built-in set only |

(A) is not an alternative to (B): (A) says what happens when schema is *absent*; (B) says how
schema is *identified* when present. (C) cannot be the on-ramp for anything outside this repo:
it requires a commit to `lib/defaults/` and a release, and its identity is a hostname.

## Recommendation

Adopt **B**. The rule: **a Class or Property is identified by the hash of its definition;
hosts cache it, nobody owns it; a resource that names a class the store cannot load is still
a valid write.**

Sequencing:

1. **Close the repopulate gap generically (small, independent of #1262).** Replace the two
   sentinels in `populate::bootstrap` with a *defaults fingerprint*: at build time hash the
   concatenated embedded `lib/defaults/*.json` plus the `populate_base_models` list; store it
   under a reserved key; on every `Db` open (server *and* `init_redb_opfs`) compare and, on
   mismatch, run `populate_base_models` + `populate_default_store` then write the new
   fingerprint. Make the JSON import idempotent by construction: `add_resource_opts(&r,
   check_required_props: false, update_index: true, overwrite_existing: true)` — i.e. upsert by
   subject with `validate:false`, so an identity-only or partially-migrated definition cannot
   abort the whole batch (today `SaveOpts::Save` validates, `parse.rs:773-780`). Keep
   `--repopulate-defaults` as a forced re-run; fix the misleading comment at `db.rs:432`.
   Why frozen ids make the upsert safe: for `did:ad:frozen` subjects, same subject ⇒ same
   bytes, so overwrite is a no-op and a changed definition is a new subject; the only
   overwrite risk is the mutable `https://atomicdata.dev/...` set, which is exactly the set
   `populate_base_models` already refuses to overwrite (`populate.rs:231-234`). The
   fingerprint also removes the "rebuilt wasm bundle *and* a store that repopulates" dance in
   [`drafts-and-suggestions.md`](./drafts-and-suggestions.md): a new bundle carries a new
   fingerprint, so the OPFS store repopulates itself on next open.
2. **Merge the policy (#1316, #1245).** They make the Rust API and the data-browser match
   what the commit path already does.
3. **Land frozen (#1262) after a rebase**, with these changes: make `description` optional in
   `Property::from_resource` / `Class::from_resource` (`lib/src/schema.rs:34,109`), or have
   `materialize_frozen` merge the package `presentation` layer, and add a Rust test that
   `check_required_props` rejects a resource missing a `requires` of a frozen Class; resolve the
   `browser/cli/src/{config,store}.ts` overlap with #1309 by rebasing onto #1309; persist
   `Tree::Frozen` in the OPFS ClientDb (currently in-memory + network only). Phase D (Iroh
   `FROZEN_REQUEST`) can follow; `GET /frozen` over HTTP is enough for the first cut.
4. **Freeze the built-ins last.** Once 3 is in, emit `did:ad:frozen` ids for the app-level
   ontologies in `lib/defaults/` (table, meeting, dashboard, chatroom, forks, i18n, contacts)
   and keep the JSON files as the serialization the fingerprint in step 1 hashes. The core
   vocabulary in `urls.rs` (Class, Property, Commit, Agent, Drive, ...) stays https-addressed:
   frozen bodies themselves reference it (`schema.ts` uses `core.classes.property`), and
   `docs/src/schema/` and `atomicdata.dev` are its home. A separate decision is needed
   before touching those.

Not decided here: `did:ad:frozen` discovery beyond a known host (DHT / registry), and
migrations between schema versions (issue #1207 open question). Neither blocks steps 1-3.

## Consequences for open PRs

- **#1316** (Schema is recommended, not required on the write path): **merge-as-is**. One
  behaviour change (`Resource::set` falls back to `set_unsafe` on unknown Property,
  `lib/src/resources.rs`) plus docs and `planning/optional-schema.md`. Ask the author to note
  in `optional-schema.md` that this is the permissive half of this decision, not the on-ramp.
- **#1245** (Allow editing classless resources): **merge-as-is**. Removes the
  `ResourceForm.tsx:167` gate, adds `browser/e2e/tests/classless-edit.spec.ts`. UI dual of #1316.
- **#1262** (`did:ad:frozen` schemas + code-first API): **rebase-after #1309 and step 1**, then
  change: (i) `description` optional in `lib/src/schema.rs` `from_resource` or merged from
  the presentation layer, with a Rust `check_required_props`-against-frozen-Class test;
  (ii) resolve the `browser/cli/src/{config,store}.ts` overlap with #1309; (iii) OPFS persistence
  of `Tree::Frozen`; (iv) update `planning/json-schema-code-first.md` status from "Proposal.
  Nothing built" to point at `did-ad-frozen-server.md` (branch-only today) and land both docs.
  Split into lib+server / `@tomic/lib` / data-browser Freeze UI / CLI if review load requires;
  the 9k-line single PR is the main merge risk.
- **#1209** (Schema in code #1207 + did:ad:frozen #1208): **close as superseded**. Its head
  `2efcd9f92` is an ancestor of #1262's head (`git merge-base --is-ancestor`); every file it
  touches is in #1262's file list. Keep issues #1207 and #1208 open until #1262 merges.
- **#1251** (Contacts): **merge-as-is** on the current (C) convention — `lib/defaults/contacts.json`
  with `https://atomicdata.dev/...` subjects, `populate.rs` import, `urls.rs` consts — because
  every existing default ships that way and the freeze of built-ins is step 4, not a
  precondition. It inherits the bootstrap gap like `forks.json` and `i18n.json`; step 1 closes
  it for all of them at once. Do not add a second Contacts-specific repopulate path.
- **#1309** (Fix `@tomic/cli` ontology codegen for `did:ad` subjects): **merge before #1262**;
  it is the smaller change to the files both PRs edit, and its DID-alias rule in
  `browser/lib/src/parse.ts` is what frozen ontologies resolved via `https://host/did:ad:frozen:...`
  will also need.
