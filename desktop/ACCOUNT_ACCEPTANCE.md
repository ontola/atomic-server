# Mac account handoff acceptance

This is the local, real-object-storage setup for checking an existing Atomic
Place account in the Mac app and a Mac-created workspace in a later account.
Use throwaway accounts and canary documents. The stack is isolated from normal
developer ports and retains its database and bucket between runs.

## Start the services

The scripts expect the sibling `../atomic-saas` checkout, its existing debug
binary and portal dependencies, the AWS CLI, and at least 30 GiB free on the
acceptance build volume. They prefer the pinned MinIO macOS binary at
`/Volumes/AtomicMacAcceptance/bin/minio`; Docker with the existing pinned
image is a fallback. The launcher checks an actual S3 PUT/GET round trip and
both MinIO and API CORS preflights. It refuses to replace a process on any of
its ports.

This Mac's internal volume was almost full, while `/Volumes/SD Macbook` had
space but uses ExFAT. A task-specific 70 GiB APFS sparse image at
`/Volumes/SD Macbook/AtomicMacAcceptance.sparsebundle` holds the test data and
Rust build outputs. Mount it before using either script:

```sh
hdiutil attach '/Volumes/SD Macbook/AtomicMacAcceptance.sparsebundle' -nobrowse
df -h /Volumes/AtomicMacAcceptance
```

When that image is mounted, the scripts automatically use its `run/` and
`target/` directories. They do not move or delete any existing files on the SD
card. The MinIO binary is built from the official pinned Go release into the
image rather than installed system-wide.

```sh
cd browser/e2e
./scripts/mac-account-stack.sh start
./scripts/mac-account-stack.sh status
```

| Service | Address |
| --- | --- |
| MinIO S3 | `http://localhost:9101` |
| SaaS API | `http://localhost:3031` |
| Portal | `http://127.0.0.1:49238` |
| Native development frontend | `http://127.0.0.1:6751` |
| Source AtomicServer | `http://localhost:9891` |

The persistent test database, bucket data, logs, and process IDs live in
`/Volumes/AtomicMacAcceptance/run` when mounted. Start never clears them. Stop
only affects this stack's processes and container:

```sh
./scripts/mac-account-stack.sh stop
```

The source node uses `9891` because another isolated local server occupied
`9885` during setup. The browser Vault suite passed with this stack using:

```sh
cd browser/e2e
FRONTEND_URL=http://localhost:6751 SERVER_URL=http://localhost:9891 \
  ATOMIC_VAULT_PORTAL_URL=http://localhost:3031 \
  ./node_modules/.bin/playwright test --config=./playwright.config.ts \
  tests/vault-backup-restore.spec.ts --project=chromium --workers=1
```

Do not treat the API's healthy response as evidence that Vault works. Before
acceptance, the launcher must print `S3 PUT/GET and MinIO (3 origins)/API (2
origins) CORS preflights passed.` If startup fails, read the relevant log in the
run directory. The
launcher sets `ATOMIC_VAULT_REQUIRE_S3=1`, so the control plane cannot silently
fall back to synthetic `memory://` upload URLs.

## Existing production account in a Mac dev window

For an interactive check with an existing account, stop the local acceptance
stack above. Point the Tauri frontend at `https://atomicserver.eu` with
`VITE_MANAGED_PORTAL_URL` and at `https://atomicserver.eu/api` with
`VITE_MANAGED_API_BASE`. Use Vite on `localhost:6747` or `localhost:5173`:
the production API accepts those development origins, but rejected the local
acceptance port `6751` during this check. The frontend origin also separates
its WebView local storage from the local acceptance portal link. Confirm the
restore screen names `AtomicServer.eu` before requesting a device code.

Keep the embedded node separate from an installed app by setting
`ATOMIC_DATA_DIR`, `ATOMIC_CONFIG_DIR`, and `ATOMIC_CACHE_DIR` to a persistent
test directory before `cargo tauri dev`. A different Tauri bundle identifier
alone did not isolate the native server database. The WebView profile can still
retain a last-used drive from another run; a missing-resource page does not
prove account restore failed. Open `/app/welcome` and start the restore flow.

In a worktree whose `browser/node_modules` is symlinked outside the checkout,
Vite may return HTTP 403 for `loro_wasm_bg.wasm`. Give Vite's `server.fs.allow`
the symlink's real path, or install dependencies within that worktree. Verify
that the WASM request returns `application/wasm` and that the WebView console
has no `[LoroLoader]` initialization error before testing an edit.

This interactive dev check establishes only that the real portal can issue a
device code and that the user can continue the account flow. Complete the
packaged-app journeys below to establish Vault recovery and persistence.

## Build a packaged test app

Stop the development frontend first. A running Vite server and the production
build both write the translation catalogs in this checkout.

```sh
cd browser/e2e
./scripts/mac-account-stack.sh stop
cd ../..
./desktop/scripts/build-account-acceptance.sh
```

The script rebuilds the shared TypeScript packages, WASM and native frontend,
then packages `target/release/bundle/macos/Atomic Server Account Acceptance.app`
inside the mounted acceptance image with an ad-hoc signature. Its bundle ID is
`io.ontola.atomicserver.account-acceptance`; the baked-in account endpoints are
the isolated local portal and API above. It never edits the shipping Tauri
config or copies the app into `/Applications`. Restart the service stack before
running the app. The local API and object store must remain on this Mac because
their URLs are compiled into this particular package.

This local package enables the `account-acceptance` Cargo feature. It exposes
the diagnostic bridge on `127.0.0.1:9223` so the packaged WebView can be
inspected during acceptance; ordinary release builds omit the bridge. Only
run this package in the isolated test profile, and close it after testing.

First check the actual packaged window: the welcome and sign-in screens must
have their normal typography, spacing, and buttons; the Skip Navigation link
must be hidden until keyboard focus. An error-free window with plain browser
defaults is a failed CSS check. Confirm `http://localhost:9883/server` returns
`internal:/server`; Tauri stores workspace data in that embedded node, not OPFS.
If accessibility exposes the controls but the page is blank, inspect the
wrapper and step opacity: a backgrounded WebView can hold entry animations at
their first frame.

**Use a separate macOS test user for the installed app.** The debug run found
that changing a Tauri identifier alone did not isolate the default WKWebView
store at a shared development origin. A separate OS user gives the package a
fresh, persistent WebView and keychain profile without touching the regular
Atomic Server identity. Launch the built `.app` from the mounted APFS volume if
that user can read it; otherwise copy it to `/Users/Shared`. Use a fresh test
user or test Mac
for each direction if the profiles must start empty. The ad-hoc signature is
enough to check relaunching this same build; it does not prove Developer ID
update/keychain behavior.

## Acceptance journeys

Record the account email, agent and drive DIDs, a unique canary document title,
and the confirmed Vault object count. Keep recovery codes in the test user's
password manager; do not put them in logs, screenshots, or the repository.

1. **Account first.** At the local portal, create a test account. Create a
   workspace in the local development frontend. Keep its source node available
   for sign-in, but make the canary only on the originating client. In that
   browser's DevTools, after onboarding and before creating the canary, run:

   ```js
   const drive = window.store.getDrive();
   if (!drive) throw new Error('No selected drive');
   window.store.registerLocalOnlyDrive(drive);
   window.store.getDefaultWebSocket()?.close();
   ```

   This matches `vault-backup-restore.spec.ts`. Wait for a
   confirmed Cloud Vault object after a manual backup. Open the packaged app in
   a fresh macOS test user, link the same account, enter the recovery code, and
   restore the workspace. Check the same agent/drive IDs and the canary content;
   the canary was never sent to the source node, so it proves Vault restored it. Edit
   it, quit the app completely, relaunch, and check the edit persists.
2. **Mac first.** In another fresh test profile, create a Mac workspace and
   canary document. Create/link a local portal account. Wait for a confirmed
   Vault object, then open a fresh browser profile or second test Mac profile,
   sign in with the recovery code, restore, and compare the drive ID and canary
   contents. Check that the canary is absent before pressing Vault restore;
   if it is already visible, the source node may have served it and this run
   does not establish Vault recovery. Edit on that client, back up again, and
   confirm the next restore includes the edit.
3. **Negative checks.** A different account must not list or restore the
   drive. A signed-out relaunch must not silently use the linked account. The
   Sync page must distinguish a restored identity from missing workspace data.

The existing browser spec `browser/e2e/tests/vault-backup-restore.spec.ts` and
SaaS Rust test `src/vault_e2e.rs` exercise the S3 boundary without a native
WebView. Run them as additional checks; neither substitutes for the visible
packaged-app journeys above.

Native passkey acceptance needs a signed staging build and a configured
`webcredentials:` associated domain. This local `localhost` package tests
recovery-code sign-in and Vault transfer, not the production passkey domain or
Developer ID update path.
