import { StoreContext, Store, enableLoro } from '@tomic/react';

import { isDev } from './config';
import { registerHandlers } from './handlers';
import { getAgentFromIDB } from './helpers/agentStorage';
import { registerCustomCreateActions } from './components/forms/NewForm/CustomCreateActions';
import { serverURLStorage } from './helpers/serverURLStorage';
import { driveStorage } from './helpers/driveStorage';

import { useEffect, type JSX } from 'react';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './routes/Router';

import { errorHandler } from './handlers/errorHandler';

function fixDevUrl(url: string) {
  if (isDev()) {
    return url.replace('5173', '9883');
  }

  return url;
}

/**
 * Defaulting to the current URL's origin will make sense in most non-dev environments.
 * In dev envs, we want to default to port 9883
 */
const serverUrl = fixDevUrl(serverURLStorage.get() ?? window.location.origin);
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
import { initClientDb } from './helpers/initClientDb';
initClientDb(store);

await enableLoro();

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

if (isDev()) {
  // You can access the Store from your console in dev mode!
  window.store = store;
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
      <RouterProvider router={router}></RouterProvider>
    </StoreContext.Provider>
  );
}

export default App;

declare global {
  interface Window {
    store: Store;
  }
}
