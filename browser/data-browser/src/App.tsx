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
const initalAgent = await getAgentFromIDB();

// Loro CRDT must be initialized BEFORE the Store opens its WebSocket. The
// Store's constructor (`new Store(...)`) wires up `setServerUrl` →
// `openWebSocket`, and the resulting WS can complete `AUTH` and start
// receiving `SYNC_PUSH` frames within a few hundred milliseconds — long
// before `await enableLoro()` would resolve if it ran later. When
// `SYNC_PUSH` lands without Loro loaded, `Resource.importLoroUpdate`
// buffers the bytes in `_loroSnapshotBytes` instead of materialising the
// `_loroDoc`. The `resource.loading` getter then keeps reporting `true`
// (it considers buffered-without-doc as still loading), which gates the
// resource out of `clientDb.putResource(...)` in `addResource`. The WASM
// index never sees those resources, so on initial page load every
// `useChildren` / `useCollection` query for a synced parent returns 0
// hits in the local DB and falls through to a `/query` GET against the
// server — even though the data was just pushed.
await enableLoro();

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
