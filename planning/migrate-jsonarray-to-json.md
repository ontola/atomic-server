# Migrate Canvas strokeData Datatype from jsonArray to json

Change the datatype of `https://atomicdata.dev/ontology/canvas/strokeData` from the non-existent `jsonArray` datatype to the standard native `json` datatype, and update the Rust backend, browser frontend, and Flutter mobile clients to support it.

## Decision

- [x] Change `strokeData` property datatype from `jsonArray` to `json` in ontology.
- [x] Support Loro native representation for `Value::Json` (allowing Lists and Maps to merge natively).
- [x] Update `Resource` collection helpers in `resources.rs` to handle both `Value::Json` and `Value::JsonArray`.
- [x] Update Flutter app canvas initialization and stroke count logic.
- [x] Update documentation and comments in browser frontend.

## Proposed Changes

### 1. Configuration & Ontology
- [x] Modify `lib/defaults/default_store.json` at line 1411:
  - Change `"https://atomicdata.dev/properties/datatype"` to `"https://atomicdata.dev/datatypes/json"`.

### 2. Rust Backend (`atomic_lib`)
- [x] Modify `lib/src/loro.rs`:
  - Update `set_property` to serialize `Value::Json` natively using Loro maps/lists (recursively mapping nested JSON elements).
  - Update `atomic_value_from_tag` for `"json"` tag to parse both string-serialized legacy JSON and native Loro values (backward compatible).
  - Update test cases (`json_array_concurrent_push_merges`, `delete_from_json_array`, `undo_exports_updates_for_sync`, `undo_redo_json_array`, `undo_delete_restores_item`) to use `Value::Json` instead of `Value::JsonArray`.
- [x] Modify `lib/src/resources.rs`:
  - Update `push_list_item`, `insert_list_item`, `clear_json_array`, and `delete_list_item` to match and mutate both `Value::JsonArray` and `Value::Json`.
- [x] Modify `lib/benches/loro_bench.rs`:
  - Update references of `Value::JsonArray` to `Value::Json`.

### 3. Flutter & Flutter-Rust boundary
- [x] Modify `flutter/rust/src/api/simple.rs`:
  - Update `create_canvas_with_folder` to initialize `strokeData` as `Value::Json` instead of `Value::JsonArray`.
  - Update `load_canvas_strokes`, `undo_canvas`, and `redo_canvas` to support both `Value::Json` and `Value::JsonArray` for backward compatibility.

### 4. Browser Client
- [x] Modify `browser/lib/src/canvas-strokes.ts` and `browser/lib/src/canvas-strokes.test.ts`:
  - Update comments and test description replacing `jsonArray` with `json`.

## Verification Plan

### Automated Tests
- [x] Run `cargo test -p atomic_lib` to verify backend changes. (Completed: all 98 tests passed)
- [x] Run `cargo bench -p atomic_lib --bench loro_bench` to ensure benchmarks compile and run. (Completed: benchmarks compiled and executed)
- [x] Run browser unit tests (`pnpm test` or `vitest` in the browser folder) to verify frontend parsing. (Completed: all 59 tests in @tomic/lib passed)
