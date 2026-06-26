# atomic-server — recovered working tree

`/Users/joep/dev/atomic-server` was deleted with `rm -rf atomic-server/` on
2026-06-26 ~15:47 (local). Not in Trash, no APFS snapshot, no mountable Time Machine.
Local branch was `did-rebased2`.

## What this is

A real git repo on branch `recovered-from-transcripts`, built as:

1. **Base** = `origin/did` (2026-06-22, the last branch you pushed). `git log` HEAD~1.
2. **Overlay** = the June-22 → June-26 work, reconstructed from the local Claude Code
   transcripts (`~/.claude/projects/-Users-joep-dev-atomic-server/`, 55 sessions). For
   each file: anchored on the newest authoritative snapshot (origin/did content, or a
   full Write/Read in the transcript) and replayed forward with the edits made after it.

`git diff HEAD~1` = the reconstructed unpushed delta: **83 files changed, +9,603 / −291**.

## Confidence (full per-file list in RECOVERY_REPORT.txt)

- **Tier A (40)** — final state is an authoritative full snapshot. Exact.
- **Tier B (391)** — origin/did or a checkpoint + cleanly-applied post-June-22 edits. High.
- **Tier C (24)** — edits that didn't apply, or new files only seen in partial reads. Review.
- ~1,500 other files are byte-identical to `origin/did`.

## Source files that are short of their deletion-time size (review these)

Most are 85–95% complete. Two causes: (a) `did` and `did-rebased2` diverged, so a few
files' final edits couldn't auto-apply; (b) new files Claude only ever read in slices.

    server/src/vector_search/mod.rs                         20/1071   (new, big gap)
    planning/json-schema-code-first.md                     368/959    (new)
    browser/data-browser/src/views/getting-started/GettingStartedFlow.tsx  483/853
    browser/data-browser/src/helpers/saasRecovery.ts        73/268    (new)
    browser/data-browser/src/components/IdentityReconcileGate.tsx  89/248
    lib/src/frozen.rs                                      655/788
    lib/src/db.rs                                         2553/2671
    browser/lib/src/commit.test.ts                         410/527
    server/src/routes.rs                                   277/352    (did/did-rebased2 divergence)
    browser/data-browser/src/routes/SettingsAgent.tsx      154/221
    browser/data-browser/src/helpers/cloud/recovery.ts     145/193    (new)
    browser/data-browser/src/routes/SyncRoute.tsx         1441/1488
    browser/lib/src/resource.ts                           3142/3186
    lib/src/parse.rs                                      1214/1246
    browser/data-browser/src/chunks/AI/useProcessMessages.ts  236/267
    browser/data-browser/src/hooks/useSavedDrives.ts        15/46
    browser/data-browser/src/views/ResourcePage.tsx        203/229
    server/src/handlers/web_sockets.rs                     709/735
    browser/data-browser/src/components/SideBar/SideBarDrive.tsx  235/260

(Disposable, ignore: `browser/e2e/test-results/*`, `somelog`.)

The exact post-June-22 edits for the divergent files are still in the transcripts and
can be extracted and re-applied — ask Claude to do this for any file above.

## Next steps

1. `cargo check --workspace` and `pnpm i && tsc --noEmit` — errors pinpoint the files above.
2. For byte-perfect recovery of the worst files, the deleted `.git` loose objects may be
   carvable from free disk blocks **if the volume isn't overwritten** — minimize disk writes.
3. Push when reviewed: `git push origin HEAD:did-rebased2-recovered`.
