import { useEffect, useState, type JSX } from 'react';
import { StoreEvents, type StoreSyncStatus, useStore } from '@tomic/react';
import { ResourceEvents, type Resource } from '@tomic/lib';
import { FaWifi, FaArrowsRotate, FaCircleExclamation } from 'react-icons/fa6';
import { MdSignalWifiOff } from 'react-icons/md';
import { styled, keyframes } from 'styled-components';
import { currentDriveSync } from '../../helpers/driveSyncStatus';
import { isRunningInTauri } from '../../helpers/tauri';
import { isOriginWithoutNode } from '../../helpers/originNode';
import { DriveConfirmation } from './driveConfirmation';

export type SidebarSyncStatus = StoreSyncStatus & {
  liveSyncedDrive: boolean;
  unsavedChanges: boolean;
  refused: boolean;
  completeCopyConfirmed: boolean;
};

function sidebarStatus(
  store: ReturnType<typeof useStore>,
  completeCopyConfirmed = false,
): SidebarSyncStatus {
  const status = store.getSyncStatus();

  const hostname = status.serverUrl ? new URL(status.serverUrl).hostname : '';
  const embedded =
    isRunningInTauri() &&
    (hostname === 'localhost' || hostname === '127.0.0.1');
  const unsavedChanges = [...store.resources.values()].some(
    resource =>
      status.drive &&
      store.driveOfSubject(resource.subject) ===
        store.normalizeSubject(status.drive) &&
      (resource.hasUnsavedChanges() ||
        resource.isSaving ||
        store.getSaveState(resource).kind !== 'idle'),
  );

  return {
    ...status,
    syncInProgress: status.syncInProgress || store.isDriveSyncPulling(),
    liveSyncedDrive:
      !!status.drive &&
      store.isLiveSyncedDrive(status.drive) &&
      !embedded &&
      !isOriginWithoutNode(status.serverUrl),
    unsavedChanges: !!unsavedChanges,
    refused: store.isDriveRefusedByServer(status.drive),
    completeCopyConfirmed,
  };
}

function canConfirm(status: SidebarSyncStatus): boolean {
  return (
    status.liveSyncedDrive &&
    status.serverConnected &&
    !status.syncInProgress &&
    status.pendingDirtyCount === 0 &&
    status.blockedCount === 0 &&
    !status.unsavedChanges &&
    !status.refused &&
    !!currentDriveSync(status)
  );
}

/** The store's sync status, kept up to date as connection and sync change. */
export function useSyncStatus(): SidebarSyncStatus {
  const store = useStore();
  const [status, setStatus] = useState<SidebarSyncStatus>(() =>
    sidebarStatus(store),
  );

  useEffect(() => {
    let confirmed = false;
    const controller = new DriveConfirmation(
      store,
      () => canConfirm(sidebarStatus(store)),
      value => {
        confirmed = value;
        setStatus(sidebarStatus(store, confirmed));
      },
    );

    const refresh = () => {
      const next = sidebarStatus(store, confirmed);
      if (!canConfirm(next) && confirmed) controller.invalidate();
      setStatus(sidebarStatus(store, confirmed));
      controller.update();
    };

    const invalidateAndRefresh = () => {
      controller.invalidate();
      refresh();
    };

    const resourceSubscriptions = new Map<
      string,
      { resource: Resource; unsubscribe: () => void }
    >();
    const subjectsByResource = new WeakMap<Resource, string>();
    let mounted = true;
    let refreshQueued = false;

    const queueRefresh = () => {
      if (refreshQueued) return;
      refreshQueued = true;
      queueMicrotask(() => {
        refreshQueued = false;
        if (mounted) refresh();
      });
    };

    const watchResource = (resource: Resource) => {
      const subject = store.normalizeSubject(resource.subject);
      const previous = subjectsByResource.get(resource);

      if (previous && previous !== subject) {
        resourceSubscriptions.get(previous)?.unsubscribe();
        resourceSubscriptions.delete(previous);
      }

      const existing = resourceSubscriptions.get(subject);
      if (existing?.resource === resource) return;
      existing?.unsubscribe();
      const local = resource.on(
        ResourceEvents.LocalChange,
        invalidateAndRefresh,
      );
      const save = resource.on(
        ResourceEvents.SaveStateChange,
        invalidateAndRefresh,
      );
      subjectsByResource.set(resource, subject);
      resourceSubscriptions.set(subject, {
        resource,
        unsubscribe: () => {
          local();
          save();
        },
      });
    };

    for (const resource of store.resources.values()) watchResource(resource);
    const unsubUpdated = store.on(StoreEvents.ResourceUpdated, resource => {
      controller.invalidate();
      watchResource(resource);
      queueRefresh();
    });
    const unsubRemoved = store.on(StoreEvents.ResourceRemoved, subject => {
      controller.invalidate();
      const key = store.normalizeSubject(subject);
      resourceSubscriptions.get(key)?.unsubscribe();
      resourceSubscriptions.delete(key);
      refresh();
    });
    refresh();
    const unsubConnection = store.on(
      StoreEvents.ConnectionChanged,
      invalidateAndRefresh,
    );
    const unsubSync = store.on(
      StoreEvents.SyncStatusChanged,
      invalidateAndRefresh,
    );
    const unsubAgent = store.on(StoreEvents.AgentChanged, invalidateAndRefresh);
    const unsubDrive = store.on(StoreEvents.DriveChanged, invalidateAndRefresh);
    const unsubServer = store.on(
      StoreEvents.ServerURLChanged,
      invalidateAndRefresh,
    );

    return () => {
      controller.close();
      unsubUpdated();
      unsubRemoved();
      mounted = false;
      for (const subscription of resourceSubscriptions.values())
        subscription.unsubscribe();
      unsubAgent();
      unsubConnection();
      unsubSync();
      unsubDrive();
      unsubServer();
    };
  }, [store]);

  return status;
}

export function getSyncIcon(status: SidebarSyncStatus): JSX.Element {
  if (!status.liveSyncedDrive) {
    return (
      <OfflineIcon>
        <FaCircleExclamation title='Not syncing with a server' />
      </OfflineIcon>
    );
  }

  if (!status.serverConnected) {
    return (
      <OfflineIcon>
        <MdSignalWifiOff title='Offline' />
      </OfflineIcon>
    );
  }

  if (status.syncInProgress) {
    return (
      <SpinningIcon aria-hidden>
        <FaArrowsRotate />
      </SpinningIcon>
    );
  }

  if (status.blockedCount > 0) {
    return (
      <OfflineIcon>
        <FaCircleExclamation title='Changes could not sync' />
      </OfflineIcon>
    );
  }

  if (status.pendingDirtyCount > 0) {
    return (
      <OfflineIcon>
        <FaCircleExclamation title='Changes pending' />
      </OfflineIcon>
    );
  }

  if (!currentDriveSync(status)) {
    return (
      <OfflineIcon>
        <FaCircleExclamation title='Sync not confirmed' />
      </OfflineIcon>
    );
  }

  if (
    status.unsavedChanges ||
    status.refused ||
    !status.completeCopyConfirmed
  ) {
    return (
      <OfflineIcon>
        <FaCircleExclamation title='Sync not confirmed' />
      </OfflineIcon>
    );
  }

  return <FaWifi title='Synced with server' />;
}

/**
 * Whether the sidebar shows its warning icon: changes that could not sync, or
 * that wait with nothing else going on. The Sync page's banner explains it.
 */
export function hasSyncWarning(status: SidebarSyncStatus): boolean {
  return (
    status.liveSyncedDrive &&
    status.serverConnected &&
    !status.syncInProgress &&
    (status.blockedCount > 0 || status.pendingDirtyCount > 0)
  );
}

export function getSyncLabel(status: SidebarSyncStatus): string {
  if (!status.liveSyncedDrive) return 'Not syncing with a server';
  if (!status.serverConnected) return 'Offline';
  if (status.syncInProgress) return 'Syncing...';

  if (status.blockedCount > 0)
    return `${status.blockedCount} changes could not sync (no access)`;

  if (status.pendingDirtyCount > 0)
    return `${status.pendingDirtyCount} changes pending`;

  if (status.unsavedChanges) return 'Changes not yet synced';
  if (
    status.refused ||
    !currentDriveSync(status) ||
    !status.completeCopyConfirmed
  )
    return 'Sync not confirmed';

  return 'Synced with server';
}

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const SpinningIcon = styled.span`
  display: inline-flex;
  animation: ${spin} 1s linear infinite;
  color: ${p => p.theme.colors.alert};
`;

const OfflineIcon = styled.span`
  color: ${p => p.theme.colors.alert};
  display: inline-flex;
`;
