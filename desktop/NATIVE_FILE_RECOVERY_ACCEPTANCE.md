# Late file arrival in the native app

This is an operator-driven acceptance harness for the actual macOS Tauri
app and a second, real Iroh peer process. It exercises normal authenticated
sync, native blob persistence, the stored-file notification and the WebView's
HTTP image request. The fixture peer holds its file read until an explicit
release marker appears.

## Recorded run

Tested production code: `cc1497ebfd014183051cdaf59be538fe5290761c` on
2026-11-18. The app used its bundled native frontend at `tauri://localhost`,
a nonpersistent WebView and fresh node data/config/cache. The source peer ran
as a separate process on the same Mac. Its source drive and image were
invented test data.

| Observation | First run | Fresh-storage repeat |
| --- | --- | --- |
| Initial native blob presence | Absent; no browser ClientDb | Absent; no browser ClientDb |
| Real recovery deadline | 30,112 ms | 30,106 ms |
| Before peer release | Open file view; zero image dimensions | Open file view; zero image dimensions |
| Real native stored-file event | 662 ms after release | 243 ms after release |
| Native presence confirmed | 816 ms after release | 424 ms after release |
| Image rendered | Observed 1,222 ms after release | Observed 558 ms after release |
| Retry cooldown | Active when recovery succeeded | Active when recovery succeeded |
| Navigation/reload | None after opening the file | None after opening the file |
| File resource | Same object | Same object; all 12 property values unchanged |
| Downloaded contents | Exact source SVG bytes | Exact source SVG bytes |

The repeat compared sorted `resource.getEntries()` values before and after
arrival. The dynamic `resource.props` accessor does not enumerate its values
when serialized and is unsuitable for that assertion.

The image URL acquired `_atomic_file_recovery=1`, causing a fresh local
download after the earlier failed request. The ordinary file preview can
replace its image element during loading; the acceptance criterion is that
the file view stays open and refreshes automatically.

Before/after native screenshots and timing evidence were captured outside
Git and shared in the PR's chat. These runs cover a debug native app with
bundled assets and the diagnostic bridge. They do not certify an installed
release package, a second physical device or passkey/keychain upgrade behavior.

## Isolated setup

Use a task-owned checkout with built `@tomic/lib`, `@tomic/react`, WASM and
native frontend assets. Follow the normal repository build instructions.
The diagnostic helper requires Node 26 or later.

1. Choose unused ports for the embedded server (`9883` in this run), native
   diagnostic bridge (`9223`) and a controlled loopback portal. Keep any
   existing app and services running on their own ports and profiles.
2. Build the native app with a test-only `TAURI_CONFIG` overlay. Give it a
   unique `productName` and `identifier`, set `app.withGlobalTauri` to `true`,
   and use a `main` window with `incognito: true`. Point
   `build.frontendDist` at this checkout's current native frontend bundle
   and set `build.devUrl` to `null`. Keep this overlay in an ignored test
   directory; do not change the shipping Tauri configuration.
3. Build with `cargo build --locked -p atomic-server-tauri`. For the warm
   local cache used here, `CARGO_PROFILE_DEV_DEBUG=0` and
   `ATOMICSERVER_SKIP_JS_BUILD=true` reused the already built frontend.
4. Launch the resulting native binary with fresh, absolute
   `ATOMIC_DATA_DIR`, `ATOMIC_CONFIG_DIR` and `ATOMIC_CACHE_DIR` paths,
   `--initialize --port 9883 --domain localhost --ip 127.0.0.1` and
   `ATOMIC_HOST_MODE=open`. Capture logs in the ignored test directory.
   Sign in through the normal UI with this disposable node's new agent key
   from its own config. Keep that test key out of screenshots and logs.
5. Start the controlled portal in another owned process:

   ```sh
   node desktop/scripts/native-late-file-acceptance.mjs portal 49238 60000
   ```

   Use a different unused portal port if necessary. Its control endpoint
   `POST /__acceptance/mode` accepts `{ "mode": "signed-out" }` while
   signing in and `{ "mode": "hold", "holdMs": 60000 }` for the file test.
   Set the supported runtime override in the native page to that origin:
   `window.__ATOMIC_MANAGED__ = { portalUrl: 'http://127.0.0.1:49238' }`.
   The held real `/api/me` request lets the automatic recovery reach its full
   30-second deadline, including the five-second peer opportunity.

The bridge is a local diagnostic facility. Close this test app when done.
The nonpersistent WebView and separate node directories isolate its identity
and data from the installed app.

## Real peer and native preview

Build and start the source fixture with a directory that does not exist yet:

```sh
CARGO_PROFILE_DEV_DEBUG=0 ATOMICSERVER_SKIP_JS_BUILD=true \
  cargo build --locked -p atomic_lib --features iroh,db-redb \
  --example native_late_file_peer
target/debug/examples/native_late_file_peer \
  /absolute/owned/test-run/source http://localhost:9883
```

The source creates `ready.json`, `events.jsonl`, its database and an image.
Read the public `nodeId`, `drive`, `file` and `hash` fields from `ready.json`.
Its normal `BlobBackend` waits for the named `releaseFile` only when the
requested file contents are read. Metadata sync remains available. The
production Iroh peer engine performs authentication and sends the actual
blob response after release.

Use `NativeBridge` from `desktop/scripts/native-late-file-acceptance.mjs`
to call the real native `fetch_workspace` command with `{ drive, nodeId }`.
`bridge.launch(key, script)` starts a long operation and `bridge.poll(key)`
observes it without the diagnostic bridge's five-second evaluation timeout.
The native `/app/dev-drive` shortcut is unsuitable here because native
storage deliberately has no browser ClientDb.

After the native file inventory contains the fixture hash:

1. Confirm `vault_blob_present({ hash })` is false.
2. Observe the real `store.recoverMissingFileContents` calls. A transparent
   recorder may attach timing handlers while returning each original
   promise unchanged. Listen for `atomic-file-content-stored` to record the
   real native event. Do not emit that event or insert bytes in the native
   node from the harness.
3. Open the ordinary `/app/show?subject=<encoded file>` route. Record its URL,
   page lifetime, resource object/properties and recovery start time. Keep
   the file view open.
4. Wait for the actual request to finish after at least 30 seconds with
   `present: false`, confirm native presence remains false and record the
   image's failed/zero natural dimensions. Capture the native window with
   `bridge.screenshot(path)`.
5. Create only the source fixture's `releaseFile`. Do this within the
   60-second failure cooldown and the sync protocol's five-minute pending
   blob-request lifetime. The source log must show a held read followed by
   its release. The native app then receives, verifies and persists the
   response through its normal Iroh path.
6. Poll the existing view until the real stored-file event is observed,
   native presence is true and the image has natural dimensions
   `240 × 160`. Verify a refreshed local URL, unchanged view/resource and
   exact downloaded bytes. Capture the native window again.

The helper's CLI also supports `eval <script-file>`,
`launch <key> <script-file>`, `status <key>`, `poll <key>` and
`screenshot <output-file>`. It is an operator harness, not a self-running
test that signs into arbitrary native profiles.

Stop only the source, portal and app processes started for this run. Retain
the evidence in the owned test directory. Screenshots, node keys, databases
and runtime configuration do not belong in Git.

For automatic fallback with no source peer, see
[`NATIVE_VAULT_RECOVERY_ACCEPTANCE.md`](NATIVE_VAULT_RECOVERY_ACCEPTANCE.md),
which records the actual native app against real Vault API and S3 storage.
