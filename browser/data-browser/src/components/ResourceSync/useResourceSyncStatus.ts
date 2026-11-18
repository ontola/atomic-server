import { useCallback, useSyncExternalStore } from 'react';
import { useStore, type Resource } from '@tomic/react';

/** Per-resource evidence; connection and drive activity are not save receipts. */
export function useResourceSyncStatus(resource: Resource) {
  const store = useStore();
  const target = resource.__internalObject;
  const subscribe = useCallback(
    (callback: () => void) =>
      store.subscribeResourceSyncStatus(target, callback),
    [store, target],
  );
  const snapshot = useCallback(
    () => store.getResourceSyncStatus(target),
    [store, target],
  );

  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
