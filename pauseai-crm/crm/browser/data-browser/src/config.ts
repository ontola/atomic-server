/// <reference types="vite/client" />

/** Returns true if this is run in locally, in Development mode */
export function isDev(): boolean {
  return import.meta.env.MODE === 'development';
}

/** True when the build is targeted at the Playwright E2E pipeline. Enables
 *  dev/test affordances (`/app/dev-drive`, `/app/prunetests`) on a
 *  production-mode build so the e2e tests can run against an atomic-server
 *  serving its own embedded SPA. Set `VITE_E2E=true` at build time. */
export function isE2E(): boolean {
  return import.meta.env.VITE_E2E === 'true';
}

/** True when dev-only routes (`/app/dev-drive`, `/app/prunetests`,
 *  `/app/sandbox`) should be exposed. */
export function devRoutesEnabled(): boolean {
  return isDev() || isE2E();
}
