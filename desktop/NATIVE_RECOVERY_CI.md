# Unattended native file recovery

`scripts/native-recovery/run.mjs` runs both recovery cases in the actual Linux
Tauri app, using its bundled frontend and embedded database. Xvfb supplies the
display and DBus supplies the desktop session. No browser substitute, host
keychain, production account or production storage credentials are used.

Normal agent-key sign-in creates the WebView's real keys and adopts the agent
on the native node. Profiles, databases, runtime directories and credentials
are isolated. The suite does not replace WebCrypto or disable WebKit security.
Linux avoids the macOS login-keychain prompt associated with ad-hoc app builds;
these checks do not certify macOS keychain behavior or an installed release.

## The two cases

- **Late peer contents:** a separate real Iroh process serves a public fixture
  drive. Its backend holds only the invented file's read. The native app receives
  the metadata, opens the ordinary preview and reaches the normal 30-second
  recovery deadline. The test releases the read, then checks the real native
  stored-file event, exact native HTTP bytes and automatic image rendering while
  the same view remains open and the retry cooldown is active. Resource values
  and Loro versions must stay unchanged. A guarded offline fixture records local
  address hints; authentication and transfer use the normal Iroh engine without
  depending on public relay discovery.
- **Vault-only contents:** the real Cloud Vault API and MinIO run locally with
  fresh data and random storage credentials. Signup/device authorization and
  signed native-agent linking are genuine; development magic links and mock mail
  automate only account setup. The app uploads a unique image and backs it up.
  An independent authenticated S3 request verifies ciphertext. A guarded fixture
  deletes only the real local blob in the running test app. With no peers and a
  native download returning 404, opening the ordinary preview must perform one
  real S3 download and one native blob restore, render automatically and import
  no resource history. Exact bytes, current metadata, Loro versions and persisted
  drive snapshots/envelopes must survive unchanged.

The `native-recovery-tests` build feature enables the guarded fault-injection
fixture; it is absent from normal builds. The fixture pauses a requested native
restore after the real S3 download, before the normal decryption/storage code
runs. The runner hashes the actual resource, snapshot and envelope trees after
the ordinary file view has hydrated, then releases the restore and compares
those same trees. It also checks the persisted state after stopping the app.
No bytes, successful result or stored-file event are supplied by the fixture.
This measures recovery without confusing it with unrelated startup cache
normalization. Every file value, including `lastCommit`, must remain unchanged;
there are no warmups, ignored metadata fields or retry-until-success loops.

Missing dependencies, failed setup, timeout or missing evidence fail the suite;
neither case is silently skipped. Child processes are owned by the runner and
stopped in `finally`, including on failure.

## Run the CI environment locally

Use fresh, task-owned `atomic-server` and `atomic-saas` sibling checkouts. The
SaaS revision must match the server API; CI resolves a same-named open SaaS PR,
otherwise SaaS main, and records the exact revision. Do not mount an existing
user profile or environment file. From their parent directory:

```sh
docker build -f atomic-server/desktop/native-recovery.Dockerfile \
  -t atomic-native-recovery atomic-server
mkdir -p native-recovery-artifacts
docker run --rm --init --shm-size=1g \
  -v "$PWD:/code" -v "$PWD/native-recovery-artifacts:/artifacts" \
  atomic-native-recovery
```

The container builds matching JS, WASM, native app, peer/corruption fixtures and
the real API before running the cases. MinIO is built from the pinned upstream
release source; old binary download availability is not required. Container
ports are internal and do not replace services on the host.

The fixed offline corruption fixture lives under the checkout's ignored
`target/native-vault-acceptance/native-data`. Repeated runs preserve a previous
suite-owned directory under a new name and start fresh. An existing directory
without the suite's private ownership marker is left intact and requires a fresh
test volume. Each run writes its reports into a separate artifact directory.

## CI and evidence

`.github/workflows/native-recovery.yml` runs on a disposable hosted Linux runner,
called by Main for trusted pushes and dispatches. Private SaaS checkout access
is mandatory and unavailable to fork code. Main requires this job to succeed.
Shared run scheduling remains with trekmeester.

Only explicit sanitized JSON reports and native screenshots are uploaded from
`/artifacts`. Raw logs, agent config, device grants, storage credentials, signed
URL queries and native profiles stay in the private container runtime and are
never included in the uploaded directory. Failed-run private diagnostics are
available while the container is retained locally.

The earlier macOS operator runs remain documented in
`NATIVE_FILE_RECOVERY_ACCEPTANCE.md` and `NATIVE_VAULT_RECOVERY_ACCEPTANCE.md`.

## Local unattended verification

Two fresh Linux arm64 runs passed on 2026-11-19 with the same production
recovery code and the opt-in fixture. No desktop interaction was required.
The actual API source was `32b5a7e2a4abdc670762087de9ebcacce0c49661`.

| Check | First run | Fresh-profile repeat |
| --- | --- | --- |
| Real peer recovery deadline | 30,181 ms | 30,131 ms |
| Visible image after releasing the peer | 463 ms | 262 ms |
| Automatic Vault recovery | 6,339 ms | 6,539 ms |
| Plain / encrypted image bytes | 474 / 520 | 474 / 520 |
| Actual S3 GET / native restore / history imports | 1 / 1 / 0 | 1 / 1 / 0 |
| Exact restored bytes and same open view | Passed | Passed |
| All file values and Loro version unchanged | Passed | Passed |
| Exact drive Resources, snapshots and envelopes at restore boundary and shutdown | Passed | Passed |

The guard also rejected a request for another hash while leaving the original
blob intact. All child processes were stopped before each success report was
written. Native screenshots and sanitized JSON are retained outside Git.
This is local container verification; the hosted x86_64 CI job still needs to
run on the published commit through the shared CI scheduler.
