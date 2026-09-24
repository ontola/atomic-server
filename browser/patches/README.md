# pnpm patches

Every file here is applied by `patchedDependencies` in `../pnpm-workspace.yaml`.
A patch is a liability: it pins the exact version it was made for, silently
stops applying on a bump, and hides a bug the upstream project does not know
about. Each entry below says why the patch exists and what has to happen for
it to go away. When you add one, add it here and open an upstream issue or PR.

## loro-prosemirror@0.4.3.patch

Added in #1488. Changes to the ProseMirror ↔ Loro binding:

- Restore the selection in the same transaction as a remote update instead
  of from a `setTimeout`, which could overwrite a newer local cursor.
- Preserve explicit pending formatting at an empty selection across imports;
  otherwise a sync receipt between toggling bold and typing clears the toggle.
- Apply a single inline `ReplaceStep` straight to the existing `LoroText`
  instead of reconciling the whole tree, so typing stays fast in paragraphs
  with a long formatting history.
- Cache `toDelta()` per reconciliation pass.

Upstream: [loro-dev/loro-prosemirror#85](https://github.com/loro-dev/loro-prosemirror/pull/85)
and [#86](https://github.com/loro-dev/loro-prosemirror/pull/86). Upstream 0.4.4
already contains the "only emit changed style ops" part, so do not bump past
0.4.3 without rebasing the patch. Removal steps: [#1494](https://github.com/ontola/atomic-server/issues/1494).

## @reactflow__core.patch

Added in #1382. Silences the spurious `error002` ("node types object changed")
warning that fires in development when the `nodeTypes` object is referentially
stable. Compare the reference before warning. No upstream PR; `@reactflow/core`
is superseded by `@xyflow/react`, so the patch goes away with that migration.

## playwright-core@1.63.0.patch

Added in #1463. Disables the Chromium `PreventCrossWorldServiceWorkerResourceReuse`
feature, which confuses `null` and `MainWorld()` in service-worker preload
matching on Chromium 153 and breaks E2E runs. Remove once the browser Playwright
bundles includes `chromium/chromium@4df9ee2790a4`.
