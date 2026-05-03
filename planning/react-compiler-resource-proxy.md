# React Compiler vs `Resource` proxy mismatch

> Status: planned 2026-05-28. Bug class. See also
> `memory/react-compiler-resource-proxy-pitfall.md` for the runbook-style
> diagnostic.

## Symptom

Rendered UI shows stale state from the first render forever, despite
subsequent store updates that should change it. Reproducible cases this
session:

- `MetaSetter.tsx` — browser tab title stuck at "Atomic Data" because
  `hasResource = resource.isReady() && resource.subject !== unknownSubject`
  was memoized as `false` from a render that fired before the resource
  finished loading. `useString(name)` updated correctly; `hasResource`
  never re-computed.
- `SidebarItemTitle.tsx` — sidebar row stuck on the old folder name
  because `resource.title` (a Proxy getter) was memoized.
- `PluginList.tsx` — plugin list not refreshing after install because
  `drive.props.plugins` reads were memoized.

Every fix had the same shape: replace the proxy-read with a `useString`
/ `useArray` / `useTitle` hook so the value flows through
`useSyncExternalStore`.

## Root cause

`useResource()` returns a `Resource` proxy whose **reference identity is
preserved across renders by design** (so dependency arrays stay stable).
Its internal `_loading`, `_error`, `_cache`, etc. mutate in place when
`store.addResource()` fires `notify()`. React Compiler memoizes
expressions whose only inputs are stable references — `resource` is
stable, so its method/getter results are cached. The mutation the
Compiler can't see locks the cached value in.

This is unsafe by construction: the Compiler's central assumption
("same input reference ⇒ same output") is violated by every read off
`Resource`.

## Proposal

**Option A — Make the proxy version-stamped** (preferred):

```ts
// store.ts
private snapshots = new Map<string, { resource: Resource; v: number }>();
private notify(resource: Resource) {
  const prev = this.snapshots.get(key)?.v ?? 0;
  this.snapshots.set(key, { resource: resource.__internalObject, v: prev + 1 });
  // ...
}
```

The `v` field bumps on every notify, so `getSnapshot()` returns a new
object reference even when `.resource` stays the same. Tighter: bump a
proxy-level version flag that's part of the proxy's *own* identity (so
`resource !== resource` after an update). That forces React Compiler
caches keyed on `resource` to invalidate.

This breaks dep-arrays that rely on `resource` being referentially
stable across renders. Audit: `useLoroSync`, `useResource` consumers
that pass `resource` to memoized callbacks. Most pass `subject` instead;
the ones that don't can switch.

**Option B — Delete the `.props` getter Proxy and force the hook path.**
Right now `resource.props.X` returns the value of property `X` via a
Proxy getter. Remove that ergonomic but harmful surface; require
`useString(resource, X)` (or just `resource.get(X)` in non-render code).
Add an ESLint rule that flags `.props.<identifier>` reads inside
component bodies.

**Option C — Both.** A and B aren't exclusive; Option B narrows what
can be cached, Option A invalidates the cache when it would matter.

## Risk

- A: dep-array drift could trigger excessive effect re-runs across the
  codebase. Mitigate by auditing every `useResource`-returning hook and
  using `subject` (string) in deps where possible.
- B: source-incompatible — every `.props.X` site needs a hook. Could be
  staged: keep the Proxy but mark `@deprecated`, codemod incrementally.

## Effort estimate

- A: ~1 day to land + audit week to triage dep-array fallout.
- B: ~3 days codemod + lint rule + cleanup PRs.

## Concrete first steps

1. Grep the data-browser for `\.props\.\w` and `\.isReady\(\)` and
   `\.loading\b` *inside* component render bodies (excluding effect
   callbacks where re-evaluation is implicit). Build a triage list.
2. Pick one tab/screen with multiple hits, convert to hook-only, verify
   the e2e tests for that screen stay green.
3. Decide A vs B vs both based on what the triage shows.

## Audit candidates already known

From the session's session-end summary:
- `views/ChatRoomPage.tsx:342` — `!resource.isReady() || !commitResource.isReady()`
- `views/ResourceRow.tsx:33,37` — `resource.loading` / `resource.error`
- `views/ResourcePage.tsx:79,88,90,101` — `resource.loading`
- `views/Card/ResourceCard.tsx:95,99` — `resource.loading` / `resource.error`
- `chunks/Plugins/UpdatePluginButton.tsx:97-162` — `plugin.props.{name,namespace,version,config}`
- `chunks/TablePage/TableHeading.tsx:55` — `tableClass.props.requires`

These work today only because of compiler heuristics that may tighten.

## Audit headcount (2026-05-28)

Across `browser/data-browser/src` (excluding test files):

| Pattern | Hits |
|---|---|
| `.props.<ident>` reads | 103 |
| `.isReady()` calls | 10 |
| `resource.loading` / `resource.error` reads | 62 |
| `.title` Proxy-getter reads (`*.title`) | 109 |

~280 total suspect sites. Too many for site-by-site cleanup — confirms
the need for a systemic fix (Option A version-stamping or Option B
removing the `.props` getter), not a sweep. Recommend Option A first
so it invalidates all of the above implicitly; Option B can then be
done as cleanup with much lower urgency.
