# Production readiness

Status: production has not been promoted. This is the list of gates between
`develop` and a production deploy, reconciled 2026-09-15. Each line names the
owning plan where one exists. Verification logs stay out of this file.

## Release pipeline

- [ ] **Publish `@tomic/*` to npm on a `v*` tag.** The registry still serves
      `0.41.0-beta.0` (2025-06) for `lib`, `react`, `svelte` and `cli`;
      `plugin` and `edit-mode` were never published; seven betas have shipped
      since. `release.yml` has crates and desktop jobs and no npm job.
      PR #1355 adds it and needs a rebase plus `NPM_TOKEN` or Trusted
      Publishing on each package.
- [ ] Green full CI on the release commit including the atomic-saas
      downstream compatibility check.
- [ ] Finish paired server/SaaS CI.

## Server hardening

- [x] Rate limiting on write endpoints (`/commit`, `/upload`, `/blob`,
      `/iroh-sync`, WS `COMMIT`): `server/src/rate_limit.rs`, 2026-09-15.
      Still open from the same audit line: permissive CORS, client errors
      answered as 500 ([`security-audit-2026-09.md`](./security-audit-2026-09.md) D).
- [x] Library-owned durable flush so the Flutter binding stops losing writes
      on app kill ([`atomic-lib-runtime.md`](./atomic-lib-runtime.md), 2026-09-15).
- [ ] Desktop CSP (audit B7): `desktop/tauri.conf.json` still has `csp: null`.
- [ ] Managed-node paid-abuse gate: the bootstrap grace admits any drive for
      ten minutes with no reaper
      ([`cloud-sync-managed-node.md`](./cloud-sync-managed-node.md) item 4).

## Observability

- [ ] Private source-map upload for Sentry; no `SENTRY_AUTH_TOKEN` in any
      workflow ([`sentry-feedback-readiness.md`](./sentry-feedback-readiness.md)).
- [ ] Backend and managed-node synthetic error reporting verified
      independently of the browser.

## SaaS-side (tracked in atomic-saas)

- [ ] Verify real Stripe sandbox checkout (see the SaaS `PAYMENT_TESTING.md`).
- [ ] Operational restore and monitoring gates in the SaaS runbooks.
- [ ] Authoritative per-drive editor counts from the billing API
      ([`drive-sharing-state.md`](./drive-sharing-state.md),
      [`cloud-subscription-panel.md`](./cloud-subscription-panel.md)).

Shipped and removed from this list: Vault account revalidation after export,
expired-session handling, the 0.41.0-beta.6 and beta.7 releases, staging
Sentry feedback and error capture.
