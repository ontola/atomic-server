# Plugin PR stack: rebase onto develop for trekmeester

Goal (agreed with Joep, 2026-09-28): keep developing the plugin features, as
long as no existing test or existing server behaviour breaks. New behaviour is
additive (v2 signatures are accepted alongside v1; v1 is not deprecated).

## Approach

The stack sat on `feat/plugin-debug` / `claude/atomic-signature-v2`, which
landed in develop via squashed batch #1699, so the PR branches were ~3900
commits away from develop. Rebase them as one **linear chain** on develop:
each PR's own commits are cherry-picked in order, each PR branch is reset to the
chain at that point, and each PR's base becomes the previous PR's branch. This
removes the merge commits between sibling PRs, which the chain makes redundant.

Old heads are kept as local refs `refs/backup/plugin-stack/<branch>` and in
`claude/atomic-plugins-pin` (not touched).

## Dropped (already in develop)

- `3f4add07a` v2 signatures (#1696), `d3fa5fed2` frame capabilities (#1697),
  `72fde507e`, `9788dbb41` accepts-file (#1691), `fb53a665a` (#1644).
- #1755 is identical to develop (landed as #1654): close with a pointer.

## Chain order

1786, 1724, 1730, 1705, 1702, 1710, 1725, 1731, 1729, 1733, 1744, 1745, 1748,
1750, 1768, 1774, 1836, 1788, 1726, 1732, 1742, 1769, 1749, 1751, 1752, 1756,
1789, 1754, 1757, 1775, 1759, 1760, 1763, 1764, 1831, 1832, 1833

Independent, rebased on develop on their own: 1830, 1835, 1842, 1834 (draft).

## Behaviour changes to make additive

- [ ] #1832: accept v1 as before on the ~45 routes; v2 verified when sent.
  Replay cache: record only after authorization, so it cannot be filled by
  throwaway keys (no global 429).
- [ ] #1705: its `resource.ts` fix is superseded by develop #1853/#1857; keep
  only what is new (rights-walk log, tests that still pass).
- [ ] #1788: unknown `x-atomic-signature-version` must not start 401ing requests
  that authenticated before.
- [ ] #1726: `/plugin-catalog` keeps returning a bare array to old clients.
- [ ] #1756 / #1789: `/.well-known/*` and `/_routes*` 404s only with the
  `plugin-routes` feature (or confirm same status as before).
- [ ] #1769: check the 409 remap does not change an existing response status.
- [ ] #1830: fix TS7016 on `build-website-runtime.mjs`.

## Findings from the #1744 session's triage (2026-09-28), to fold in

- [ ] #1832: clients keep v1 unless the call is plugin/app-only; restore
  it/iroh_pairing.rs and app_endpoints tests to prove v1 still passes.
  (pairing.ts, managedServer.ts, hostingClient.ts, forget-peer, iroh-sync,
  bind-drive: back to v1.)
- [ ] #1710: gate `publish_runtime` on the manifest declaring `proxy` (or
  `integrationConnections` set); also defuses most of #1836/#1833.
- [ ] #1836: short-circuit `paused()` queries when no `proxy` is declared.
- [ ] #1833: refuse only on `integrationAppAgent`, not on runtime children
  (synced-in Installation on a Legacy node would be refused).
- [ ] #1756: 404 only for GET/HEAD wanting HTML (what used to hit the SPA),
  so `/.well-known/did.json` resources and JSON GET/POST still resolve.
- [ ] #1769: `/plugin-catalog` release reads + remote fetches only with
  plugin routes compiled/enabled (or cached).
- [ ] #1759: use `request_host(req.head())`, not `connection_info().host()`,
  for signature host and consent redirect.
- [ ] #1768: validate `destination` on publish/ingest only, not in
  `Manifest::parse` of stored releases.
- [x] #1774: importFile.ts uses lib `acceptFor`/`readUpload` (done in chain).
- [ ] #1750: send `color-scheme` only to app frames, not legacy PluginView.
- [ ] #1763: EndpointHealth renders nothing on error unless release declares
  `http`.
- [ ] #1788 (draft): hold. row-grant writes with `validate_rights: false`;
  requestRowAccess 60 s timeout.
- [ ] #1835: hold the soft-launch UI changes; split out `driveHasServer` fix.
- [ ] #1834: `cargo bin wasm-pack` → `cargo run -q --package cargo-bin --
  wasm-pack` (after #1830).
- [ ] #1744: add openResource-asks-first commit 1545cab1a.
- [ ] #1871 (new, pairs with #1760): include.

## Progress (hand-off 2026-09-28, from Michiel's personal laptop session)

- [x] Chain built on develop 2e509a925 through #1832, on branch
  `claude/plugin-stack-chain` (this branch). Per-PR positions:
  `planning/plugin-stack-rebase/positions.txt`. Every Rust-touching step
  passed `cargo check -p atomic-server -p atomic_lib --tests`.
- [x] #1832 made additive on the server (v1/cookies/bearer pass through; full
  replay cache evicts instead of 429). `app_endpoints_test`, `replay_cache`,
  `require_v2` tests: 18 passed.
- [x] #1705 trimmed (tests + log level). #1769 code 11 -> 12. #1724 notice
  also added to InstallationConnections (resolves #1733's TODO).
- [ ] #1833 not picked yet (its `fb53a665a` is in develop; pick only
  `4df695145`, then apply the #1833 triage fix).
- [ ] #1744: add 1545cab1a (openResource asks first) — lives on
  origin/claude/frame-open-external until that branch is force-pushed.
- [ ] Triage fixes above, each folded into its PR's commit.
- [ ] `.po` catalogs: the merge only appended entries; run
  `pnpm clean-translations` (at least on the tip) and read the diff.
- [ ] JS not type-checked/linted yet on the chain: run `pnpm run -r lint`,
  data-browser `tsc --noEmit`, vitest (incl. #1705's resource.test.ts
  against develop's fix), then e2e light.
- [ ] Independent PRs: #1830 (TS7016), #1842 (SearchBox unhandled
  rejection), #1835 (split), #1834 (wasm-pack call). Close #1755, #1786
  (already in develop).
- [ ] Then force-push each `claude/...` PR branch to its chain position and
  retarget its base to the previous PR's branch (first one to develop).
  Old heads remain in `claude/atomic-plugins-pin`.

Tools used (resumable cherry-pick driver + conflict resolvers) are in
`planning/plugin-stack-rebase/`; paths inside them point at the old machine.
Drop this planning commit before pushing PR branches.
