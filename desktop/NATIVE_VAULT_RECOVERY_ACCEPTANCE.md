# Automatic native file recovery from real Vault storage

This acceptance uses the actual macOS Tauri app, the real Cloud Vault API
and a real S3-compatible object store. The API and storage run locally in
isolated processes; neither is intercepted or replaced by a mock. It is a
functional integration check, not a test of the production deployment.

The test app has bundled assets, a nonpersistent WebView, its own application
identifier, and fresh native data/config/cache directories. The account,
agent, drive and image are invented test data. There is no browser ClientDb
and no second peer with the image.

## Setup

Use the native build procedure in `NATIVE_FILE_RECOVERY_ACCEPTANCE.md`, with
the current native frontend and a separate test identity. Keep the diagnostic
bridge loopback-only and stop the test app afterward.

For the Vault side, use a current `atomic-saas` checkout paired with this
Atomic Server checkout. Build its portal and API normally. Run it from a
fresh runtime directory, with a fresh database and local-process node provider;
do not load a developer's existing environment or account database. Enable
development magic links and mock email delivery. These affect account setup,
not backup storage or recovery.

Configure a real S3 bucket, its actual credentials, a random pseudonym salt,
and `ATOMIC_VAULT_REQUIRE_S3=1`. Verify an authenticated PUT/GET round trip
before starting, and confirm the API reports an S3-compatible backend. Configure
native-origin CORS on the API and bucket. Never accept the API's in-memory
storage fallback for this test.

`desktop/scripts/native-vault-acceptance.mjs` creates a genuine account through
signup and magic-link login, then requests, approves and redeems the API's
normal device authorization. It stores the resulting credentials in an
exclusively created owner-only file. Its `inject` action installs that real
grant in the native app's supported session storage keys, guarded by the
expected selected drive. Reload normally afterward. This does not test the
native account-link user interface. Normal identity reconciliation then links
the native agent with a signed challenge.

Do not print cookies, bearer tokens, agent keys, drive keys or signed storage
URLs. The helper's `inspect` action reports account, enrollment and object
metadata without requesting or printing download URLs.

## Backup and controlled loss

1. Sign into the isolated native app through its normal agent-key sign-in.
   Create a fresh drive and upload a unique image through `store.uploadFiles`,
   which uses the actual signed native multipart upload. Keep the exact source
   bytes outside the database for comparison.
2. Enable Cloud Vault or use its ordinary **Back up now** action. Wait for a
   confirmed backup. Check the real API's object ledger and independently read
   the actual S3 blob object. The blob must be ciphertext, with the expected
   sealing overhead, and must not contain the image's plaintext.
3. Record the file's current metadata and add a newer saved description as a
   sentinel. Keep the app's current drive state; do not restore a snapshot.
4. Close the native app. In its own `target/native-vault-acceptance/native-data`
   directory, write `NATIVE_VAULT_ACCEPTANCE_ONLY` containing the exact fixture:

   ```json
   {"purpose":"native-vault-acceptance","hash":"<hex>","drive":"<drive>","file":"<file>"}
   ```

5. Build `lib/examples/native_vault_remove_blob.rs` with the native database
   features and run its `remove DATA_DIR HASH DRIVE` command. It refuses other
   directories, a mismatched marker, an open database or unrelated blobs. It
   verifies the invented contents, deletes only that blob through the backend,
   and checks all resource rows, complete Loro snapshots and signed envelopes
   remain byte-identical. Retain its fingerprint result.

## Automatic recovery assertions

Relaunch the same isolated native node. Sign into the same agent and restore
its genuine device grant. Before opening the file, confirm native blob
presence is false and the local download returns 404. Check the actual peer
inventory is empty.

Observe the normal recovery service, native IPC calls, stored-file events and
network response metadata. A transparent observer must return each original
request/promise unchanged; never supply file bytes, synthesize a stored-file
event, or substitute a recovery result. Omit keys, authorization and URL query
strings from recorded evidence.

Open the ordinary file view and leave it open. Assert:

- A peer-first attempt cannot supply the file, followed by real Vault object
  listing, signed S3 download, local decryption and native persistence.
- The preview renders automatically without a recovery button, navigation,
  page reload or full-drive restore.
- Native download bytes exactly match the original image.
- The same resource object, materialized values, current description and Loro
  version remain unchanged, and no `vault_import` call occurs.
- After closing the app, `inspect DATA_DIR HASH DRIVE` confirms the recovered
  blob and identical persisted drive resources, full snapshots and envelopes.

Capture loading/recovered native screenshots outside Git. Native screenshot capture can finish after recovery; inspect the actual image before labeling it. Stop only the test-owned
app, API and storage processes. Preserve reports and compare the original
checkouts with their recorded baseline.

## Recorded run

Passed twice on 2026-11-18 with the native export and serialized backup changes
in this PR, based on Atomic Server `344fe5fd9`. The actual API was built from
`atomic-saas` `32b5a7e`; storage was the official SHA256-verified MinIO
`RELEASE.2025-09-07T16-13-09Z` macOS arm64 binary. Both services ran locally,
with a real account, agent link, device grant, bucket and signed S3 URLs.
No Vault responses, ciphertext or file-arrival events were fabricated.

The app made the backup itself. Its unique 490-byte SVG was stored as a
536-byte sealed blob, independently retrieved from S3. It contained no image
plaintext, and its object key contained no plain content hash. The API confirmed
one history checkpoint and one blob before loss. A normal background backup
could also upload a new history pack while the local file was absent without
removing the existing encrypted blob.

The native app was stopped before each deliberate loss. The guarded fixture
removed only the image bytes. Before opening it after relaunch, native presence
was false, the native download returned 404 and the server reported no peers.
The file view alone triggered the automatic recovery.

| Observation | First run | Repeat in a fresh WebView |
| --- | --- | --- |
| Automatic recovery completed | 5,440 ms | 5,908 ms |
| Actual image load event | Not timed | 6,092 ms after recovery started |
| Peer requests / S3 blob downloads | 1 / 1 | 1 / 1 |
| Native blob restore / history import | 1 / 0 | 1 / 0 |
| Recovered bytes | Exact original 490 bytes | Exact original 490 bytes |
| Preview | 640 × 360, automatically refreshed | 640 × 360, automatically refreshed |
| Open resource and all 10 values | Unchanged | Unchanged |
| Current Loro version and newer description | Unchanged | Unchanged |
| Navigation/reload after opening | None | None |

The first run's raw Resources projection shrank by 159 bytes during the
restart/sync-hydration interval; its complete Loro snapshots and signed envelopes
were byte-identical. That size precisely matches the captured derived
`lastCommit` entry. Ordinary `ws_apply` hydration can rebuild cached properties
from Loro, excluding this derived field; reads reconstruct it from retained
envelopes. The original raw row was not retained, so the precise field removal
is an inference from the size and code rather than a direct before/after diff.

The repeat started with the normalized cache. Comparing the offline pre-removal
and post-recovery fingerprints then confirmed byte-identical drive Resources
(3 rows, 4,085 bytes), full LoroSnapshots (3 rows, 5,835 bytes) and signed
Envelopes (3 rows, 900 bytes), with only the verified blob restored. The test
compared the actual before/after fingerprints; the fixture's single-operation
`metadataAndHistoryUnchanged` flag alone is not that cross-run assertion.

Native loading and recovered screenshots were captured outside Git. The repeat's
loading screenshot completed after the image-load event, but its captured pixels
show the loading view; it is not used to claim a pre-download capture timestamp.
The recovered screenshot visibly includes the newer description and image.
Private account/agent credentials, signed URL query strings and screenshots are
not committed.

Supporting checks passed: 12 native bridge tests, 2 native export/crypto/restore
tests (including a multi-chunk file), 20 file-backup tests including cross-drive
cache serialization, full app typecheck, native frontend build and the matching
native binary build. The operator helper itself was compiled with the matching
native dependency features. This is not an unattended test, a production Vault
endpoint test, an installed release-package check or a second physical-device
acceptance run.
