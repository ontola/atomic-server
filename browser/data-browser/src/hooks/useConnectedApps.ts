import { useEffect, useState } from 'react';
import {
  core,
  readConnectionSubjects,
  server,
  useStore,
  type Store,
} from '@tomic/react';
import type { ConnectedAppInfo } from '@helpers/driveApps';

const CACHE_MS = 30_000;
const cache = new WeakMap<
  Store,
  Map<string, { at: number; apps: Promise<ConnectedAppInfo[]> }>
>();

async function loadConnectedApps(
  store: Store,
  drive: string,
): Promise<ConnectedAppInfo[]> {
  const subjects = await readConnectionSubjects(
    store,
    drive,
    core.properties.isA,
    server.classes.connectedApp,
  );

  const apps = await Promise.all(
    subjects.map(async (subject): Promise<ConnectedAppInfo | undefined> => {
      const resource = await store.getResource(subject);

      if (resource.error) return undefined;

      const name = resource.get(core.properties.name);

      return {
        subject,
        name: typeof name === 'string' ? name : subject,
        homepage: resource.get(server.properties.homepage),
        openUrlTemplate: resource.get(server.properties.openUrlTemplate),
        handlesClasses: resource.get(server.properties.handlesClasses) ?? [],
      };
    }),
  );

  return apps.filter((a): a is ConnectedAppInfo => a !== undefined);
}

/**
 * The `ConnectedApp`s registered in a drive, found by class under the drive
 * (as `PluginList` does for Installations). Shared and cached briefly so a
 * menu on every row does not query the server once each. Empty while loading
 * or when the server cannot answer.
 */
export function useConnectedApps(
  drive: string | undefined,
): ConnectedAppInfo[] {
  const store = useStore();
  const [apps, setApps] = useState<ConnectedAppInfo[]>([]);

  useEffect(() => {
    if (!drive) {
      setApps([]);

      return;
    }

    let active = true;
    let perStore = cache.get(store);

    if (!perStore) {
      perStore = new Map();
      cache.set(store, perStore);
    }

    let entry = perStore.get(drive);

    if (!entry || Date.now() - entry.at > CACHE_MS) {
      const promise = loadConnectedApps(store, drive);

      entry = { at: Date.now(), apps: promise };
      perStore.set(drive, entry);
      // A failed query must not be served from the cache.
      promise.catch(() => perStore.delete(drive));
    }

    entry.apps
      .then(found => {
        if (active) setApps(found);
      })
      .catch(() => {
        // Shown as none; the server may predate the ConnectedApp class.
        if (active) setApps([]);
      });

    return () => {
      active = false;
    };
  }, [store, drive]);

  return apps;
}
