import type {
  ResourcePeerSyncStatus,
  ResourceSaveState,
  ResourceSyncStatus,
} from '@tomic/react';
import type { ResourceVaultPresentationStatus } from './resourceSyncPresentation';

export function peerCopyLabel(
  status: Pick<ResourcePeerSyncStatus, 'state'>,
): string {
  switch (status.state) {
    case 'confirmed':
      return 'Latest changes received';
    case 'pending':
      return 'Changes waiting for peers';
    default:
      return 'Resource copies not confirmed';
  }
}

export function vaultCopyLabel(
  status: ResourceVaultPresentationStatus,
): string {
  switch (status.state) {
    case 'confirmed':
      return 'Latest changes backed up';
    case 'pending':
      return 'Changes waiting for backup';
    default:
      return 'Resource backup not confirmed';
  }
}

export function localCopyLabel(status: ResourceSyncStatus['local']): string {
  switch (status.state) {
    case 'confirmed':
      return 'Saved on this device';
    case 'pending':
      return 'Saving on this device…';
    case 'error':
      return 'Could not save on this device';
    case 'unavailable':
      return 'Local storage unavailable';
    default:
      return 'Local copy not confirmed';
  }
}

export function serverCopyLabel(
  status: ResourceSyncStatus['server'],
  save: ResourceSaveState,
): string {
  if (status.state === 'not-configured') return 'No server configured';
  if (save.kind === 'error') return 'Changes could not sync';
  if (save.kind === 'dirty' || save.kind === 'scheduled')
    return 'Changes waiting to save';
  if (save.kind === 'saving') return 'Saving changes…';
  if (save.kind === 'queued' || status.state === 'pending')
    return 'Changes waiting to sync';
  if (status.state === 'confirmed') return 'Latest changes saved';

  return 'Copy not confirmed';
}
