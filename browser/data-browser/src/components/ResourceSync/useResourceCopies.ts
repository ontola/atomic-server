import { useCallback, useSyncExternalStore } from 'react';
import { useStore, type Resource } from '@tomic/react';
import { subscribeResourceCopiesWithVault } from '../../helpers/managed/vaultResourceSync';

/** What each destination has proven about this resource, from its receipts:
 * the server, Cloud Vault and peers alike. Rendering a row never starts a
 * sync or a backup. */
export function useResourceCopies(resource: Resource) {
  const store = useStore();
  const target = resource.__internalObject;
  const subscribe = useCallback(
    (callback: () => void) =>
      subscribeResourceCopiesWithVault(store, target, callback),
    [store, target],
  );
  const snapshot = useCallback(
    () => store.getResourceCopies(target),
    [store, target],
  );

  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
