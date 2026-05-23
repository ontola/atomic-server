# Canvas undo/redo: consolidation plan

> **Status:** Phase A landed (browser scrub gesture, `replaceListItems`,
> `strokeData` datatype = `jsonArray`, legacy string parser dropped).
> Phases B and C are the path to full browser ↔ Flutter parity.

## Where we are after Phase A

| Concern | Browser | Flutter |
| --- | --- | --- |
| `strokeData` Loro storage | `LoroList<LoroMap>` ✓ | `LoroList<LoroMap>` ✓ |
| Ontology declared datatype | `jsonArray` ✓ | `jsonArray` ✓ |
| Tap-undo / tap-redo | `resource.undo()` / `resource.redo()` via Loro `UndoManager` ✓ | Same — `AtomicClient.undoCanvas()` → Rust `resource.undo()` ✓ |
| Undo-button drag-to-scrub gesture | Released — pointer-capture handler on the button, `getLoroHistory()` for preview, `replaceListItems()` on release ✓ | Released — same gesture, `_loroStrokeStates`/`_loroVersionIds` precomputed via `warmResourceHistory`/`getResourceAtVersion` ✓ |
| Discarded-branch (scrub-back-then-draw → returnable forward fork) | ❌ Missing | ✓ Implemented (in-memory, ephemeral) |
| Dart-side action stack (`_allActions` / `HistoryAction` sealed class / `_pushAction`) | n/a | ✓ Still present — used for `_replayActions` when creating a `DiscardedBranch` snapshot |
| Whole-list write FFI (`set_strokes` array-arg branch + `saveFullStrokeState`) | n/a | ✓ Still present — used by the eraser path |

Phase A made browser and Flutter behaviorally equivalent for **drawing + tap-undo + scrub-and-revert**. The two remaining deltas are the discarded-branches feature (Flutter-only) and the Dart action-stack machinery (which only still exists to feed the discarded-branches feature and the eraser path).

## Phase B — Drop the Dart action stack, keep DiscardedBranches

The action stack (`_allActions`, `_actionIndex`, `_pushAction`, `_replayActions`, `_reverseAction`, `_applyAction`, `HistoryAction` and its `StrokeAdded` / `StrokesDeleted` / `StrokesReplaced` subclasses) is only read in two places after Phase A:

1. `_onUndoPanEnd` — to compute the current stroke snapshot when sealing a `DiscardedBranch`.
2. `_finishErase` / save-after-undo — to feed `saveFullStrokeState` (`set_strokes` array-arg branch).

Both can be served by simpler primitives.

### Concrete diffs

**`flutter/lib/canvas/infinite_canvas.dart`**

- `_onUndoPanEnd` line ~631: replace `final currentStrokes = _replayActions(_allActions);` with `final currentStrokes = List.of(_strokes);`. The live `_strokes` field is already the post-Loro state.
- `_isHistoryMode` preview line ~622–623: replace `_replayActions(_allActions.take(_historyIndex.toInt()).toList())` with `_loroStrokeStates[_historyIndex.toInt().clamp(0, _loroStrokeStates.length - 1)]`. The Loro-backed stroke states are already in memory from `_hydrateLoroHistory()`.
- Delete: `_allActions`, `_actionIndex`, `_canUndo`, `_canRedo`, `_pushAction`, `_replayActions`, `_reverseAction`, `_applyAction`, the `_isHistoryMode` branch in `_undo()` / `_redo()`, and the action-stack reset blocks at lines ~130, ~195. Simplify `_canUndoToolbar` / `_canRedoToolbar` to `_loroCanUndo` / `_loroCanRedo` (the `_isHistoryMode` ternary becomes redundant — during scrub, the toolbar shouldn't drive new undo/redo anyway).

**`flutter/lib/models/stroke_data.dart`**

- Delete `sealed class HistoryAction`, `StrokeAdded`, `StrokesDeleted`, `StrokesReplaced`. Keep `DiscardedBranch` (still needed; its content is just `List<StrokeData>`).

**`flutter/lib/canvas/infinite_canvas.dart`** — eraser path

The eraser currently calls `widget.store.saveFullStrokeState(_strokes)` after computing the filtered list. With the action stack gone, we need a Loro-native replacement. Two options:

- *Per-stroke deletes (preferred).* Add `delete_canvas_stroke(subject, index)` FFI binding around `resource.remove_list_item(CANVAS_STROKE_DATA, index)`. Iterate the erased indices in reverse and call once each — N Loro `delete(idx, 1)` ops, all under one `LoroDoc.commit()` (and therefore one `UndoManager` checkpoint) thanks to batching.
- *Bulk replace.* Add `replace_canvas_strokes(subject, strokes_json)` FFI bound to Rust `resource.replace_list_items(CANVAS_STROKE_DATA, items)` (mirror of the JS `Resource.replaceListItems` shipped in Phase A). Single atomic swap.

Going with bulk replace keeps parity with the JS API and is simpler. Add the FFI, point `_finishErase` at it, then delete `saveFullStrokeState`.

**`flutter/lib/gallery/canvas_store.dart`**

- Delete `saveFullStrokeState`. Callers updated above.

**`flutter/lib/atomic/atomic_client.dart`**

- Delete the public `AtomicClient.setStrokes`. Wire `checkoutCanvasVersion` to a new dedicated FFI (`revert_canvas_to_version` or similar) so it no longer rides on `set_strokes`.

**`flutter/rust/src/api/simple.rs`**

- Delete the array-arg branch of `set_strokes`. The function becomes a thin wrapper around the `checkout_version_id` payload — at which point it should be renamed `revert_canvas_to_version` and take `Vec<u8>` directly (regenerate FRB bindings).
- Add `replace_canvas_strokes(subject, items: Vec<serde_json::Value>)` that calls a new `resource.replace_list_items(CANVAS_STROKE_DATA, items)` on the lib side.

**`lib/src/resources.rs`**

- Add `pub fn replace_list_items(&mut self, property: &str, items: Vec<serde_json::Value>) -> AtomicResult<()>`. Mirror of the JS `Resource.replaceListItems` — `clear_json_array` then `push_list_item` for each, all within one `LoroDoc.commit()` so the `UndoManager` records one checkpoint.

### Verification

`flutter analyze` + `cargo test -p atomic_lib` + integration smoke: open a canvas, draw three strokes, erase one, undo, redo, scrub back, scrub forward.

## Phase C — DiscardedBranches in the browser

Port the Flutter UX so both apps surface the discarded-future as a recoverable card.

### State

```ts
type DiscardedBranch = {
  id: string;           // ULID
  fromIndex: number;    // index in canvas's Loro history when discarded
  strokes: CanvasStroke[];
  thumbnail?: string;   // data: URL, rendered offscreen
};
```

Kept in `CanvasPage` state (ephemeral, matching Flutter — persistence is open question, see below).

### Trigger

When the user lands a `replaceListItems` from the scrub gesture **and** subsequently pushes a new stroke (`pushListItem`) on top, the pre-scrub stroke list becomes a `DiscardedBranch`. The detection is "first stroke after a scrub-back-with-change": gate on a `pendingScrubArchive: { strokes, fromIndex }` field set in `onUndoPointerUp` and consumed (cleared + archived) in `pushStrokeToServer`.

### Thumbnail rendering

Render the branch's strokes to an offscreen `OffscreenCanvas`, then `convertToBlob({ type: 'image/png' })` → `FileReader.readAsDataURL` → `data:image/png;base64,…`. Cap thumbnail dimensions (e.g. 120×80) to keep memory bounded.

### UI

A horizontal strip of thumbnails along the bottom edge (toggle-able to keep it out of the way). Click → archive *current* state as a new branch, then `replaceListItems` with the clicked branch's strokes. Same mechanism as Flutter's.

### Persistence (open)

Flutter's branches today are lost on app close (the planning doc flags it: *"Decide whether `CANVAS_CACHE` undo history should persist"*). Options:

- *Ephemeral.* Match Flutter. Cheapest. Branches vanish on reload.
- *Stored on the canvas resource.* Add a `discardedBranches` propval (jsonArray of branch records). Persists; survives reload; consumes a property slot and bandwidth on every commit.
- *Stored in `ClientDb` only.* Browser-local, survives reload, doesn't sync. Splits the UX (you see your branches but not your collaborators'). Probably the right trade-off — branches are inherently a per-author concept.

Lean toward **ClientDb-only** (browser) + a similar **`canvas_branches` table in the Iroh/sled store** (Flutter), with no cross-device sync. That cleanly matches the *"undo is local"* semantics already chosen for the underlying `UndoManager`.

## Out-of-scope notes

- Cross-device undo sync — explicitly chosen against in `planning/loro-source-of-truth.md`. Stays local.
- Persistent named branches (i.e. an "I'd like to keep this branch and label it" feature) — different product question, not just a consolidation.
- Migrating pre-Phase-A canvases that stored `strokeData` as a JSON string — needs a one-time rewrite job; `parseCanvasStrokes` no longer accepts the legacy form.
