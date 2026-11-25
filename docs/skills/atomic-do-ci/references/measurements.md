# Observed CI measurements and optimization status

These are historical measurements, not current pricing promises or speed SLAs.
Raw logs/traces remain outside Git in the operator's `codex-atomic-ci` cache.
The complete results are also summarized on PR #2662 and its validation comments.

## Complete three-machine run, 2026-11-24

- Integration SHA: `f9fa24decec3a1cb8f2f9bab5f4c5f6654719f18` on develop
  `260f4b976a5866581afd5bf1d5f75faa93f72dab`; combines CI PR #2662 at
  `c61824443547f9996079f78acd7397211ad33f41` and filter repair #2666.
- Three 64-vCPU, 128-GiB VMs in atl1, each with its own writable clone of one
  existing builder snapshot. Eight browser workers per VM, one existing
  immediate Playwright retry. This predates the deferred-retry/shared-check work.
- Full CI including provisioning/setup/build: **26m35.832s**. Including volume
  cleanup: **27m26.132s**. Build: **10m21.039s**.
- Ten fresh public checks passed. All 387 browser identities reconciled:
  374 first-attempt passes, two retry passes, 11 existing skips, zero final
  failures. Rust: 1,890 passed, 42 existing skips, zero retries.
- Estimated compute $3.09484 plus temporary storage $0.04094 = **$3.13578**.
  Including the preceding complete negative three-machine attempt: **$6.98901**.
  All owned VMs, clone volumes and the temporary key were independently verified
  absent; the one intended source snapshot remains.
- Run key: `bench3retry-20261124t193112z`. Evidence: `summary.json`, `REPORT.md`,
  `cpu-utilisation.json`, `browser-case-evidence.json`, per-node results and
  `cleanup-independent-verification.json`. Controller log:
  `work/benchmark3-retry-controller.log` beneath the operator's cache root.

CPU sampling covered 92.5% of CI machine-seconds, omitting roughly the first
two provisioning minutes. Time-weighted mean across all 192 vCPU: **29.62%**,
equivalent to 56.88 fully busy cores. Per VM: 24.04%, 37.32%, 27.49%. Build mean:
46.55%; browser phases mean: 22.34%; all VMs briefly peaked near 100%. During
build/check/browser phases alone, excluding setup/gaps, the mean was 38.98%.
Each VM retained at least roughly 112.3 GiB MemAvailable.

The remaining retry-only cases were catalog creation stuck on `/app/new`
(#2668; 94.109s failed attempt, 6.831s retry) and website-version save/release
ordering (#2667; 2.505s then 4.100s). Canvas and saved-view/filter cases all passed
first try. Lower concurrency and code repairs changed together between the two
three-machine attempts, so their differences are not an isolated worker-count
experiment.

## Confirmed bottlenecks and missing telemetry

- Before the main build: **6m31.443s** of provisioning/preflight, about 24.5%
  of CI wall time, with low CPU during the recorded portion.
- Browser workspace build completed near command t=5m52; native E2E server
  compile finished at t=9m49 after 3m26 Cargo execution. The server embeds the
  frontend, imposing an ordering dependency. OCI layer export logged 57.1s.
- JS test check: **6m47.095s**, but package tests only began near t=5m51.
  TypeDoc check: **5m45.736s**, invoking TypeDoc only near t=5m35 after another
  JS/WASM build. JS integration compiled its native server in 2m02, then still
  paid its separate WASM/preparation cost before completing near ten minutes.
- The controller polls unfinished phases every 15s. Observed check-to-next-phase
  gaps were mostly 12–19s, including observation/upload/start overhead.
- Browser phases lasted about 2m37–2m50. Assertion/navigation/save waits consume
  wall time without saturating CPU. The catalog case above waited 90s for
  navigation; this is not proof of an external service delay.
- The server currently caps HTTP worker runtimes at eight (`server/src/serve.rs`),
  even on a 64-vCPU host. Background threads can add concurrency; the cap is not
  a hard eight-core limit for the entire process. Multiple isolated testservers
  can run on one VM.
- The collector retained CPU busy excluding idle+iowait, not the separate CPU
  states. Disk IOPS/latency/throughput, PSI and external-service critical paths
  were not recorded. Do not claim disk saturation or external API delay from
  low CPU alone.

## Other observations; do not mistake partial runs for complete CI

- First complete three-machine attempt at
  `5000fbbe0df48e34e7dd36cdf1b8ff5a49008b10`: **32m18.740s**, $3.85323
  compute/storage, ten passed checks, all 386 browser identities, three final
  browser failures and 14 retry-only cases. Independent jobs demonstrably
  continued after the first failure. Cleanup finished at 34m08.752s.
- Earlier four-machine cold attempt: build **10m46.608s**; failed in snapshot
  response reconciliation before full CI. A warm attempt restored its matching
  complete build in **26.808s**, then failed canvas tests under the old fail-fast
  controller. Combined compute/storage cost **$4.82253**. Neither establishes a
  complete four-machine CI duration.
- A prior 20×4-vCPU run on
  `3092204ccea70d2e835a4e2feb104e612cd72122` completed in **1h23m32s**, estimated
  compute **$1.33852**, with nine fresh checks, Rust evidence reused from verified
  identical inputs on the preceding pin, and 375 browser passes/11 skips/no
  flakes. It is not equivalent to a fresh ten-check run on a different commit.

## Implemented next steps versus proposals

The deferred retry implementation was published at
`22fd495388e86bc3958fd6c5fca530925fe2027e`: 44 controller/runner tests,
12 build-helper tests and all 57 Dagger tests in Linux Docker passed, including
real pinned Playwright selective execution. It was not part of the full cloud
run above. The current runner also implements manifest ABI 2/shared checks preparation and a reusable warm wrapper. Local validation includes 61 Dagger regressions in Linux Docker, controller/cache/warm fake-provider regressions and an independent operational review. Consult the PR head for the exact published revision and final test counts; this later implementation has not completed a new whole-application DO run. Do not reuse the older cloud run as acceptance.

Potential further work requires its own measurement: reduce provisioning/probe
waits; reuse unchanged workspace Rust crates safely instead of touching all
sources; overlap compatible native dependency preparation with the frontend;
and compare fewer cores or three isolated eight-worker servers per 64-core VM.
Three VMs × three local servers × eight workers permits 72 concurrent browser
tests, not a guaranteed threefold speedup. This grouping remains a proposal
until its runner and coverage/retry tests are implemented and measured.

HTML-only PRs still use the full gate by default. The measured full baseline is
26m36s, so 20–30 minutes is a conservative planning range pending new runs. A
future input-verified HTML-only route might take 10–15 minutes including VM
startup, but that is an unmeasured estimate, not an implemented path filter or
permission to skip Rust/Flutter checks solely from a filename suffix.
