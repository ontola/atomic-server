---
name: atomic-do-ci
description: Run and investigate Atomic Server PR CI on DigitalOcean using Docker and Dagger, with verified build reuse, bounded temporary runners, preserved reports and cost accounting. Use when the user requests DigitalOcean CI or its runner/cache operations.
---

# Atomic Server CI on DigitalOcean

Use the repository-owned runner instead of reconstructing cloud operations from
chat history. The canonical copy of this skill is `docs/skills/atomic-do-ci/` in
`ontola/atomic-server`. Read [operations](references/operations.md) for the run
procedure and [measurements](references/measurements.md) when choosing hardware
or interpreting speed/cost. Keep observed results separate from proposed changes.
For changes to Rust component caching, read
[the cache guard's history](references/cargo-cache-history.md) before removing it.

User instructions determine the PR, integration stack, account, machine count
and spending scope. Reuse authorization already present in the conversation;
credentials alone do not authorize additional accounts, larger fleets or an
unbounded retry campaign. The read-only `plan` precedes paid provisioning. Keep
credentials outside Git and do not print tokens or private keys.

Pin the exact clean source SHA in a task-owned worktree. Runner and Dagger APIs
must match that revision. If required CI changes are only on another branch,
prepare and record an explicit integration candidate; do not label the original
PR head as the tested commit. This skill does not authorize merging or deployment.

Use `scripts/ci-fanout.py` for a cold fleet, or the snapshot-aware
`scripts/ci-fanout-warm.py` for writable clones of an existing volume snapshot.
For laptop-independent runs, use `scripts/ci-fanout-cloud-launch.py`: a small
DO controller runs the same cold or snapshot-backed scheduler, while a deliberately retained regional
volume stores verified build archives and allowlisted reports. Include control
compute and volume time in the campaign budget. Launch autonomous supervisor
and reaper services before bootstrap, keep credentials on the temporary boot
disk, and collect reports without downloading the build cache. Retained storage
requires its own explicit authorization; a successful test run does not prove a
build archive was completed. Read the operator guide before provisioning.

Set a finite deadline, explicit account identities/prices and an external runtime
directory. Stay with the run until results and cleanup are verified. Independent
completed test failures are collected; source, transport, global-report and
deadline failures remain fatal. Do not extend a campaign deadline merely to retry.

The runner finishes all ten checks and the complete browser inventory, then
retries only completed ordinary browser failures once. Immediate browser retries
are disabled. Read `browser-merged.json` for the final counts; recoveries remain
`flaky`, and raw first/retry reports and traces remain available. A passing export
command is not proof of passing tests.

After completion, report the tested SHA, result, complete CI duration including
setup, cleanup duration, passed/skipped/flaky/failed counts, artifact paths,
estimated compute/storage cost and independently verified resource deletion.
Retain only explicitly intended snapshots. Cache contents and previous test
receipts are never evidence that a changed commit passed fresh tests.
