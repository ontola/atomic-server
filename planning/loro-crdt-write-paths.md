# Loro write paths: stop rewriting what should merge

> **Status:** Active. `Resource.push()` is a real `list.push` (2026-08-27).
> This iteration: membership *remove*, map identity, and live sync outside
> the document editor. Remaining: format-level limits Loro itself imposes
> (MovableList, LoroText, first-touch empty list).
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

## Still naive (format / product; not a silent rewrite)

These need a datatype or product change, not another `list.push`. Tracked
here so they are not rediscovered as "we forgot Loro."

- [ ] **Index-based deletes of *objects*** (`removeListItem(i)` on canvas
      strokes). Loro delete-at-index targets the CRDT id of whatever is at `i`
      *now*. A stale session can erase the wrong stroke. Fix: delete by
      container id, not integer. Overlay undo in `CanvasPage` still thinks in
      snapshots; see [`canvas-undo-consolidation.md`](./canvas-undo-consolidation.md).
- [ ] **Reorder** (`InputResourceArray` drag, kanban card order) rewrites the
      list. Loro `MovableList` is the type (`loro.rs` `movable_list_for_kanban`
      test only). Migrating stored `ResourceArray` order would change the
      container type.
- [ ] **`unique: true` is local.** Concurrent unique-push of the *same* subject
      can still duplicate. A real CRDT set would be a `LoroMap` of URL → unit,
      which is not `ResourceArray`. `removeItems` deletes every match, so a
      later revoke still works.
- [ ] **First append on a missing property.** Two peers each `insert_container`
      a new list; the map entry is LWW and one list can drop. Empty lists are
      not persisted by Loro (see `empty_required_array_is_dropped_from_genesis`),
      so genesis cannot seed identity. Unfixable without a Loro change or a
      dummy op on every array property at creation.
- [ ] **`LoroText` for markdown / description / chat bodies.** Those properties
      are LWW string registers. Only `documentContent` is collaborative text.
      Switching datatype would migrate every name/description snapshot.
- [ ] **AI streaming tokens** live in `useChat` until the turn finishes. A
      collaborative stream wants `LoroText` on the message resource, plus
      `useLoroDocSync` on each message — not just the parent `messages` list.
- [ ] **Human chatrooms** already avoid a shared child-list (parent pointer +
      query). Do not "fix" them onto `messages[]`.
- [ ] **`CommitBuilder.push_propval`** still puts a full array on `set`. Fine
      for genesis `isA`. Incremental use would drop items the builder does not
      hold. Callers should `Resource::push`.
- [ ] **PropVals dual-write, untagged heuristic, Flutter undo trees** — already
      [`loro-source-of-truth.md`](./loro-source-of-truth.md).

## How to write arrays from here

| Intent | API |
| --- | --- |
| Append subject(s) | `push(prop, values, unique?)` |
| Remove subject(s) | `removeItems(prop, values)` |
| Replace / reorder / scrub | `set()` / `replaceListItems()` |
| Append JSON object (canvas) | `pushListItem` |
| Delete JSON object by index | `removeListItem` (stale-index caveat) |

Do not build `[...existing, x]` and `set()` it. Do not `set(existing.filter)`.
