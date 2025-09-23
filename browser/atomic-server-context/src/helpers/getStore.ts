// src/helpers/getStore.ts
import { Store } from '@tomic/lib';
import { initOntologies } from '../ontologies';

let store: Store;

export function getStore(): Store {
  if (!store) {
    store = new Store({
      serverUrl: "https://common.terraphim.io/drive/h6grD0ID",
    });

    initOntologies();
  }

  return store;
}