OpenDAL integration review (atomic-server)

- Branch: origin/opendal; commits include "WIP OpenDAL #433" and "WIP dal".
- Changes: adds OpenDAL (services-sled) to `lib/Cargo.toml`; in `lib/src/db.rs` adds `dal_resources: opendal::Operator`, initializes it with OpenDAL Sled at `<db_path>/opendal` tree `resources_v1`, and switches `get_propvals` to read via `dal_resources.read(subject)` using a new Tokio runtime.
- Gaps / issues:
  - Writes still go to Sled via `set_propvals` (OpenDAL not used for write). Reads now use OpenDAL, so read-after-write breaks (OpenDAL store is empty).
  - Deletion still removes from Sled tree; OpenDAL items (if any) won’t be deleted.
  - New Tokio runtime inside the DB struct risks nested runtimes and increases complexity; prefer async surface or OpenDAL blocking API.
  - Parallel index/other code still relies on Sled trees; storage is now split across two backends.
- Recommendation: unify I/O through OpenDAL (including Sled via `services-sled`) OR dual-write until migration completes. Remove in-DB runtime; make read path async or use blocking layer. Add migration/backfill from Sled to OpenDAL and tests for CRUD consistency.

Multi-store pattern (terraphim-ai/terraphim_persistence)

- `Persistable` trait: save to all profiles, load from fastest. Key derived by implementor (e.g., `document_<id>.json`).
- `settings::parse_profiles`: builds OpenDAL operators for profiles (memory, dashmap, rocksdb, redb, sqlite, s3, atomicserver, etc.), benchmarks read latency and picks fastest.
- Implementations provided for `Thesaurus` and `Document`; includes memory-only helpers and tests for memory/rocksdb/redb/sqlite.
- This matches the intended architecture: write-multiplex + read-from-fastest.

Action items alignment

- Port the terraphim pattern to atomic-server: single abstraction via OpenDAL; write to all configured profiles (or at least primary+replica), read from fastest; ensure index/storage consistency and clear migration path.
