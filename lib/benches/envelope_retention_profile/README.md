# Borrowing staged state during envelope retention

`resolve_staged_retention` inspects retention and parent properties. Cloning a
staged `Resource` for those reads also exports and reloads its Loro document.
Borrow staged resources instead, keeping database reads owned. The traversal,
audit/unknown handling, signature verification and stored bytes stay the same.

## Matched receiver measurements: 2026-10-30

Four alternating baseline/borrow pairs per size, with the exact same frozen
frames, ordinary signed envelopes and a fresh file-backed redb receiver.
Timers exclude sender reconciliation, database startup, reading the frozen
frames, network/TLS, browser/OPFS and validation after the search checks.
Normal 100 ms periodic durable flushing remains active.

| Resources | Receiver through LAST flush, median | Reduction | Receiver through complete title/body search, median | Faster borrow pairs |
| ---: | ---: | ---: | ---: | ---: |
| 5,000 | 6.865 → 6.355 s | 7.4% | 6.914 → 6.412 s | 4/4 |
| 10,000 | 16.463 → 15.319 s | 6.9% | 16.568 → 15.423 s | 3/4 |

Ranges overlap at 10k (baseline 15.712–17.073 s, borrow 14.941–16.890 s), and
one 10k pair was slightly slower. These are small shared-host samples on a
synthetic half-ProseMirror/half-properties workload, not general sync latency
guarantees or a reproduction of the issue/comment fixture in #2405.

Both builds contain the same diagnostic probes, disabled during the 16 timed
samples. Four additional diagnostic samples at 1k/10k confirm the mechanism.
At 10k, borrowing removes exactly 10,100 resource clones, snapshot exports and
snapshot loads. Retention resource reads remain 20,001 and retained-row scan
calls 9,901 in both variants. In that diagnostic pair, retention decision time
falls from 1.315 to 0.220 s. Probe timings are inclusive foreground elapsed
time, including waits; they are not additive CPU costs. Background flush work
is not directly timed by the thread-local probes.

All 20 matched runs pass projection, document state, version vector, history
metadata, exact retained envelope, complete title/body search and normal
reopen checks. All 42 envelope tests pass sequentially (26 before a 180 s
time cap, followed by the remaining 16); no failed assertions. Reopen checks
do not establish crash/power-loss durability.

Measured base: `f570405eb2ff14570ca26d4e91e82e5dafd338b5` (candidate25, with
envelope batching and the covering flush fix). The change branches from
`6614fd0ed3e7e0dcc993a425447a846444b4c619`, which changes an obsolete server test and its planning notes relative to the
measured revision; importer/retention code is identical.
This optimization depends on the staged-envelope path from #2381. It is
separate from search-state reuse in #2415.

## What the preceding profile found

Twelve initial runs used control/profile/profile/control at 1k, 5k and 10k.
Controls disable the probes; they do not remove the probe code. Profiled
receiver medians were 1.248, 7.267 and 14.253 s. At 10k, envelope verification
took 3.262 s, retention staging 1.359 s, overlay construction 0.802 s and
projection/index/envelope persistence 5.813 s. These phases contain nested
work; the per-call details are in [profile-results.json](profile-results.json).

Retention checks/read counts scale linearly (1,001/2,001 at 1k and
10,001/20,001 at 10k). Retention scans decoded no existing rows on these fresh
receivers. This does not reproduce a whole-table retention scan or establish
the cause of Joep's superlinear result on a different workload/revision.

The initial profiles also exposed frame-order variation: until the drive root
arrives, unknown ancestry conservatively prevents pruning, changing scan-call
counts. The matched borrowing trial therefore freezes the exact frames.

## Reproduction and artifacts

These files are diagnostic artifacts, not modules or benches compiled by the
shipping crate. The only production change is in `lib/src/envelopes.rs`.

1. Create a fresh worktree at the measured base. Apply
   [instrumentation.patch](instrumentation.patch) with `git apply --unidiff-zero`, copy
   [envelope_profile.rs](envelope_profile.rs) to `lib/src/envelope_profile.rs`
   and [sync_import_bench.rs](sync_import_bench.rs) to `lib/benches/sync_import_bench.rs`.
2. Build with `cargo build -p atomic_lib --bench sync_import_bench --features db-redb --profile e2e`.
   Save the executable reported by Cargo as `frozen-baseline` in a new
   `BENCH_PROFILE_ROOT` directory (default `/tmp/atomic-envelope-profile`).
   Copy it as `profile` too if rerunning the initial profiling matrix.
3. Prepare senders once with `BENCH_PREPARE=1 BENCH_N=<size>` and
   `BENCH_DIR=<BENCH_FIXTURE_ROOT>/fixture-<size>` for 1k, 5k and 10k. The
   fixture root defaults to `/tmp/atomic-sync-comparison`. Creation must use
   fresh directories. Signing keys and fixture databases are not published.
4. Capture each frame set with the baseline executable, setting `BENCH_DIR`,
   a fresh `BENCH_RUN` and `BENCH_CAPTURE_FRAMES=<BENCH_PROFILE_ROOT>/frames-<size>.json`.
   Capture is outside timing; remove its unused receiver directory afterward.
5. Apply [borrow-retention.patch](borrow-retention.patch), rebuild with the
   same profile and save the executable as `frozen-borrow`.
6. Wait for other builds/tests to finish, then run [trial.py](trial.py).
   It uses the two root variables above, alternates baseline/borrow ordering,
   validates every run and writes `trial.json`. [run.py](run.py) reproduces
   the initial profiling matrix with independently generated frame order.

[trial-results.json](trial-results.json) retains all 20 samples, summary
arithmetic and binary/frame hashes. The e2e profile uses Rust 1.98.1,
opt-level 2, no LTO, 16 codegen units and debug assertions. A clean shipping
build and other workloads remain useful follow-up checks; the observed
diagnostic result is not a universal speedup claim.
