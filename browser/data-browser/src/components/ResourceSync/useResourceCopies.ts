import { useCallback, useSyncExternalStore } from 'react';
import { useStore, type Resource, type Store } from '@tomic/react';
import {
  getResourceVaultAttachmentSyncStatus,
  getResourceVaultSyncStatus,
  subscribeResourceCopies,
} from '../../helpers/managed/vaultResourceSync';

function readReceipts(store: Store, resource: Resource) {
  return {
    status: store.getResourceSyncStatus(resource),
    peers: store.getResourcePeerSyncStatus(resource),
    vault: getResourceVaultSyncStatus(store, resource),
    attachments: store.getResourceAttachmentSyncStatus(resource),
    vaultAttachments: getResourceVaultAttachmentSyncStatus(store, resource),
  };
}

function copies({
  status,
  peers,
  vault,
  attachments,
  vaultAttachments,
}: ReturnType<typeof readReceipts>) {
  return {
    status,
    peers,
    vault,
    contents: { ...attachments, vault: vaultAttachments },
  };
}

const snapshots = new WeakMap<
  Resource,
  {
    receipts: ReturnType<typeof readReceipts>;
    value: ReturnType<typeof copies>;
  }
>();

function getResourceCopies(store: Store, resource: Resource) {
  const next = readReceipts(store, resource);
  const previous = snapshots.get(resource);

  if (
    previous &&
    next.status === previous.receipts.status &&
    next.peers === previous.receipts.peers &&
    next.vault === previous.receipts.vault &&
    next.attachments === previous.receipts.attachments &&
    next.vaultAttachments === previous.receipts.vaultAttachments
  )
    return previous.value;

  const value = copies(next);
  snapshots.set(resource, { receipts: next, value });

  return value;
}

/** Reads one consistent item view of the scoped destination receipts. */
export function useResourceCopies(resource: Resource) {
  const store = useStore();
  const target = resource.__internalObject;
  const subscribe = useCallback(
    (callback: () => void) => subscribeResourceCopies(store, target, callback),
    [store, target],
  );
  const snapshot = useCallback(
    () => getResourceCopies(store, target),
    [store, target],
  );

  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
