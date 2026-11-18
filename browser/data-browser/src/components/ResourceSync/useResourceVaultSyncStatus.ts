import { useCallback, useSyncExternalStore } from 'react';
import { useStore, type Resource } from '@tomic/react';
import {
  getResourceVaultSyncStatus,
  subscribeResourceVaultSyncStatus,
} from '../../helpers/managed/vaultResourceSync';

/** Reads shared local proof; mounting a resource row never starts a backup. */
export function useResourceVaultSyncStatus(resource: Resource) {
  const store = useStore();
  const target = resource.__internalObject;
  const subscribe = useCallback(
    (callback: () => void) =>
      subscribeResourceVaultSyncStatus(store, target, callback),
    [store, target],
  );
  const snapshot = useCallback(
    () => getResourceVaultSyncStatus(store, target),
    [store, target],
  );

  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
