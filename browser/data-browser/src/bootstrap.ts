import { JSONADParser, type Store } from '@tomic/react';
import baseModels from '@repo-lib-defaults/default_base_models.json';
import defaultStore from '@repo-lib-defaults/default_store.json';
import tableDefaults from '@repo-lib-defaults/table.json';
import chatroomDefaults from '@repo-lib-defaults/chatroom.json';
import ontologiesDefaults from '@repo-lib-defaults/ontologies.json';
import aiDefaults from '@repo-lib-defaults/ai.json';

/**
 * Injects base models and default store resources into the store.
 * This ensures that critical property definitions (like 'subdomain') are
 * available even if the server has no Drive binding yet or the definitions haven't
 * been uploaded to the live atomicdata.dev server yet.
 */
export function bootstrap(store: Store): void {
  const parser = new JSONADParser();

  const addBootstrapped = (json: unknown) => {
    const resources = parser.parse(json);

    for (const r of resources) {
      r.loading = false;
      store.applyIncoming({
        subject: r.subject,
        resource: r,
        source: 'offline-replay',
      });
    }

    return resources.length;
  };

  try {
    const baseCount = addBootstrapped(baseModels);
    const storeCount = addBootstrapped(defaultStore);
    addBootstrapped(tableDefaults);
    addBootstrapped(chatroomDefaults);
    addBootstrapped(ontologiesDefaults);
    addBootstrapped(aiDefaults);
  } catch (e) {
    console.error('Failed to bootstrap store:', e);
  }
}
