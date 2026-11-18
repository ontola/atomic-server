# Initial sync with loaded search state

`sync_import_bench.rs` measures the native sync engine from sender
reconciliation through receiver import, the LAST durable flush, pending search
index work and complete title/body queries. It uses ordinary signed envelopes
and a fresh file-backed redb receiver. It excludes fixture creation, database
startup, network/TLS, authentication handshakes and browser/OPFS.

Prepare a sender once, then reuse it for every build and repetition:

```sh
BENCH_PREPARE=1 BENCH_N=1000 BENCH_DIR=/tmp/sync-fixture \
  cargo bench -p atomic_lib --bench sync_import_bench --features db-redb --profile e2e
BENCH_DIR=/tmp/sync-fixture BENCH_RUN=/tmp/sync-receiver-1 \
  cargo bench -p atomic_lib --bench sync_import_bench --features db-redb --profile e2e
```

Both directories must be new when created. Use a new `BENCH_RUN` for each
repetition; do not include compilation in timing. The executable prints a JSON
row only after validating projections, full document state, version vectors,
history metadata, retained envelope equality and complete search results,
then reopening the receiver and repeating those checks. Reopen is a normal
close/open check, not a process-kill or power-loss test.

Half the fixture resources have a ProseMirror body of roughly 1 KiB, and half
have properties only. They all have a searchable title and signed envelopes.
The sender's native hash-map iteration determines chunk order, so repetitions
carry the same resources, snapshots and envelopes but need not have identical
frame ordering. This synthetic workload does not reproduce the 10k issue and
embedded-comment fixture in PR #2405.

## Comparison method

Build the benchmark with the original `body_text` implementation and with the
loaded-document implementation using the same source, harness, Rust toolchain
and `e2e` profile (`opt-level=2`, LTO off, 16 codegen units, debug assertions on).
Save both executables before running. The baseline restores only
`lib/src/search/mod.rs` from the parent revision; the harness and other files
are identical. Alternate baseline/optimized and optimized/baseline pairs.
Allow compilation and linting to finish before collecting samples.

`durableSeconds` includes sender reconciliation and ends after LAST import and
flush return. `searchableSeconds` additionally includes pending-index draining
and both search checks. `receiverSeconds` subtracts sender reconcile time.
State/envelope/reopen validation happens after all these timers stop.

The baseline used here still writes imported envelopes individually. This
comparison does not include or evaluate the separate envelope batching PR
#2381. No sync protocol, signature, storage encoding or durability policy
changes are made by search-state reuse.

## Measurements: 2026-10-30

Base revision: `aca3106e` (full SHA in the JSON). Rust 1.98.1, AMD EPYC 9V74,
five visible logical CPUs and a four-core cgroup quota; the benchmark uses a
single-threaded runtime. All 20 timed samples are retained: six pairs at 1k
and four at 5k. No compilation or linting ran concurrently with timing.

| Resources | Samples per build | Durable median, original → reuse | Search-ready median, original → reuse | Search-ready median reduction |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 6 | 2.614 → 2.489 s | 2.622 → 2.499 s | 4.7% |
| 5,000 | 4 | 12.949 → 12.666 s | 12.999 → 12.714 s | 2.2% |

The search-ready ranges overlap: 2.326–2.960 s original versus 2.365–3.102 s
reuse at 1k, and 12.655–13.604 s versus 12.367–13.099 s at 5k. Reuse was faster
in only 3 of 6 paired comparisons at 1k and 3 of 4 at 5k. These small,
shared-host samples suggest a modest gain but **do not establish a repeatable
end-to-end speedup**. Hash-map-dependent frame ordering is another source of
variation; no exact-wire-order comparison or statistical significance is
claimed. In particular, the much larger isolated extraction microbenchmark
ratio must not be presented as a sync speedup.

The 1k runs each imported 1,001 resources/envelopes in 21 chunks, carrying
4,884,935 application bytes. The 5k runs each imported 5,001 in 101 chunks,
carrying 24,449,650 bytes. All runs passed state, projection, version vector,
history metadata, envelope, complete search and reopen checks. Fixture
preparation and validation beyond the search checks are outside the timer.

[Per-run JSON](sync_import_search_state_2026_10_30.json) includes every sample,
summary arithmetic, binary and fixture-manifest hashes, harness hash, build
profile, base revision and host load observations. Fixture databases contain
signing credentials and are intentionally not checked in; only invented data
and aggregate measurements are published.
