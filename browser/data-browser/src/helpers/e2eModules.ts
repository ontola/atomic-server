/**
 * App modules the Playwright specs drive directly.
 *
 * A number of specs build their fixtures by calling app helpers instead of
 * clicking all the way through the UI. They used to reach them with
 * `import('/src/chunks/Website/websiteModel.ts')` and friends, which only
 * resolve against a Vite dev server. The e2e pipeline runs against the bundle
 * atomic-server has embedded, where no `/src/...` path exists, so every one of
 * those specs died on "Failed to fetch dynamically imported module".
 *
 * So an E2E build hangs the modules on `window.atomicE2E` and the specs read
 * them from there. `attachE2EModules` is only ever called behind `isE2E()`, so
 * a release build neither exposes the registry nor pulls these chunks into its
 * entry graph.
 */
import type * as CreateTableFromSpec from '@integration-host/table/createTableFromSpec';
import type * as RunScript from '@integration-host/runScript';
import type * as HostingClient from '../chunks/Website/hostingClient';
import type * as OptimizeWebsiteImage from '../chunks/Website/optimizeWebsiteImage';
import type * as WebsiteExport from '../chunks/Website/websiteExport';
import type * as WebsiteModel from '../chunks/Website/websiteModel';
// The v2 sync protocol codec is not part of `@tomic/lib`'s public entry, and
// the file imports nothing, so taking it from source costs one tiny module.
import type * as WsV2 from '../../../lib/src/ws-v2';

export interface E2EModules {
  createTableFromSpec: typeof CreateTableFromSpec;
  hostingClient: typeof HostingClient;
  optimizeWebsiteImage: typeof OptimizeWebsiteImage;
  runScript: typeof RunScript;
  websiteExport: typeof WebsiteExport;
  websiteModel: typeof WebsiteModel;
  wsV2: typeof WsV2;
}

export async function attachE2EModules(): Promise<void> {
  const [
    createTableFromSpec,
    hostingClient,
    optimizeWebsiteImage,
    runScript,
    websiteExport,
    websiteModel,
    wsV2,
  ] = await Promise.all([
    import('@integration-host/table/createTableFromSpec'),
    import('../chunks/Website/hostingClient'),
    import('../chunks/Website/optimizeWebsiteImage'),
    import('@integration-host/runScript'),
    import('../chunks/Website/websiteExport'),
    import('../chunks/Website/websiteModel'),
    import('../../../lib/src/ws-v2'),
  ]);

  window.atomicE2E = {
    createTableFromSpec,
    hostingClient,
    optimizeWebsiteImage,
    runScript,
    websiteExport,
    websiteModel,
    wsV2,
  };
}

declare global {
  interface Window {
    /** Only present in a `VITE_E2E=true` build. See `attachE2EModules`. */
    atomicE2E?: E2EModules;
  }
}
