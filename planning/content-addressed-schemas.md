# Content-addressed schemas: build plan

**Status:** Approved by Joep on 2026-10-28. P0 to P2 in progress (docs, vector
fixture, Rust identity); P3 onward not started. Written against `origin/develop`
of atomic-server (49d21e08) and the atomic-plugins and atomic-education
checkouts. "(unverified)" marks things not run or not read to the line.

## Decisions (Joep, 2026-10-28)

1. "Frozen" means content-addressed `atomic:prop:` and `atomic:class:`.
   `did:ad:frozen` and `atomic:frozen:` stay dead.
2. Class identity hashes the ontology, shortname and the sorted `requires` only.
   It does **not** hash `recommends`, so adding a recommended field does not
   create a new class. Adding or removing a required property does.
3. Aliases for old https terms will be a core `replaces` property, not kit-only
   aliases. That is P4+ territory (section 8); the spec keeps room for it. The
   property is not part of any identity hash.

Sections below were adapted to these decisions; the original open questions
(section 13) are answered in place.

## 0. Short version

Joep asked: why not `atomic:` subjects instead of temporary URLs, and frozen schemas?
We can, and half of it already exists, so the plan is smaller than "revive `did:ad:frozen`".

1. `develop` already has content-addressed Properties: `atomic:prop:{blake3}` over
   (ontology, shortname, datatype), merged in #2151, and `atomic:lens:{hex}`. Both are
   normal Loro-backed resources whose subject is re-derived from their fields on every
   commit (`lib/src/commit.rs` `is_content_addressed_id`, `verify_content_addressed_genesis`).
2. `did:ad:frozen` (#1262) and `atomic:frozen:` (#2045) are closed, with zero hits in
   `lib/src`, `server/src`, `browser/lib/src`. #2151 says it "replaces the parallel
   frozen-schema API from #2045". The 20 Oct analysis
   (`/mnt/project-files/schema-plugins-mcp/analyse.md`) advised declaring frozen dead.
   `planning/json-schema-code-first.md` and `schema-catalog.md` still say the opposite.
3. What the shared ontologies in atomic-plugins still lack: (a) a namespace that is not a
   hostname, (b) a content-addressed Class subject, (c) a way to ship and pin a whole
   release without GitHub Pages.
4. Recommendation: no second storage/validation path (`Tree::Frozen`, `PUT /frozen`,
   cycle "unit" objects). Add `atomic:class:{hex}` beside `atomic:prop:`, keep value rules
   (including `classtype`) in class constraints outside the hash, which removes every
   cycle, pin a release with the #2239 fingerprint, and ship the release as a JSON-AD
   bundle inside the plugin version instead of on Pages.

## 1. What exists today

| Thing | State |
| --- | --- |
| Scheme | `atomic:` canonical, `did:ad:` accepted forever (`lib/src/identifiers.rs`). `Subject` is Internal / External / Did; `pure_id()` canonicalizes the scheme. Kinds: `agent`, `commit`, `blob`, `prop`, `lens`, `node`, bare resource. |
| Property identity | `docs/src/schema/property-identity.md`, `lib/src/property_identity.rs`, TS twin `browser/lib/src/property-identity.ts`. JCS of `{datatype, ontology, shortname}`, BLAKE3 `derive_key("atomic property identity v1")`. An https ontology string is hashed as is. Labels, `classtype`, `allowsOnly` are not hashed. |
| Class constraints | Value rules (enum, bounds, linked `class`) live on the Class (#2151, #2220). |
| Fingerprint | #2239 (draft): `b3-<hex>` over JCS of ontology, property ids, each class's requires, recommends, classtypes, constraints. No names or descriptions. |
| Frozen graph spec | `docs/src/core/validations.md`: all-hash graph; cycles cannot be frozen. |
| Resolution | Rust `Db::get_resource` (`lib/src/db.rs` ~5285-5520): stored first; a miss on an External subject does one HTTP fetch and keeps it; a miss on a DID is "not found locally" (drive-hint sync, `/did?subject=`). TS `Store.fetchResourceFromServer` (`browser/lib/src/store.ts` ~4802): WS or HTTP, embedded vocabularies via the host. The server never revalidates an external term (ontology-kit README, spike S1). |
| ontology-kit | `source.json` + `base.json` generate `ontology/{vN,classes/<n>,properties/<s>}` at `https://ontola.github.io/atomic-plugins/ontology`, plus `terms.mjs`, `terms-v2.mjs`. `check` rebuilds and diffs, forbids edits to published files, and enforces the Gate (entries using the base must be `enabled:false` while the host ends in `.github.io`). |
| Embedded vocabularies | `https://atomicdata.dev/{task,work,contact,pipeline,money}/v1/...` in `lib/defaults`, https subjects, immutable by policy not by hash. |

Real cycles in today's data: `skill-requires` has `classtype: skill-v1` and `skill-v1`
recommends `skill-requires`. Every term's `parent` is its release, and the release lists
its terms. Any hash-the-whole-resource scheme breaks on both.

## 2. Subject format

Follow the grammar: `atomic:<kind>:<64 hex>`. Do not add `atomic:frozen:`: "frozen" is a
property of a kind (prop, lens, blob already are), not a kind, and a generic kind would
need its own parser, tree and sync path.

| Subject | Status | Identity inputs |
| --- | --- | --- |
| `atomic:prop:{hex}` | exists | ontology, shortname, datatype |
| `atomic:class:{hex}` | new | ontology, shortname, requires (set). Not `recommends`. |
| `atomic:{genesis}` | exists | namespace Ontology, minted once per release family (section 4) |
| release pin | no new subject | #2239 fingerprint `b3-<hex>` in lockfile and `terms-<r>.mjs` |

New kind, so no `did:ad:class:` alias. Decide in P2 that `to_legacy_scheme` leaves class
ids alone and peers without `canonical-scheme` simply do not get them.

## 3. Canonical bytes and hash

Reuse the property recipe (RFC 8785 JCS via `serde_jcs` and a TS twin, shared fixtures):

```
jcs = JCS({ ontology, shortname, requires: sorted ids })
hex = BLAKE3.derive_key("atomic class identity v1", jcs)
```

- `ontology` normalized as for properties (`did:ad:` to `atomic:`).
- Members of `requires`: `atomic:prop:` ids (`did:ad:prop:` is rewritten), or an https
  core term as is (core stays https per the schema-routes decision). Sorted by byte
  order; a duplicate member is rejected, as is any other kind of identifier.
- Not hashed: per-property default values (#2385), views and their configuration
  (#2386), `recommends`, name, description, translations, constraints (incl. `class`
  links), `deprecatedProperties`, order, widgets, and a future `replaces`. Editable
  presentation, optional fields and value rules never mint ids, same rule as property
  identity.
- Shortname keeps the kit's `-v1` suffix; a changed `requires` set changes the id.
- Vectors: `lib/tests/fixtures/class-identity.json`, asserted by Rust and TS like
  `schema-lockfile.json`.

### Related issues (checked 2026-10-28)

- #2385 (schema-level defaults) proposes a `default` in the per-property class
  constraints map or a separate Class-level defaults map. Both live outside the class
  hash, so adding or changing a default never mints a class. No conflict.
- #2386 (split table templates into schema and custom views): schema owns types,
  requiredness, cardinality, constraints and defaults; views own presentation. Views
  reference stable property ids and sit outside the hash, so a class gains views without
  a new id. Note for that discussion: "requiredness" is `requires`, which is hashed, so
  making a field required later is a new class (by design); defaults, enums and
  cardinality are not.
- #2243 (shared identities across drives) asks whether the namespace should stay the
  drive-local `parent`. Class identity uses the same `ontology` input as properties
  (`parent`), so a table-local row class still gets a drive-specific id. If #2243 changes
  how the namespace is derived for properties, the class recipe must follow in the same
  change; this plan does not decide that.

## 4. Cross references and cycles

Identity is name plus shape, not whole content, so cycles do not arise.

- A Property id needs namespace, shortname, datatype only; `classtype` is a class
  constraint now, so Properties are leaves.
- A Class id needs required property ids and the namespace; no class names another class.
  `skill-v1` constraining `skill-requires` to `{class: skill-v1}` is outside the hash.
- A term's `parent` is the namespace Ontology, minted once; its id does not depend on the
  lists it holds (mutable resource data).
- Namespace choice, decision for Joep:
  N1 (recommended). One Ontology per release family, minted by one genesis commit from an
  Ontola publisher agent; id committed in `ontology-kit/ids.lock.json`. It is a real
  resource (public read, license, publisher) and unchanged terms keep their first
  release's namespace, as the kit already does with `parent`.
  N2. A fixed string like `https://atomicdata.dev/work/v1`. No key, but resolvable only on
  hosts that embed it: the "two vocabulary homes" problem again.
- No self tokens, no SCC unit objects (#1262/#2045 mechanism). If identity inputs ever
  cycle, the kit `check` fails: it is a source bug.
- Frozen only at identity level: terms may require core https terms, and the fingerprint
  covers those strings, not the content behind them. Reword the Frozen Graphs page as
  "pinned names", since an https link makes a graph not frozen by its own definition.

## 5. Storage and resolution

Rust (lib, server)
- Terms stay ordinary resources with Loro snapshots. No `Tree::Frozen`, no `/frozen` routes.
- `identifiers.rs`: `ATOMIC_CLASS_PREFIX`, `is_class_id`, `class_hash_hex`; `DidKind::Class`.
- `class_identity.rs` beside `property_identity.rs`.
- `commit.rs`: add class ids to `is_content_addressed_id` and a `verify_class_genesis`
  beside `verify_property_genesis`; `check_class_identity_unchanged` rejects edits to
  parent, shortname and `requires`. `trash.rs` refuses to trash prop ids; classes get
  the same (their parent is part of the id).
- `import_vocabulary(bundle, fingerprint)` in lib: parse the JSON-AD array, recompute
  every prop and class id from the fields in the same bundle, recompute the fingerprint,
  then write through the embed path (`add_resource_opts`, no commit, `read: publicAgent`,
  parent = namespace). All or nothing. Used by `populate` and by plugin install.
- Server: plugin install (host ABI `vocabularies`, #2257 merged) accepts the bundle in the
  app version and calls `import_vocabulary`; the manifest check "vocabulary exists on the
  server" is met by shipping it. `GET /did?subject=atomic:class:...` serves what is stored.
- No `Cache-Control: immutable` on these: identity is immutable, descriptions are not
  (differs from the #1262 plan).

TypeScript (`@tomic/lib`)
- `class-identity.ts` twin. On receipt (fetch, WS update, sync), a resource whose subject
  is `atomic:prop:` or `atomic:class:` must recompute to that subject from its own
  propvals, else `failResource` (unverified whether the fetch path calls
  `property-identity.ts` today).
- Missing-term lookup order: local store / ClientDb; the release bundle shipped with the
  app or plugin (`registerVocabulary(bundle)`); the connected server's `/did?subject=`;
  an optional, removable catalog server list (default atomicdata.dev, never named in the
  spec); all verified by recompute. No DHT/pkarr hash discovery planned.
- Persist bundled terms in ClientDb (#1262 left this undone).
- Sync: no new frames. Terms outside a user drive are not part of drive reconcile; peers
  get them from their own bundle or a server. #1262 Phase D (`FROZEN_REQUEST`) is not
  revived; revisit only if a P2P e2e shows a missing term.

## 6. Validation

- Identity recompute: Rust commit path (prop exists, class added), TS receipt (new),
  bundle import (new), `atomic-cli schema check`.
- Release: fingerprint recomputed on bundle import and in the kit `check`; mismatch
  rejects the bundle. Descriptions sit outside both hashes by design, so a host can show
  different prose for a pinned id; say so in the docs.
- A hash proves the fields, not who published them. Provenance is the namespace
  Ontology's signer (schema-catalog.md already separates the two).
- Write path stays permissive (schema-routes policy A). #2160 (enforce on commit) is
  independent; until it lands a pinned class constrains nothing server-side.

## 7. ontology-kit: emit, host, retire the Gate

Emit (new `ontology-kit/release.mjs`)
- Input stays `source.json`; `classtype` moves into a `constraints` section.
- Computes prop and class ids in pure code from `ids.lock.json`: deterministic, offline,
  no signer or server in `build`.
- Writes `ontology/<release>.release.json` (JSON-AD array: Ontology, Classes, Properties
  with final `atomic:` subjects, plus the fingerprint).
- Writes `terms-<release>.mjs/.d.mts` with today's shape (`classes[n].subject`,
  `properties[n].subject`) plus `RELEASE_FINGERPRINT`, so plugin imports barely change.
  Older `terms*.mjs` stay byte-identical (bundle reproducibility rule).
- `mint` command: one genesis commit per namespace, id into `ids.lock.json`; `check`
  verifies lock entries.
- `check` keeps fresh-build-equals-committed and published-files-immutable. It drops the
  base-literal rule and the `--published` base-move exception.
- The kit's lens catalog is a third lens implementation; out of scope, asked of Michiel.

Hosting instead of GitHub Pages
- Primary: the bundle inside each published app version (`apps/<id>/<version>/`),
  installed by the host. Self-contained, offline.
- Secondary: same file committed and attached to a GitHub release for review and tools;
  optional mirror in the atomicdata.dev catalog.
- Delete `ontology-published.yml` and `served.mjs`. The `ontology` lane's dev-server
  rewrite of subjects to a local origin ("localhost") disappears: `atomic:` ids have no
  origin, and plugin e2e needs no network to `ontola.github.io`.

Gate
- It exists only because the base is a temporary host. Once P5a/P6 land no subject
  depends on a host: remove the Gate rule and `isTemporaryBase`; `base.json` survives only
  as the legacy alias base (section 8). Entries are enabled per plugin after their own e2e.

## 8. Migration of released v1/v2 (and v3 if upstream has it)

Constraints: published Pages files are never deleted; `terms.mjs`, `terms-v2.mjs` and
published `apps/<id>/<version>/ui.js` bake github.io subjects and are immutable. Real data
is small: the Gate kept the entries disabled, so only test, e2e and developer drives
hold these subjects.

1. Keep reading: Pages files and old `terms*.mjs` untouched.
2. Re-issue the same names as the next release (number: check upstream; the Education
   README mentions a v3) in the new namespace, same shortnames and datatypes.
3. Aliases: decided 2026-10-28 that the old-to-new mapping is a core `replaces` property
   on the new term (value: the old https subject). It is not part of any identity hash.
   The kit may still generate `aliases.mjs` from it for resolvers: `accepts(rowClass)`
   takes both, `read` understands old keys, `write` writes new. The property itself is
   specified and added in P4 or later.
4. Old rows: generate `atomic:lens:` lenses from each old https property URL to its new
   `atomic:prop:` into the release bundle (`docs/src/schema/lenses.md` allows https
   `from`). Class `isA` needs no lens; views list both class subjects via the alias map.
5. Dev drives are re-created or rewritten, replacing the kit's "Moving to the stable
   domain" steps.
6. Rebuild and bump every plugin bundling `terms*.mjs`: calendar, issue-tracker (and
   todoist-app), google-tasks, timesheets, money, moneybird, learning (`apps.mjs check`
   forbids editing published versions).

Embedded `atomicdata.dev/*/v1` vocabularies stay https until P8; the same alias and lens
recipe applies (the table templates of #2243 bind to them).

## 9. Interaction with Loro

- Terms are Loro-backed resources, not read-only blobs. Identity fields cannot change
  (checked on every commit); description, name and constraints can, if rights allow.
- Shared vocabulary rights: `read: publicAgent`, `write` for the publisher agent only.
- Bundle-imported terms have no commit history, like `lib/defaults` today. A later
  publisher commit still verifies against fields. Unverified: snapshot creation for an
  import-only resource on its first commit; test in P4.

## 10. Drive-app catalog and Atomic Education

- `integrations/catalog.json`: each rebuilt plugin gets a new version and
  `app-module-integrity`; `enabled` flips only after its e2e ran. Plugin vocabulary
  requirements name release bundles, not URLs.
- `schema-catalog.md` "frozen package distribution" becomes: bundle + fingerprint +
  lockfile; its release and cycle paragraphs are replaced by section 4.
- Atomic Education (app in atomic-plugins `integrations/learning/`; the atomic-education
  repo holds `core/`, content, docs): uses `skill-v1`, `lesson-v1`, `mastery-v1` and
  their properties. `skill-requires/-recommends/-equivalent-to` are the self-cycle, so it
  is the best proof and, being declared-not-verified and disabled, the cheapest first
  consumer. Changes: `adapter.ts` imports the new release module; `core/` untouched (no
  Atomic imports); e2e drops `ontola.github.io`; atomic-education README/docs updated
  (Dutch text: no em dashes). Do it before learner data exists.

## 11. Tests by layer (cheapest first)

- Rust unit: class id vectors; order independence; `did:ad:` ontology normalizes; reject
  overlap and unknown member kinds; commit changing shortname/requires of an
  `atomic:class:` rejected, description edit accepted; `import_vocabulary` rejects a
  tampered id, tampered fingerprint, half-bad bundle (nothing written).
- TS unit: same fixture; receipt verification rejects mismatch; lookup order with a fake
  server; offline bundle registration.
- Integration (`*.integration.test.ts`, real server): install a bundle; a second agent
  resolves `atomic:class:` via `/did?subject=`; `check_required_props` rejects a row
  missing a `requires` prop of the pinned class (the gap schema-routes found for frozen).
- Kit (`node --test ontology-kit/`): deterministic build; ids equal the Rust vectors; alias
  map complete; `check` fails on a cycle, an edited published release, a lock mismatch.
- One Playwright: Atomic Education on a server with no route to github.io. Not `@smoke`.
  Update `TESTING_COVERAGE.md` (vocabulary install, receipt verification).

## 12. Phased PR list

Sizes: S under 200 changed lines, M 200 to 800, L above.

| PR | Repo | Content | Size | After |
| --- | --- | --- | --- | --- |
| P0 | atomic-server | Docs: align `json-schema-code-first.md`, `schema-catalog.md`, `completed/schema-routes-decision.md` with #2151; reword Frozen Graphs; add this plan | S | decision 1 |
| P1 | atomic-server | `docs/src/schema/class-identity.md`, `identifiers.md` row, vector fixture | S | P0 |
| P2 | atomic-server | Rust: identifiers, `class_identity.rs`, commit verify, trash, subject tests | M | P1 |
| P3 | atomic-server | TS: `class-identity.ts`, receipt verify, lookup order, ClientDb persistence | M | P1 |
| P4 | atomic-server | `import_vocabulary`, plugin-install hook, `atomic-cli schema release` | M to L (split lib/server, cli) | P2, #2239 |
| P5a | atomic-plugins | Kit: `release.mjs`, `ids.lock.json`, `terms-<r>.mjs`, `aliases.mjs`, new `check`; first release re-issues v1+v2 | M | P2 vectors, P4 format |
| P5b | atomic-plugins | Remove Pages workflow, `served.mjs`, Gate, `ontology` lane rewrite | S | P5a |
| P6 | atomic-plugins | Per plugin: new terms, accept old+new, version bump, e2e (7 plugins) | 7 x S/M | P5a, P4 |
| P7 | atomic-plugins + atomic-education | Learning adapter, e2e, enable entry, README | S | P6 (or first, as pilot) |
| P8 | atomic-server | Optional: re-issue embedded `*/v1` vocabularies as `atomic:` terms with lenses | L | own decision |

Critical path: P0, P1, then P2 and P3 in parallel, P4, P5a, P7 as the pilot. About 6 to 8
PRs in atomic-server and 3 to 4 in atomic-plugins before P6 fans out.

## 13. Open questions

Joep
Answered by Joep on 2026-10-28: Q1 yes, Q2 hash it, Q4 `requires` only, Q5 core
`replaces` property. Q3 (namespace N1 or N2, publisher key) and Q6 (timing) are still
open and block P5a, not P0 to P2.

1. Direction: is "frozen" met by `atomic:prop` + `atomic:class` + fingerprint, dropping the
   `did:ad:frozen` / `atomic:frozen:` stack? atomic-audio still carries 101
   `atomic:frozen:` ids (`rust/tests/schema-identities.json`); the 20 Oct analysis would
   migrate it.
2. Class identity: hash it (`atomic:class:`, offline, needs P2) or mint once like
   namespaces (no Rust change, but ids need a lockfile and a signer)?
3. Namespace N1 or N2? Who holds the publisher key that signs the mint (CI secret or you)?
4. `recommends` in class identity? Decided: no. Leaving it out makes them editable and
   matches #2239 calling an optional addition "compatible". The kit rule becomes "adding
   or removing a required field is a new class version".
5. Core `replaces`/`sameAs` property for old to new terms, or kit-only aliases (recommended)?
6. Timing: now, before the Gate lifts, or after #2160 (server enforcement)?
7. Accepted risks: a typo fix that changes members mints a new class (kit rule, `check`
   shows it); `ids.lock.json` is the one non-reproducible artifact, so commit it.

Michiel
1. OK to ship the vocabulary as a JSON-AD bundle inside each app version, installed by the
   host, instead of fetching from Pages?
2. Is v3 (Education README) already published, and which plugins do you want rebuilt first?
3. Do you need the kit's own lens catalog and interpreter, or can lenses be host `atomic:lens:`?
