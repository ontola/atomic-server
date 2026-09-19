# Loro write paths: stop rewriting what should merge

> **Status:** Active. `push()` / `removeItems` / `moveListItem` /
> `removeListItemsById` are CRDT list ops. Markdown is `LoroText`. Remaining:
> MovableList container type, PropVals dual-write (other plan).
> Companion to [`loro-source-of-truth.md`](./loro-source-of-truth.md) (storage)
> and [`unify-resource-representations.md`](./unify-resource-representations.md)
> (browser cache).

## Why this exists

Arrays have been native `LoroList`s since 2026-04. That only helps if writes
are list operations. `push()` used to delete every item and write the array
back (TS) or mint a new container (Rust). Concurrent appends duplicated the
prefix. That append path is fixed.

This document is the rest of that audit: every other write that still treats
Loro as a JSON blob.

## Landed

- [x] `Resource.push()` / `Resource::push` → `list.push` on the existing
      container. Guard: `resource.test.ts` concurrent push, 
      `resources.rs` / `loro.rs` `resource_array_concurrent_push_merges`.
- [x] Rust `set_property` for arrays reuses list identity (`get_or_create_list`
      + `clear_list`). `set()` / `replaceListItems()` stay the *replace* path.

## This iteration (CRDT write APIs + call sites)

Membership add is now `push`. Membership remove and object/map `set` were
still whole-value rewrites.

- [x] `Resource.removeItems` / `Resource::remove_array_item` — delete matching
      list elements (CRDT positions), do not `set(filtered)`.
- [x] `useArray` exposes `remove` next to `push`; unique subject lists push
      with `unique: true`.
- [x] Call sites that did `set([...old, x])` / `set(old.filter(...))` use
      push/remove: Share rights, plugin permissions, AI chat messages, tags,
      ontology class/property lists, select/`allowsOnly` tags, private-drive
      favorites/drives/`sharedWithMe`.
- [x] Rust `set_property` reuses `LoroMap` identity for `Json` objects and
      `LocalizedText` (TS already mutated LocalizedText in place).
- [x] TS object properties write a `LoroMap` in place instead of
      `JSON.stringify` (legacy JSON strings still materialize).
- [x] `useLoroDocSync` — live `LORO_SYNC` of a resource's Loro doc, without
      TipTap cursors. Wired on canvas and AI chat.

`set()` / `replaceListItems()` remain the explicit replace path (forms that
reorder, canvas history-scrub, sorted ontology property lists).

## This iteration (delete-by-id, move, unique, LoroText)

- [x] Canvas erase deletes stroke *containers by id*, not `replaceListItems`
      of a stale snapshot. `removeListItem(i)` stays for callers that only
      have an index. Overlay undo still thinks in snapshots —
      [`canvas-undo-consolidation.md`](./canvas-undo-consolidation.md).
- [x] `Resource.moveListItem` — `list.delete` + `list.insert` on the existing
      LoroList (InputResourceArray drag). Not Loro `MovableList`: migrating
      stored `ResourceArray` would change the container type. Kanban already
      uses per-card fractional `sortOrder` (no shared list).
- [x] `unique: true` writes datatype tag `resourceArrayUnique`. After a remote
      import, duplicate string elements are deleted (keep first). Concurrent
      unique-push of the same subject converges to one. A real CRDT set
      (LoroMap of URL → unit) would drop order — not ResourceArray.
- [x] New empty lists get a dummy push+delete so Loro persists the container.
      Legacy snapshots still drop op-less empties
      (`empty_required_array_is_dropped_from_genesis`). Two peers who both
      *mint* a list before sharing a snapshot can still LWW; genesis that
      includes the dummy op gives later appends a shared identity.
- [x] Markdown / `description` writes a `LoroText` (prefix/suffix splice),
      not an LWW string. Names, slugs, dates stay registers. Legacy string
      registers convert on first markdown write.
- [x] AI stream: persist the assistant message when tokens start, splice
      `description` on the text part as LoroText, live-sync each message and
      its parts. `onFinish` updates the existing resource instead of minting
      a second one.
- [x] Human chatrooms already avoid a shared child-list (parent pointer +
      query). Do not "fix" them onto `messages[]`.
- [x] `CommitBuilder.push_propval` callers are genesis `isA` only (chatroom
      plugin). Incremental use is `Resource::push`.
- [ ] **PropVals dual-write, untagged heuristic, Flutter undo trees** — already
      [`loro-source-of-truth.md`](./loro-source-of-truth.md).
- [ ] **Loro `MovableList` container type** — would change stored ResourceArray
      identity; not migrated. `moveListItem` is delete+insert on `LoroList`.

## How to write arrays from here

| Intent | API |
| --- | --- |
| Append subject(s) | `push(prop, values, unique?)` |
| Remove subject(s) | `removeItems(prop, values)` |
| Move one subject | `moveListItem(prop, from, to)` |
| Replace / scrub | `set()` / `replaceListItems()` |
| Append JSON object (canvas) | `pushListItem` |
| Delete JSON object by container id | `removeListItemsById` |
| Delete JSON object by index | `removeListItem` (stale-index caveat) |

Do not build `[...existing, x]` and `set()` it. Do not `set(existing.filter)`.
