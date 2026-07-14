import { Store } from "@tomic/lib";
import {
  PUBLIC_ATOMIC_DRIVE,
  PUBLIC_ATOMIC_SERVER_URL,
} from "$env/static/public";
import { initOntologies } from "$lib/ontologies";

// We use a global store. Keep in mind that this means the cache is shared between sessions. Don't do this if you have data that should only be available to certain agents.
let store: Store | undefined;

const init = () => {
  store = new Store({
    serverUrl: PUBLIC_ATOMIC_SERVER_URL,
  });
  store.setDrive(PUBLIC_ATOMIC_DRIVE);
  // SvelteKit runs universal load functions during SSR and again while the
  // browser hydrates, before the WebSocket connection may be established.
  // Allow those initial reads to use the explicitly configured HTTP origin.
  store.setServerConnected(true);

  initOntologies();
};

export const getStore = (): Store => {
  if (store === undefined) {
    init();
  }

  return store!;
};
