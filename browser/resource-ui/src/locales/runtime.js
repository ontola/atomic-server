// @wc-ignore-file
import { loadCatalogs } from 'wuchale/load-utils/pure';
import toRuntime from 'wuchale/runtime';
import { loadCatalog, loadCount } from './.wuchale/main.proxy.js';

/** The Atomic catalog is independent of any Wuchale namespaces in the embedding app. */
const store = Array.from({ length: loadCount }, () => toRuntime());
const callbacks = [];
export const getRuntime = (loadID = 0) => store[loadID];
export function subscribeRuntime(loadID, callback) {
  callbacks[loadID] ??= new Set();
  callbacks[loadID].add(callback);
  return () => callbacks[loadID].delete(callback);
}
export async function loadAtomicLocale(locale) {
  const catalogs = await loadCatalogs(
    locale,
    Array.from({ length: loadCount }, (_, id) => id),
    loadCatalog,
  );
  for (const [id, catalog] of Object.entries(catalogs)) {
    const runtime = toRuntime(catalog, locale);
    store[id] = runtime;
    callbacks[id]?.forEach(callback => callback(runtime));
  }
}
