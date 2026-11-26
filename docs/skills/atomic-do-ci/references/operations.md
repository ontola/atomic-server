# Running a PR's CI on DigitalOcean

## Find the matching implementation

The runner lives in `scripts/ci-fanout.py`, remote execution in
`scripts/ci-fanout-runner.py`, host bundle caching in
`scripts/ci-browser-build.py`, and the Dagger module in `.dagger/`.
`CONTRIBUTING.md` documents the current public arguments. Read the actual source
at the candidate revision before using an old example. The November 2026 large
runner work was developed in PR #2662; a checkout predating that PR may lack the
required commands. An isolated integration candidate is a different tested SHA.

For a worker starting from an older checkout, fetch the runner branch read-only
(`git fetch origin codex/ci-large-runner-benchmark`) and read this skill using
`git show origin/codex/ci-large-runner-benchmark:docs/skills/atomic-do-ci/SKILL.md`.
Do not switch the user's checkout merely to obtain it. Prepare any required
integration in an owned worktree. Until the runner PR is merged, its new
`AGENTS.md` link is not present on older branches: a cloud worker needs the
skill/runner branch named in its handoff. A local installation under
`~/.codex/skills/atomic-do-ci` makes this skill discoverable on that Codex host,
not automatically on every remote host.

The orchestration host needs Python, Git, doctl, SSH/SCP and access to the owned
checkout. Docker and the pinned Dagger CLI are installed/verified on the remote
VMs; local Docker/Dagger are needed only for local validation/reproduction.
Verify the selected account identity.
Use explicit doctl contexts and expected account UUIDs, including with two
accounts; never change the user's global active context as a convenience.
Inspect current quota, regional size availability and actual prices through the
runner's plan. A listed 64-vCPU size is not a guarantee of regional capacity.
The working November 24 size was `g5-64vcpu-128gb-80gb` in `atl1`; that observation
is not a permanent sizing or price guarantee.

No plaintext tokens, private SSH keys or credential configuration belong in the
checkout, a report or a PR. The local doctl credential file is normally under
`~/Library/Application Support/doctl/` on macOS; Linux commonly uses
`~/.config/doctl/config.yaml` (or its configured XDG path). Pass an absolute
`doctl_config` explicitly: the cold runner's legacy default is macOS-specific.
Remote workers need their own
authorized access; this document does not transfer credentials to them.

## Pin, configure and plan

Use a clean task-owned worktree and full 40-character commit SHA. Preserve the
user's checkout and other workers' files/services. Put configuration, credentials,
logs and runtime ledgers outside the checkout. Start with the user's requested
profile; do not infer a larger paid fleet from available quota.

Example cold-fleet configuration (replace identities and paths):

```json
{
  "batch_key": "unique-run-key",
  "source_commit": "FULL_40_CHARACTER_SHA",
  "worktree": "/absolute/owned/atomic-server",
  "runtime_dir": "/absolute/private/runs/unique-run-key",
  "doctl_config": "/absolute/private/doctl/config.yaml",
  "accounts": [{"context": "chosen-context", "expected_uuid": "ACCOUNT_UUID", "nodes": 3}],
  "region": "atl1",
  "size": "g5-64vcpu-128gb-80gb",
  "expected_hourly_rate": 2.32022,
  "max_hours": 2,
  "build_jobs": 64,
  "rust_test_threads": 48,
  "workers": 8,
  "retries": 1,
  "cache_namespace": "chosen-stable-cache-namespace",
  "test_run_key": "unique-run-key"
}
```

The rate above is a historical example; use the actual planned rate. `workers`
is the browser width per shard/server. `retries` is 0 or 1 final retry round, not
an additional immediate retry budget. A fresh `test_run_key` changes test
execution after reusable build/setup. Preserve a stable `cache_namespace` when
deliberately restoring the same engine's compilation caches. A different
namespace can make a warm snapshot appear cold.

Optional `absolute_deadline` must be a timezone-aware ISO timestamp. Both cold
and warm runners clip their window to that deadline; an expired value rejects
planning before provider access. Retries do not extend it.

```sh
python3 scripts/ci-fanout.py --config /absolute/private/batch.json plan
python3 scripts/ci-fanout.py --config /absolute/private/batch.json run
python3 scripts/ci-fanout.py --config /absolute/private/batch.json status
python3 scripts/ci-fanout.py --config /absolute/private/batch.json cleanup
```

`plan` performs read-only checks; `run` creates paid resources. These commands
do not dispatch GitHub Actions. General feature work still follows the normal
shared-CI ownership rules; an explicit user request for DO validation is its
own scope, not permission to dispatch unrelated shared runs.

## Existing volume snapshots

A DO **volume snapshot** is not a Droplet boot image. Boot a normal compatible
Linux VM, clone a writable volume from the snapshot, attach/mount it and point
Docker's data root at its restored Docker/Dagger state. Each VM needs its own
writable clone; never mount one writable engine directory into multiple engines.
Do not reformat a restored filesystem. Stop/quiesce Docker before capturing a
new source snapshot; snapshot creation/retention must be within the user's scope.

The reusable warm runner is `scripts/ci-fanout-warm.py`; read its current config
schema and run `plan` before `run`. It uses the same CI controller and adds volume
ownership, attachment and cleanup. Supply the existing snapshot's exact ID/name,
account context and region, current volume price, finite deadline and total
budget. Snapshot metadata and source volume minimum size must match before any
paid creation. The November benchmark used one 34.3165-GiB snapshot with a minimum
200-GiB restored volume, cloned once per VM. It contained the builder's caches,
not every separate check worker's caches.

Extend the cold JSON with these explicit warm-run fields (historical rates shown;
verify them for the requested run):

```json
{
  "authorization": "The actual current user request authorizing this run",
  "source_snapshot_id": "EXACT_EXISTING_VOLUME_SNAPSHOT_ID",
  "source_snapshot_name": "EXACT_EXISTING_VOLUME_SNAPSHOT_NAME",
  "expected_volume_hourly_rate": 0.03,
  "max_total_usd": 15
}
```

The example total covers three machines at the historical $2.32022/hour plus
three 200-GiB volumes at $0.03/hour for a two-hour maximum. Set the actual
authorized amount; the string records authorization and does not grant it.
`max_total_usd` is a planning guard for compute and temporary clones at those
rates, not an invoice cap; retained snapshot storage, egress and tax are separate.
Volume metadata does not supply a live hourly price, so verify and explicitly
supply that rate rather than treating the historical example as current pricing.
For two accounts, replace the snapshot shorthand with
`source_snapshots: {"context": {"id": "…", "name": "…"}, "other": {"id": "…", "name": "…"}}`.
Each snapshot belongs to its own account; do not assume one account can read
another account's snapshot. Optional `absolute_deadline` caps a continued
campaign; neither retry nor restart extends the immutable state deadline.

```sh
python3 scripts/ci-fanout-warm.py --config /absolute/private/warm-batch.json plan
python3 scripts/ci-fanout-warm.py --config /absolute/private/warm-batch.json run
python3 scripts/ci-fanout-warm.py --config /absolute/private/warm-batch.json status
python3 scripts/ci-fanout-warm.py --config /absolute/private/warm-batch.json cleanup
```

Keep a companion metadata JSON beside every deliberately retained snapshot's
operator handoff. It must include account context/expected UUID, snapshot
ID/name/type/region/minimum restored size, creation time, source SHA,
`cache_namespace`, architecture, Dagger engine version and Docker data-root
layout. DO listings cannot tell a worker the seeded namespace or layout.
The November 24 seed was named `bench64-20261124t153851z-builder-cache`, used
`cache_namespace: atomic-bench64-seed`, linux/amd64, Dagger 0.21.7 and Docker's
data root `/mnt/atomic-ci/docker`; it came from source
`b9d8fd70d900635fa2e85f344b49323be8a59435`. Account identifiers and the current
snapshot ID remain in the private handoff; verify the selected snapshot through
the API rather than assuming a same-name result is unique. Obtain missing
companion metadata before claiming a warm-cache reproduction.

The reusable warm wrapper has fake-provider coverage but has not yet completed
a real warm smoke/full run. Its public scheduler differs from the old private
benchmark's precreate-all scheduler; the historical 26m36s is not acceptance or
a timing guarantee for the new wrapper.

The old private November 24 benchmark wrapper has expired hardcoded deadlines
and account-specific restrictions. It is historical evidence, not a reusable
launcher. Use the repository script. Source snapshots are retained/read only;
temporary clone volumes and owned VMs/keys are deleted when the run ends.
Persist ownership before creation, reconcile unknown API outcomes and verify
actual absence after deletion. Never delete an attached, ambiguous or foreign
volume just because its name looks similar.

## What is cached and shared

- Cargo registry/git downloads and separate native/checks/slim/WASM target
  volumes, plus pnpm downloads and reusable Dagger setup layers.
- Completed same-source bundles with build receipts and completion markers.
  Current manifest ABI 2 hashes the server binary, client OCI, complete checks
  OCI and full browser inventory. Missing/corrupt/old artifacts cannot stand in
  for matching completed builds.
- One builder prepares the E2E client and a complete production-mode Node
  checks image in the same invocation, sharing their WASM build graph. Unit
  tests, typechecks and TypeDoc import that checks image. JS integration reuses
  its WASM while retaining its separate glibc debug server and minimal layout.

The E2E client is intentionally incomplete for unit/type checks, and its build
flags differ. Do not substitute it for the complete checks image. Native Rust
and WebAssembly outputs are separate targets. The current Rust pipeline touches
workspace sources before Cargo to prevent stale cross-branch target artifacts;
this deliberately recompiles workspace crates such as `atomic_lib` whenever that
build step runs, while registry dependencies remain cached. A completed bundle
cache hit skips the bundle's build instead. Safer reuse of unchanged workspace
crates is a remaining optimization; do not remove the timestamp guard blindly.
The original failures and fixes are traced in
[cargo-cache-history.md](cargo-cache-history.md).

## Optional laptop backup

Large build artifacts are shared directly between DO machines after manifest and
source validation. Laptop backup is disabled by default (`host_bundle_backup:
false`), so a slow home connection cannot block check or browser execution.
Existing completed host archives can still be restored. When explicitly enabled,
the backup runs in the background with a 120-second budget clipped to the
campaign deadline. Cleanup cancels and joins it, kills its local transfer process
group and discards partial files. IO/timeouts are reported as backup failures;
invalid source/manifest/receipt proof remains fatal. Only a fully validated
archive is eligible for reuse.

The temporary builder's cache disappears when its VM is deleted unless it is
explicitly preserved in authorized DO storage. Persistent Spaces or snapshot
storage has its own retention/cost scope; never silently keep a paid VM to retain
a build. The current runner does not provide a Spaces archive backend.

## DO-hosted control and retained build volume

`scripts/ci-fanout-cloud-launch.py` runs the pinned cold or warm controller on a
small temporary DO machine. This is additional control compute, included in the
run budget; the requested node count still describes the test fleet. The same
explicit account UUID, clean source SHA, test key and all ten checks/full browser
inventory apply. Prepare and publish the scripts before pinning the candidate.

Extend the ordinary configuration with explicit `cloud_controller_size`,
`expected_controller_hourly_rate`, `cloud_volume_name`, `cloud_volume_gib: 10`,
`expected_volume_hourly_rate` and `max_total_usd`. For reuse, also supply the exact
`cloud_volume_id`; never adopt an arbitrary same-name volume. Use live provider
prices and a region supporting the controller, workers and volume. The planning
bound includes control compute, test compute, volume time and cleanup reserve.
The retained volume's continuing storage charge is intentional and separate
from a completed run's compute cost. The November 2026 standard rate was
[$0.10/GiB/month](https://docs.digitalocean.com/products/volumes/details/pricing/),
so 10 GiB is about $1/month; verify before a later authorization.

```sh
python3 scripts/ci-fanout-cloud-launch.py --config /absolute/private/cloud.json plan
python3 scripts/ci-fanout-cloud-launch.py --config /absolute/private/cloud.json launch
python3 scripts/ci-fanout-cloud-launch.py --config /absolute/private/cloud.json status
python3 scripts/ci-fanout-cloud-launch.py --config /absolute/private/cloud.json collect
python3 scripts/ci-fanout-cloud-launch.py --config /absolute/private/cloud.json finalize
```

The one-hour clock starts with the first controller creation request, before
its installation and source checkout. Cloud-init installs separate supervisor
and reaper units before bootstrap work; monitoring SSH is optional after launch.
The reaper does not depend on installing doctl, Git or Dagger. It enforces the
same absolute deadline, verifies resource identity before deletion and retries
provider cleanup failures. A systemd cgroup kill cannot take out the independent
reaper together with the test controller.

The regional disk must match its recorded ID, name, size and attachment. Mount
its existing ext4 filesystem; never format an existing cache volume. The build
archive uses original successful build receipts, manifest ABI 2 and payload
hashes. A partial, mismatched or corrupt copy cannot bypass building. Cache
validation is distinct from fresh test execution. A failed archive operation
must be reported even if application tests pass: successful CI alone does not
prove that the requested build was preserved.

Keep selected-account credentials, operator private keys, source and the live
runtime on the temporary controller's boot disk. The retained disk receives
only allowlisted reports/state/logs plus validated build archives, with original
and persistent paths recorded. Do not persist `doctl.yaml`, private keys,
cloud-init user data or symlinks. Launcher user data is sensitive even though it
is outside Git; never print it. The launcher needs PyYAML to select only the
requested context from a local YAML doctl config; the remote supervisor uses
stdlib Python and JSON credentials.

After successful test-fleet cleanup, the small controller remains available
until `finalize` or the original deadline so reports can be collected. If the
laptop is unavailable, evidence and the build remain on the retained disk after
the controller deletes itself. Recover by explicitly attaching that recorded
volume to another authorized controller in the same region; do not create an
untracked second test fleet. Independently verify worker/controller/key absence
and retain only the authorized build volume plus any pre-existing intended
snapshot. Record ongoing volume storage, controller lifetime and test-machine
lifetimes separately. Fetching reports must not download the multi-GB cache.

## Monitor, interpret and clean up

Keep the controller alive and the laptop awake if it owns orchestration; an
awake assertion does not guarantee operation with the lid closed. Preserve logs
and state outside the checkout. On interruption, use the same ledger/deadline;
do not start an untracked second fleet. Existing watchdogs and bounded cleanup
must remain effective if a test, transport, backup or controller fails.

Require all ten check jobs and an exact disjoint union of the full browser
inventory. Global errors, interrupted/unrun cases and malformed/foreign receipts
cannot become passes. Only actual completed ordinary failures enter the final
round; first-pass successes, intentional skips and expected-failure cases are
not rerun. A recovered case remains flaky in `browser-merged.json`. Read raw
reports under `node-*/results/browser` and `browser-retry` for traces and errors.

CI wall time is `validation_completed_at - first_creation_at`; cleanup ends at
independently verified deletion, including clone volumes. Report its additional
duration separately. The older `ci_elapsed_seconds` state field is computed
during cleanup and can include cleanup; do not use it as CI-only duration.
Sum each VM's actual lifetime times its
actual hourly rate, respecting provider billing minima. Add temporary volumes
separately, and identify intentionally retained snapshot storage as recurring.
Artifact traffic can use the account's pooled transfer allowance; do not confuse
an upper-bound unpooled estimate with an invoice. Independently re-list the
selected account's owned VMs, volumes and keys before claiming cleanup complete.

Do not rerun an entire suite merely to make the last result green. Diagnose
failures, preserve failed evidence, file/reuse issues for flakes, and validate any
changed integration candidate under its own SHA. Shared snapshots accelerate
setup but never certify tests for a new commit.

These runners execute the ten public Atomic Server checks and complete browser
inventory. Empty `NETLIFY_TOKEN` skips preview uploads while still building docs.
Private downstream SaaS checks and deployment are separate gates. Report this
scope explicitly; a public DO pass is not evidence that those other gates ran.


## Autonomous snapshot-backed workers

Set `cloud_worker_mode: "warm"` to run the public warm wrapper from the DO
controller. `region` is the worker/snapshot region; `cloud_controller_region`
is the retained disk/controller region. Each worker gets its own disposable
200-GiB writable clone. The retained 10-GiB artifact disk stays separate and
requires its explicit `cloud_volume_id`; no new recurring storage is created.
Cold remains the default and rejects warm settings rather than ignoring them.

Provide `source_snapshots` keyed by the selected account context. Each value
must contain the snapshot `id`, `name`, `cache_namespace`,
`dagger_engine_version`, `architecture: "linux/amd64"` and
`docker_data_root: "/mnt/atomic-ci/docker"`. The read-only plan checks the
snapshot type, account, available region/minimum size and the candidate's pinned
Dagger version. Never infer the cache namespace from provider metadata.

`expected_volume_hourly_rate` prices the retained controller disk;
`expected_cache_volume_hourly_rate` prices **each** temporary clone. The cloud
budget includes all three clones, three test VMs, controller compute, retained
disk time, cleanup and egress reserve. At the historical November rates, a
55-minute work window (`max_hours: 0.9166666666666666`) plus two minutes of
cleanup and $0.15 egress reserve bounds that estimate below $6.90. Verify actual
prices and regional availability before launching; this example grants no
spending authorization. Neither retries nor restart reset the original deadline.

`cache-startup.json` records nonempty engine cache state before Docker starts,
then verifies the restored filesystem/mount, Docker data root, pinned engine
image and configured namespace before the first Dagger call. It explicitly does
not claim a particular build was a cache hit. A builder-only snapshot may leave
Rust-test and Clippy jobs largely cold. Cargo's source freshness guard remains.

The independent stdlib reaper consumes the public warm driver's ownership
ledger under its shared lock. It deletes only proven temporary clone IDs after
worker deletion/detachment, reconciles lost provider responses, preserves the
source snapshot and retained disk, and verifies clone absence before deleting
the controller. Warm ownership/startup tests are fake-provider tests; a real
restored-engine/full-CI run is a separate acceptance gate.
