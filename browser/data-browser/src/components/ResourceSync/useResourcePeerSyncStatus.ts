import { useCallback, useSyncExternalStore } from 'react';
import { useStore, type Resource } from '@tomic/react';

/** Observes authenticated peer receipts; rendering a row never starts sync. */
export function useResourcePeerSyncStatus(resource: Resource) {
  const store = useStore();
  const target = resource.__internalObject;
  const subscribe = useCallback(
    (callback: () => void) =>
      store.subscribeResourcePeerSyncStatus(target, callback),
    [store, target],
  );
  const snapshot = useCallback(
    () => store.getResourcePeerSyncStatus(target),
    [store, target],
  );

  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
