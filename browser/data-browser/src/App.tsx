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

/**
 * The atomic-server the Store talks to.
 *
 * Normally the SPA is *served by* atomic-server, so its own origin IS the
 * server. Two exceptions:
 * - Tauri: `window.location.origin` is a custom-protocol URL, not the server.
 * - Vite dev: vite serves the SPA on a separate port from the server, so set
 *   `VITE_ATOMIC_SERVER_URL` (see `.env.development`) to point at the real
 *   server (e.g. `http://localhost:9883`). This is the only "dev edge case" —
 *   no hardcoded vite port lives in the app anymore.
 */
const defaultServerUrl = isRunningInTauri()
  ? 'http://localhost:9883'
  : (import.meta.env.VITE_ATOMIC_SERVER_URL ?? window.location.origin);
const storedServerUrl = serverURLStorage.get();
// Reject obviously-invalid stored URLs (e.g. `tauri://localhost` left behind
// by an earlier buggy release). The Store requires http(s) URLs.
const storedIsValid =
  !!storedServerUrl &&
  (storedServerUrl.startsWith('http://') ||
    storedServerUrl.startsWith('https://'));
const serverUrl = storedIsValid ? storedServerUrl! : defaultServerUrl;

// Fire-and-forget — first paint doesn't wait. Catch so a failed import
// (offline + no cached module) doesn't show up as an unhandledrejection
// in the console; LoroLoader.isLoaded() stays false and code paths
// that need Loro (editor, history scrub) gracefully no-op.
//
// We tried scheduling this via requestIdleCallback to keep the WASM
// download off the FCP-critical network bus, but that breaks the
// title-save round-trip in tests: useValue's setter calls
// `resource.set()` (which falls back to `_cache` when Loro isn't
// loaded) and then debounces a `save()`. Between those two, the input
// can unmount before signChanges runs, and the debounced save races
// the in-flight Loro import in ways we don't fully understand yet.
// Until the save flow is hardened (or the debounce moved into the
// resource itself), keep Loro eager.
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
