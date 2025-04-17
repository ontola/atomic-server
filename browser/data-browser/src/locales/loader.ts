// Loading utils for Wuchale [Loader Docs](https://wuchale.dev/concepts/loadersproxies/)
/// <reference types="wuchale/virtual" />
import { loadCatalog, loadIDs, key } from 'virtual:wuchale/proxy'; // or proxy/sync
import { registerLoaders } from 'wuchale/load-utils';
import { useState, useEffect } from 'react';
import type { CatalogModule } from 'wuchale/runtime';

const callbacks: Record<string, (catalog: CatalogModule) => void> = {};
const store: Record<string, CatalogModule | undefined> = {};

// non-reactive
export const get = (loadID: string): CatalogModule | undefined => store[loadID];

const collection = {
  get: (loadID: string): CatalogModule => store[loadID]!,
  set: (loadID: string, catalog: CatalogModule): void => {
    store[loadID] = catalog; // for when useEffect hasn't run yet
    callbacks[loadID]?.(catalog);
  },
};

registerLoaders(key, loadCatalog, loadIDs, collection);

export default function useCatalog(loadID: string): CatalogModule | undefined {
  const [catalog, setCatalog] = useState<CatalogModule | undefined>(
    store[loadID],
  );
  useEffect(() => {
    callbacks[loadID] = (newCatalog: CatalogModule) => setCatalog(newCatalog);

    return () => {
      delete callbacks[loadID];
    };
  }, [loadID]);

  return catalog;
}
