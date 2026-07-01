// [RECOVERY-RECONSTRUCTED] The original `helpers/managed/api.ts` was never captured
// in any Claude transcript (it predates the recovery window and isn't on the
// pushed `did` branch). Reconstructed from its call sites: every managed helper
// fetches `${getManagedApiBase()}/<endpoint>` against the control plane
// (routes are `/api/me`, `/api/logout`, `/api/sync-enrollments`,
// `/api/recovery-secret`). The dev portal URL mirrors `managedServer.ts`.
// VERIFY the production base against your real deployment.

/** Base URL of the control-plane API (includes the `/api` prefix). */
export function getManagedApiBase(): string {
  const fromEnv =
    typeof import.meta !== 'undefined'
      ? (import.meta.env?.VITE_MANAGED_API_BASE as string | undefined)
      : undefined;

  if (fromEnv) return fromEnv.replace(/\/+$/, '');

  if (typeof window !== 'undefined') {
    const { hostname } = window.location;

    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      // Local dev: the control-plane backend (`cargo run` binds
      // 0.0.0.0:3030 and serves /api/*; its CORS allows :6747/:49237/:5173).
      // The portal (:49237) is only the frontend and has no /api.
      return 'http://localhost:3030/api';
    }
  }

  // Same-origin deployment fallback.
  return '/api';
}
