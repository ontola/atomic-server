import type { Store } from '@tomic/lib';

/**
 * A module namespace as a spec uses it: destructure the exports you need and
 * call them. The data-browser is a separate TS project, so there is no shared
 * type to point at from here — the exports stay as loose as they were under the
 * `await import(path)` this replaced.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppModule = Record<string, any>;

declare global {
  interface Window {
    /** Set by data-browser `App.tsx` for debugging and e2e probes. */
    store: Store;
    /**
     * Resolves an app module by its path relative to `browser/`, e.g.
     * `data-browser/src/chunks/Website/websiteModel.ts`.
     *
     * Registered by `data-browser/src/helpers/e2eModules.ts` in dev and in
     * `VITE_E2E=true` builds — the two SPAs this suite ever runs against. Use
     * this rather than `import('/src/…')`: that is a Vite dev-server URL and
     * 404s on the CI topology, where the SPA is built and served by
     * atomic-server itself.
     */
    __atomicTestModules: (path: string) => Promise<AppModule>;
    __e2eLoad?: {
      longTasks: Array<{ start: number; duration: number }>;
      maxTimerLagMs: number;
    };
  }
}

export {};
