// [RECOVERY-RECONSTRUCTED] The original `helpers/managed/api.ts` was never captured
// in any Claude transcript (it predates the recovery window and isn't on the
// pushed `did` branch). Reconstructed from its call sites: every managed helper
// fetches `${getManagedApiBase()}/<endpoint>` against the control plane
// (routes are `/api/me`, `/api/logout`, `/api/sync-enrollments`,
// `/api/recovery-secret`). The dev portal URL mirrors `managedServer.ts`.
// VERIFY the production base against your real deployment.

import { isRunningInTauri } from '../tauri';

const PORTAL_URL_STORAGE_KEY = 'atomic-managed-portal-url';

const trimTrailingSlashes = (url: string): string => url.replace(/\/+$/, '');

let rememberedPortalUrl: string | null = null;

/**
 * Remember the control plane that a managed node pointed us at.
 *
 * The desktop app has no useful origin of its own — the webview serves it from
 * `tauri://localhost`, so neither a same-origin `/api` nor `window.location`
 * says anything about where the control plane lives. The only thing that does
 * is the `portalUrl` a managed node reports on `GET /server`; this stores it
 * for {@link getManagedApiBase}, persisted so a restart doesn't drop the
 * account before the first `/server` fetch comes back.
 *
 * A falsy URL is ignored rather than clearing the memory: the desktop shell
 * also asks its own embedded node, which is not managed and reports no portal.
 * That answer must not erase the real control plane.
 */
export function rememberManagedPortalUrl(url: string | null | undefined): void {
  if (!url) return;

  rememberedPortalUrl = trimTrailingSlashes(url);

  try {
    localStorage.setItem(PORTAL_URL_STORAGE_KEY, rememberedPortalUrl);
  } catch {
    // Storage disabled (private mode) — the in-memory copy still serves this session.
  }
}

/** The last control plane a managed node named, or null if none ever has. */
export function getRememberedManagedPortalUrl(): string | null {
  if (rememberedPortalUrl) return rememberedPortalUrl;

  try {
    const stored = localStorage.getItem(PORTAL_URL_STORAGE_KEY);

    if (stored) rememberedPortalUrl = trimTrailingSlashes(stored);
  } catch {
    // Storage disabled — nothing remembered.
  }

  return rememberedPortalUrl;
}

/** Base URL of the control-plane API (includes the `/api` prefix). */
export function getManagedApiBase(): string {
  const fromEnv =
    typeof import.meta !== 'undefined'
      ? (import.meta.env?.VITE_MANAGED_API_BASE as string | undefined)
      : undefined;

  if (fromEnv) return trimTrailingSlashes(fromEnv);

  // Checked BEFORE the localhost branch below, deliberately: the desktop
  // webview's origin is `tauri://localhost`, whose hostname is literally
  // `localhost`. Falling through would point every desktop build — shipped
  // ones included — at whatever happens to run on a dev machine's :3030.
  // There is no same-origin `/api` here either, so the only real answer is
  // the control plane the connected managed node named. Before any node has
  // (pure self-hosted, or nothing fetched yet) these fetches just fail, which
  // every caller already treats as "no control plane".
  if (isRunningInTauri()) {
    const portalUrl = getRememberedManagedPortalUrl();

    return portalUrl ? `${portalUrl}/api` : '/api';
  }

  if (typeof window !== 'undefined') {
    const { hostname } = window.location;

    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      // Local dev: the control-plane backend (`cargo run` binds
      // 0.0.0.0:3030 and serves /api/*; its CORS allows :6747/:49237/:6747).
      // The portal (:49237) is only the frontend and has no /api.
      return 'http://localhost:3030/api';
    }
  }

  // Same-origin deployment fallback.
  return '/api';
}
