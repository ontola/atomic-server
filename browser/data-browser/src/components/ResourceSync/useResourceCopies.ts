import { useCallback, useSyncExternalStore } from 'react';
import {
  useStore,
  type Resource,
  type ResourceCopies,
  type Store,
} from '@tomic/react';
import {
  getResourceVaultCopies,
  subscribeResourceCopies,
} from '../../helpers/managed/vaultResourceSync';

function copiesWithVault(
  { status, peers, contents }: ResourceCopies,
  vault: ReturnType<typeof getResourceVaultCopies>,
) {
  return {
    status,
    peers,
    vault: vault.document,
    contents: { ...contents, vault: vault.contents },
  };
}

const snapshots = new WeakMap<
  Resource,
  {
    copies: ResourceCopies;
    vault: ReturnType<typeof getResourceVaultCopies>;
    value: ReturnType<typeof copiesWithVault>;
  }
>();

function getResourceCopies(store: Store, resource: Resource) {
  const copies = store.getResourceCopies(resource);
  const vault = getResourceVaultCopies(store, resource);
  const previous = snapshots.get(resource);

  if (previous?.copies === copies && previous.vault === vault)
    return previous.value;

  const value = copiesWithVault(copies, vault);
  snapshots.set(resource, { copies, vault, value });

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
