import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { StoreEvents, useStore, type Resource } from '@tomic/react';
import {
  PEER_LINK_CHANGED,
  peerLinkStatus,
} from '../../helpers/browserPeerSync';
import { hasManagedApi } from '../../helpers/managed/api';
import {
  getVaultDriveSummary,
  type VaultDriveSummary,
} from '../../helpers/managed/vault';
import { onVaultChanged } from '../../helpers/managed/vaultAutoBackup';
import {
  getManagedAccountOrNull,
  onManagedLogout,
  onManagedSessionChanged,
} from '../../helpers/managed/session';

export type ResourceCopyContext = {
  drive: string;
  serverConnected: boolean;
  peerStatus: string;
  vault: 'loading' | 'unknown' | 'off' | 'enabled' | 'suspended';
  lastBackupAt: number | null;
};

/** Mounted only in an open panel. All metadata is workspace context, not a
 * confirmation that this resource's current version reached a destination. */
export function useResourceCopyContext(
  resource: Resource,
): ResourceCopyContext {
  const store = useStore();
  const subscribeIdentity = useCallback(
    (callback: () => void) => store.on(StoreEvents.AgentChanged, callback),
    [store],
  );
  const identitySnapshot = useCallback(
    () => store.getAgent()?.subject ?? '',
    [store],
  );
  const identity = useSyncExternalStore(
    subscribeIdentity,
    identitySnapshot,
    identitySnapshot,
  );
  const subscribeConnection = useCallback(
    (callback: () => void) => store.on(StoreEvents.ConnectionChanged, callback),
    [store],
  );
  const connectionSnapshot = useCallback(() => store.serverConnected, [store]);
  const serverConnected = useSyncExternalStore(
    subscribeConnection,
    connectionSnapshot,
    connectionSnapshot,
  );
  const drive = store.driveOfSubject(resource.subject);
  const scope = `${identity}\n${drive}`;
  const [peer, setPeer] = useState({ scope: '', value: '' });
  const [vault, setVault] = useState<{
    scope: string;
    summary: VaultDriveSummary | null;
    loading: boolean;
  }>({ scope: '', summary: null, loading: true });

  useEffect(() => {
    const update = () =>
      setPeer({ scope, value: drive ? peerLinkStatus(drive) : '' });
    update();
    window.addEventListener(PEER_LINK_CHANGED, update);

    return () => window.removeEventListener(PEER_LINK_CHANGED, update);
  }, [drive, scope]);

  useEffect(() => {
    let generation = 0;
    let active = true;

    const refresh = () => {
      generation += 1;
      const request = generation;
      setVault({ scope, summary: null, loading: true });

      if (!drive || !identity || !hasManagedApi()) {
        setVault({ scope, summary: null, loading: false });

        return;
      }

      void getManagedAccountOrNull()
        .then(account => {
          // An identity/session change while checking the account must not
          // disclose the old workspace to the provider.
          if (!active || request !== generation || !account) return null;

          return getVaultDriveSummary(drive);
        })
        .catch(() => null)
        .then(summary => {
          if (active && request === generation)
            setVault({ scope, summary, loading: false });
        });
    };

    refresh();
    const offVault = onVaultChanged(changed => {
      if (changed === drive) refresh();
    });
    const offSession = onManagedSessionChanged(refresh);
    const offLogout = onManagedLogout(() => {
      generation += 1;
      setVault({ scope, summary: null, loading: false });
    });

    return () => {
      active = false;
      offVault();
      offSession();
      offLogout();
    };
  }, [drive, identity, scope]);

  const current = vault.scope === scope ? vault : null;
  const summary = current?.summary;

  return {
    drive,
    serverConnected,
    peerStatus: peer.scope === scope ? peer.value : '',
    vault:
      !current || current.loading
        ? 'loading'
        : !summary
          ? 'unknown'
          : !summary.enabled
            ? 'off'
            : summary.suspended
              ? 'suspended'
              : 'enabled',
    lastBackupAt: summary?.enabled ? summary.last_backup_at : null,
  };
}
