import { JSONADParser, type Store } from '@tomic/react';
import baseModels from '../../../lib/defaults/default_base_models.json';
import defaultStore from '../../../lib/defaults/default_store.json';

/**
 * Injects base models and default store resources into the store.
 * This ensures that critical property definitions (like 'subdomain') are
 * available even if the server is uninitialized or the definitions haven't
 * been uploaded to the live atomicdata.dev server yet.
 */
export function bootstrap(store: Store): void {
  console.log('Bootstrapping store with base models...');
  const parser = new JSONADParser();

  const addBootstrapped = (json: unknown) => {
    const resources = parser.parse(json);

    for (const r of resources) {
      r.loading = false;
      store.addResources(r, { skipCommitCompare: true });
    }

    return resources.length;
  };

  try {
    const baseCount = addBootstrapped(baseModels);
    const storeCount = addBootstrapped(defaultStore);

    console.log(`Bootstrapped ${baseCount + storeCount} resources.`);
  } catch (e) {
    console.error('Failed to bootstrap store:', e);
  }
}
