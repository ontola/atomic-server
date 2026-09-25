// @wc-ignore-file
import { useEffect } from 'react';
import toast from 'react-hot-toast';
import { useChildren, type Store } from '@tomic/react';
import { getIntegrationProxy } from './integrationProxy';
import { ProxyConnections } from './proxyConnections';
import {
  readInstallationRuntimes,
  registerInstallationRuntimes,
  unregisterRuntimes,
  type InstallationRuntime,
} from './installationRuntimes';

/** The configured proxy, managed with the signed-in user's key. */
export function proxyConnectionsFor(store: Store): ProxyConnections {
  return new ProxyConnections(localStorage, getIntegrationProxy(), () =>
    store.getAgent(),
  );
}

/** Proxy failures are shown, never thrown into a render or a click handler. */
function report(error: unknown) {
  toast.error(error instanceof Error ? error.message : String(error));
}

/**
 * Registers `installation`'s runtimes with the proxy, in the background.
 * A no-op for anything that is not an Installation with an app id.
 */
export function registerRuntimesInBackground(
  store: Store,
  installation: string,
  children?: readonly string[],
): void {
  if (!store.getAgent()) return;
  let connections: ProxyConnections;

  try {
    connections = proxyConnectionsFor(store);
  } catch (e) {
    return report(e);
  }

  registerInstallationRuntimes(store, connections, installation, children)
    .then(posted => {
      if (posted.length)
        console.info(
          `Registered ${posted.length} runtime(s) of ${installation} with ${connections.origin}`,
        );
    })
    .catch(report);
}

/** Removes runtimes at the proxy, in the background. */
export function unregisterRuntimesInBackground(
  store: Store,
  runtimes: readonly InstallationRuntime[],
): void {
  if (!store.getAgent() || runtimes.length === 0) return;

  try {
    unregisterRuntimes(proxyConnectionsFor(store), runtimes).catch(report);
  } catch (e) {
    report(e);
  }
}

/** Reads the runtimes now, then removes them at the proxy in the background. */
export async function unregisterInstallationRuntimes(
  store: Store,
  installation: string,
): Promise<InstallationRuntime[]> {
  try {
    const runtimes = await readInstallationRuntimes(store, installation);
    unregisterRuntimesInBackground(store, runtimes);

    return runtimes;
  } catch (e) {
    report(e);

    return [];
  }
}

/**
 * Keeps an open Installation's runtimes registered with the proxy: on open,
 * and whenever a runtime child appears. Only for someone who can manage the
 * Installation, and not once it is revoked.
 */
export function useInstallationRuntimes(
  store: Store,
  installation: string,
  enabled: boolean,
): void {
  const { subjects, loading } = useChildren(enabled ? installation : undefined);
  const key = subjects.join('\n');

  useEffect(() => {
    if (!enabled || loading || subjects.length === 0) return;
    registerRuntimesInBackground(store, installation, subjects);
    // `key` stands for `subjects`, whose identity changes on every re-sort.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, installation, enabled, loading, key]);
}
