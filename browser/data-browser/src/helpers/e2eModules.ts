declare global {
  interface Window {
    /**
     * Resolves an app module by its path relative to `browser/`. Present only
     * in dev and `VITE_E2E=true` builds; see {@link registerTestModules}.
     */
    __atomicTestModules?: (path: string) => Promise<unknown>;
  }
}

/**
 * The app modules the Playwright suite drives directly.
 *
 * Specs used to reach into app internals with
 * `await import('/src/chunks/Website/websiteModel.ts')`. That specifier is a
 * Vite dev-server URL: it resolves only while `pnpm start` serves the SPA from
 * source. CI builds the data-browser and embeds `dist/` in atomic-server
 * (`.dagger/src/index.ts` → `jsBuild(true)` → `server/assets_tmp`), so the
 * browser asked the Rust server for a path it has never served and every spec
 * that used one died on `Failed to fetch dynamically imported module` — green
 * locally, red on the pipeline.
 *
 * Registering them here gives both topologies one path. The bundler resolves
 * each specifier at build time, so a spec gets the module the app itself runs,
 * and still asks for it by its source path — which is what a reader of the spec
 * wants to see anyway.
 *
 * Keys are paths relative to `browser/`, so a spec never has to know whether
 * the SPA came from Vite or from the server binary.
 *
 * Every entry is a lazy `import()` of a module the app already code-splits, and
 * nothing here is registered outside dev and `VITE_E2E=true` builds, so a
 * registered module costs a production bundle nothing.
 */
const testModules: Record<string, () => Promise<unknown>> = {
  'data-browser/src/chunks/PluginRuns/runScript.ts': () =>
    import('@chunks/PluginRuns/runScript'),
  'data-browser/src/chunks/TablePage/createTableFromSpec.ts': () =>
    import('@chunks/TablePage/createTableFromSpec'),
  'data-browser/src/chunks/Website/hostingClient.ts': () =>
    import('@chunks/Website/hostingClient'),
  'data-browser/src/chunks/Website/optimizeWebsiteImage.ts': () =>
    import('@chunks/Website/optimizeWebsiteImage'),
  'data-browser/src/chunks/Website/websiteExport.ts': () =>
    import('@chunks/Website/websiteExport'),
  'data-browser/src/chunks/Website/websiteModel.ts': () =>
    import('@chunks/Website/websiteModel'),
  // The same two specifiers `chunks/PluginRuns/githubInstaller.ts` imports, so
  // a spec installs the provider exactly the way the app does.
  'integrations/github-issues/atomic.ts': () =>
    import('../../../../integrations/github-issues/atomic'),
  'integrations/github-issues/plugin.js': () =>
    import('../../../../integrations/github-issues/plugin.js?raw'),
  'lib/src/index.ts': () => import('@tomic/lib'),
  // Not re-exported from `@tomic/lib`'s entry point, so it comes from source —
  // the same file the package builds from, and one with no imports of its own.
  'lib/src/ws-v2.ts': () => import('../../../lib/src/ws-v2'),
};

/**
 * Exposes {@link testModules} on `window` for `page.evaluate`.
 *
 * An unknown key throws, naming the registered ones, rather than resolving to
 * `undefined`: a spec that destructures a missing module otherwise fails later,
 * somewhere unrelated to the line that asked for it.
 */
export function registerTestModules(): void {
  window.__atomicTestModules = async (path: string) => {
    const load = testModules[path];

    if (!load) {
      throw new Error(
        `No test module registered for '${path}'. Registered: ${Object.keys(
          testModules,
        ).join(', ')}. Add it to data-browser/src/helpers/e2eModules.ts.`,
      );
    }

    return load();
  };
}
