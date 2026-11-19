import { useCallback, useSyncExternalStore } from 'react';
import { useStore, type Resource } from '@tomic/react';
import {
  getResourceVaultAttachmentSyncStatus,
  subscribeResourceVaultAttachmentSyncStatus,
} from '../../helpers/managed/vaultResourceSync';

/** Reads byte evidence independently of metadata; never starts a backup. */
export function useResourceAttachmentSyncStatus(resource: Resource) {
  const store = useStore();
  const target = resource.__internalObject;
  const subscribe = useCallback(
    (callback: () => void) =>
      store.subscribeResourceAttachmentSyncStatus(target, callback),
    [store, target],
  );
  const snapshot = useCallback(
    () => store.getResourceAttachmentSyncStatus(target),
    [store, target],
  );
  const subscribeVault = useCallback(
    (callback: () => void) =>
      subscribeResourceVaultAttachmentSyncStatus(store, target, callback),
    [store, target],
  );
  const vaultSnapshot = useCallback(
    () => getResourceVaultAttachmentSyncStatus(store, target),
    [store, target],
  );
  const contents = useSyncExternalStore(subscribe, snapshot, snapshot);
  const vault = useSyncExternalStore(
    subscribeVault,
    vaultSnapshot,
    vaultSnapshot,
  );

  return { ...contents, vault };
}
