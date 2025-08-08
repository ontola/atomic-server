Lessons learned from OpenDAL integration and terraphim_persistence pattern

- Consistency first: Switching only reads to OpenDAL while writes remain on Sled breaks read-after-write; dual-write or single-path is required for correctness.
- One abstraction boundary: Use OpenDAL as the single storage interface; let Sled/DashMap/RocksDB be OpenDAL services instead of directly coupling to them.
- Fastest-read via benchmarking: Measuring operator latency at startup and selecting the fastest improves read performance; still need write-all for durability.
- Tokio runtime scope: Avoid constructing runtimes deep inside libraries. Expose async APIs or use appropriate blocking adaptors.
- Migration strategy: Plan backfill and deletion symmetry. When introducing a new backend, provide tools/tests to migrate and keep stores in sync.
- Feature gating services: Keep backend choices behind features to reduce dependency surface and compile times.
- Key normalization: Stable, normalized keys (e.g., `document_<id>.json`) avoid cross-backend issues.
- Testing breadth: Memory-only configs are invaluable for CI; integration tests for each optional backend help catch configurational drift.
