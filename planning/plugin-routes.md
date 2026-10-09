# Plugin routes (gates, manifest v3, registry)

## Status

In progress. Gates (#1711), manifest v3 `http` block (#1712) and the route
registry with mounts and reserved paths (#1714) are done. Serving a request
with plugin code is not. Design:
`docs/design/server-plugin-routes.md` in atomic-plugins (sections 0, 1, 2.2,
2.3, 2.9; decisions D1, D9, D12). User docs: `docs/src/plugins/creating-plugins.md`
and `docs/src/atomicserver/installation.md`.

## Done

- [x] `plugin-routes` Cargo feature (not in `default`, `light`, release sets; tested), `--plugin-routes`, `--routes-origin`, listeners, sidecars, startup refusals, catalog `hostFeatures`, CI feature pass.
- [x] Manifest v3 `http` block, validation, gate level, derived `requires`, `host-feature-unavailable` refusal at install, upgrade and pin; shared fixtures in `testdata/plugin-manifest/` (Rust and `browser/lib`); v2 release ids pinned.
- [x] Registry keyed on `(host, method, normalized pattern)`; atomic registration on activation; cleared on pause, revoke, closed gate; only on the execution owner (not during a peer import).
- [x] Mounts `installation-origin` and `drive-prefix` (`/_routes/<slug>/`); slugs from the Installation subject, never reused.
- [x] Collision refusal as a typed problem naming the other installation; reserved host paths.
- [x] Responses: paused 503 + `Retry-After: 3600`, revoked 410 for 30 days then 404, degraded 404, matched route 501 until execution exists.
- [x] Every build reserves `_routes/` in subject creation.

## Remaining

- [ ] Run the handler for a matched route (route worker pool, response validation, `readRouteStatus`; AS-05).
- [ ] `drive-host` mount and the well-known dispatcher (#1716).
- [ ] Removed routes after an upgrade answer 410 (design 2.9); today they answer 404.
- [ ] Route writes, grant and quotas (#1717); keys, tokens, deliveries, listeners, sidecars.
- [ ] Install review UI listing public endpoints (#1713).
- [ ] Reachability self-check and `public-origin` advertising (D7).
- [ ] Re-evaluate the `Tree::PluginMeta` route records when execution-owner handoff (#1535) lands.
