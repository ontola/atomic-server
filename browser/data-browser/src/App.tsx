import { StoreContext, Store, enableLoro } from '@tomic/react';

import { isDev } from './config';
import { registerHandlers } from './handlers';
import { getAgentFromIDB } from './helpers/agentStorage';
import { registerCustomCreateActions } from './components/forms/NewForm/CustomCreateActions';
import { serverURLStorage } from './helpers/serverURLStorage';
import { driveStorage } from './helpers/driveStorage';
import { isRunningInTauri } from './helpers/tauri';

import { useEffect, type JSX } from 'react';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './routes/Router';

import { errorHandler } from './handlers/errorHandler';
import { PerformanceProfiler, attachStoreToProfiler } from './helpers/profiler';

function fixDevUrl(url: string) {
  if (isDev()) {
    return url.replace('5173', '9883');
  }

  return url;
}

/**
 * In Tauri, window.location.origin is a custom-protocol URL (e.g. `tauri://localhost`),
 * not the embedded atomic-server. Point the Store at the local server instead.
 * In dev: Vite serves at 5173; the Store talks to atomic-server at 9883.
 * In prod (browser): default to the current origin.
 */
const defaultServerUrl = isRunningInTauri()
  ? 'http://localhost:9883'
  : fixDevUrl(window.location.origin);
const storedServerUrl = serverURLStorage.get();
// Reject obviously-invalid stored URLs (e.g. `tauri://localhost` left behind
// by an earlier buggy release). The Store requires http(s) or iroh: URLs.
const storedIsValid =
  !!storedServerUrl &&
  (storedServerUrl.startsWith('http://') ||
    storedServerUrl.startsWith('https://') ||
    storedServerUrl.startsWith('iroh:'));
const serverUrl = storedIsValid ? storedServerUrl! : defaultServerUrl;

// Loro CRDT loads in the background — first paint doesn't wait. The
// JSON-AD-initial meta tag emitted by atomic-server flattens the linked
// resource's propvals into `_cache` via `parseMetaTags()` below, so
// reads like `resource.get(prop)` return data immediately even before
// Loro's WASM finishes downloading. SYNC_PUSH frames that land during
// the Loro-init window buffer their loroUpdate bytes in
// `_loroSnapshotBytes`; the `Resource.loading` getter treats that as
// "loaded" iff `_cache` has propvals (the common post-meta-tag state),
// so the UI doesn't gate on Loro for the initial render.
//
// Once Loro resolves: subsequent reads on a resource with buffered
// bytes call `getLoroDoc()` which imports them lazily. Writes
// (`Resource.set`) also go through `getLoroDoc()` and force the
// materialise-then-mutate path. No explicit "Loro is ready, now
// rehydrate everything" sweep is needed.
// Fire-and-forget — first paint doesn't wait. Catch so a failed import
// (offline + no cached module) doesn't show up as an unhandledrejection
// in the console; LoroLoader.isLoaded() stays false and code paths
// that need Loro (editor, history scrub) gracefully no-op.
enableLoro().catch(e =>
  console.warn('[Loro] init failed, edit/history features disabled:', e),
);
const initalAgent = await getAgentFromIDB();

// Initialize the store
const store = new Store({
  agent: initalAgent,
  serverUrl,
});

const initialDrive = driveStorage.get();
if (initialDrive) {
  store.setDrive(initialDrive);
}

import { bootstrap } from './bootstrap';
bootstrap(store);

// Initialize the WASM ClientDb in a background worker.
// Non-blocking — the app works without it.
// Skipped under Tauri (embedded server makes OPFS redundant) or when the
// user explicitly opted out via the Sync page toggle.
import { initClientDb } from './helpers/initClientDb';
import { isClientDbEnabled } from './helpers/clientDbMode';
if (isClientDbEnabled()) {
  initClientDb(store);
}

store.parseMetaTags();

declare global {
  interface Window {
    bugsnagApiKey: string;
  }
}

// Fetch all the Properties and Classes - this helps speed up the app.
// store.preloadPropsAndClasses();

registerCustomCreateActions();
// Register global event handlers.
registerHandlers(store);

// Make the Store available globally for debugging
window.store = store;

// Wire store events into the perf profiler so subscription / commit
// traffic shows up alongside React render counts. Cmd/Ctrl+Shift+P to
// dump a snapshot.
attachStoreToProfiler(store);

if (isDev()) {
  const { attachDevtools } = await import('./helpers/devtools');
  attachDevtools(store);
}

/** Entrypoint of the application. This is where providers go. */
function App(): JSX.Element {
  // Handle uncaught errors
  useEffect(() => {
    window.onerror = (message, _source, _lineno, _colno, error) => {
      if (!error) {
        errorHandler(new Error(`message: ${message}`));
      }

      errorHandler(error as Error);
    };

    window.onunhandledrejection = event => {
      errorHandler(event.reason);
    };
  }, []);

  return (
    <StoreContext.Provider value={store}>
      <PerformanceProfiler id='app'>
        <RouterProvider router={router}></RouterProvider>
      </PerformanceProfiler>
    </StoreContext.Provider>
  );
}

export default App;

declare global {
  interface Window {
    store: Store;
  }
}
