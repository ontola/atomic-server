# Consolidation contract

How a change that *claims* to remove duplication is allowed to land.

The audit in [`duplication-and-consolidation.md`](./duplication-and-consolidation.md)
lists copies. This file is the gate: **a consolidation PR is not done until
production lines in scope went down, the remaining path is the one a reader
would look for, and behavior is pinned by tests written against the old code.**

You cannot get this from a green CI run. CI does not know whether you deleted
a copy or inlined a third one. The steps below are the substitute for a
guarantee.

## The three properties fight each other

| You do | Lines | Legibility | Behavior |
| --- | --- | --- | --- |
| Delete a second implementation | down | up | preserved *only if* the two paths already agreed |
| Split `store.ts` into modules | **up** (imports, re-exports) | up | preserved |
| Generate TS from Rust | hand-written down, generated up | up | preserved *only if* golden vectors pin both |
| "Unify" two paths that already disagree | down | up | **changed** |

So the rule is not "always do all three." The rule is: **pick the kind, then
satisfy that kind's gates.** A PR that only moves code between files fails
the line-count gate on purpose. Split a giant file in the *same* PR that
deletes a path, so the net is still down.

## Kind

Write this at the top of the PR, one of:

1. **Delete-duplicate** — two implementations of the same job in the same
   language. End state: one function, the other name is gone.
2. **Policy-split** — same shape, *different* behavior (example:
   `ingest_commit_json` vs `ws_apply::apply_commit_json`). End state: one
   function plus an explicit opts/preset. Any preset that tightens validation
   is a behavior change and needs its own tests, not a "cleanup" label.
3. **Bind-twins** — two languages that must keep producing the same bytes
   (signing, wire tags, pairing envelope, `normalizeServerUrl`). Do **not**
   delete either copy. End state: both load one shared fixture under
   `testdata/`, the way `testdata/pairing-request.json` already binds the
   browser and the server. See [`TESTING_COVERAGE.md`](../TESTING_COVERAGE.md)
   "one-sided contracts."
4. **Extract** — split a large file. Allowed only as part of kind 1 or 2 in
   the same PR. Extract-only is rejected.

If an equivalence test (step 2) fails, you do not have kind 1. You have
kind 2. Stop and say so.

## Required sequence

Do these in order. The tests in step 2 must land *before* the production
edit, on the unrefactored code. That is what makes "preserved functionality"
checkable instead of hoped-for.

### 1. Name the job and the scope

One sentence, plus the file paths the line counter will use.

> Job: apply a signed commit JSON body to a `Db`.
> Scope: `lib/src/sync/ws_apply.rs`, `lib/src/sync/engine.rs`,
> `flutter/rust/src/api/simple/ws_sync.rs`.

Scope is the files that implement the job, not the whole repo. Measuring
the repo hides a 200-line win inside noise.

### 2. Pin behavior on the *current* code

**Characterization tests first.** They must pass on `develop` before you
change production code. Commit them separately if that keeps the diff
readable.

What to write depends on kind:

**Kind 1 (true duplicates).** While both implementations still exist:

```text
for case in fixtures {
    assert_eq!(path_a(&case), path_b(&case));
}
```

Same inputs, same outputs, including error strings where callers branch on
them. If this assertion fails, switch to kind 2.

**Kind 2 (policy-split).** Do not force the paths to agree. Write one test
per preset that names the policy (`validate_rights: false` on the replica
path, etc.). After the merge, those tests still call the *same function*
with different opts. A later PR that turns a replica into a hub is then
obvious: a preset test fails.

**Kind 3 (bind-twins).** One file under `testdata/` (or
`lib/src/genesis_test_vectors.json`). Both language suites load it. A field
rename breaks both, which is the point. Existing models:

- `testdata/pairing-request.json` — browser sends, server accepts
- `lib/src/genesis_test_vectors.json` — Rust and TS byte-identical certs
- RBSR / drive-hash golden vectors in `lib/` and `browser/lib/`

**Kind 4.** No extra tests beyond the kind-1/2 tests in the same PR.

Also run the layer that [`TESTING_COVERAGE.md`](../TESTING_COVERAGE.md)
already names for this flow (protocol / glue / e2e). A unit test of the new
helper is not a substitute for the glue test that used to cover the deleted
path.

### 3. Measure before

```sh
scripts/consolidation-measure.py --write /tmp/consol-before.json -- \
  lib/src/sync/ws_apply.rs lib/src/sync/engine.rs
```

Paste the table into the PR.

### 4. Make the change

One remaining implementation. Do not leave the old name as a deprecated
alias unless it is a published API (`@tomic/lib` export, Flutter FFI). If
you must keep an alias, it is a one-line call through — not a second body —
and it counts as a public item, so the public-item gate will notice.

### 5. Measure after, grep, tests

```sh
scripts/consolidation-measure.py --baseline /tmp/consol-before.json -- \
  lib/src/sync/ws_apply.rs lib/src/sync/engine.rs
```

The script exits non-zero unless the gates below pass.

Then:

- Characterization / equivalence / golden tests still pass, **against the
  same expected values** you recorded in step 2. Updating the fixtures in
  the same PR as the refactor means you are not measuring preservation.
- `rg -n 'old_function_name'` is empty (changelog and this PR description
  excepted).
- The coverage map gets a row if you added a shared fixture.

## Gates

`scripts/consolidation-measure.py` enforces the numeric ones. The rest are
the PR checklist.

| Gate | Kind 1 / 2 / 4 | Kind 3 (bind-twins) |
| --- | --- | --- |
| Hand-written production non-blank lines in scope | **strictly down** | may stay flat or rise by the fixture; must not add a *third* copy |
| Largest file in scope, non-blank lines | must not grow | must not grow |
| Public items in scope (`pub ` / `export `) | must not grow | must not grow |
| Tests / generated files | excluded from the line budget; they may grow | the shared fixture is the feature |
| Equivalence or golden tests | pass before *and* after, fixtures unchanged | both languages load the same file |
| Deleted symbol | zero remaining references | n/a |

Generated files (`GENERATED WITH`, `@generated`, flutter_rust_bridge output,
`ontologies/*.ts`) are excluded from "hand-written." Deleting a hand-written
`urls.ts` in favor of generated ontologies counts as a win even if the
generated file is large.

## Legibility (not fully mechanical)

The line counter cannot tell a clever helper from a maze. These are the
human checks; fail the PR if any is false:

- A reader who knows the job name can find the remaining function from
  `rg` without walking three wrappers.
- The PR description states the remaining path in one sentence
  (`engine::ingest_commit_json` is the only apply).
- You did not rename something solely to make the grep for the old name
  pass.
- Comments that said "keep in step with `<other file>`" are updated or
  deleted so they do not describe a copy that is gone.

If those are true and the numeric gates pass, legibility improved in the
only way this repo can check: **fewer places to read for the same job,
and the biggest file in scope did not get bigger.**

## What this deliberately rejects

- A "cleanup" that adds an abstraction layer and keeps both old paths as
  callers — lines up, job still has two bodies.
- Splitting `store.ts` with no deleted path — lines up, job count unchanged.
- Merging `ws_apply::apply_commit_json` into the hub ingest *without*
  naming the replica preset — that is a rights-check behavior change
  disguised as dedup.
- Updating golden expected bytes in the same commit as the encoder change
  and calling it "tests still pass."
- Measuring the whole repository so a 2 000-line feature hides a 50-line
  duplication win, or the reverse.

## PR checklist (paste into the description)

```md
### Consolidation
- Kind: delete-duplicate | policy-split | bind-twins | extract+delete
- Job (one sentence):
- Scope paths:
- Characterization / golden tests committed before the production diff: yes
- `scripts/consolidation-measure.py --baseline` exits 0: yes
- Before / after table pasted below
- `rg` for the deleted name is empty: yes
- TESTING_COVERAGE.md updated if a shared fixture was added: yes / n/a
```
