import type { ResourceSaveState, ResourceSyncStatus } from '@tomic/react';

export type SyncTone = 'neutral' | 'confirmed' | 'pending' | 'attention';
export type SyncSymbol =
  | 'device'
  | 'server'
  | 'vault'
  | 'waiting'
  | 'saving'
  | 'error';

export type ResourceVaultPresentationStatus = {
  state: 'unknown' | 'pending' | 'confirmed';
  confirmedAt?: number;
};

/** Copy is deliberately based on receipts, never an idle queue or presence. */
export function resourceSyncPresentation(
  status: ResourceSyncStatus,
  save: ResourceSaveState,
  vault: ResourceVaultPresentationStatus = { state: 'unknown' },
): { label: string; tone: SyncTone; symbol: SyncSymbol } {
  if (status.local.state === 'error') {
    return {
      label: 'Could not save on this device',
      tone: 'attention',
      symbol: 'error',
    };
  }

  if (save.kind === 'error') {
    return {
      label: 'Changes could not be saved',
      tone: 'attention',
      symbol: 'error',
    };
  }

  if (save.kind === 'dirty' || save.kind === 'scheduled') {
    return {
      label: 'Changes waiting to save',
      tone: 'pending',
      symbol: 'waiting',
    };
  }

  if (save.kind === 'queued') {
    return {
      label: 'Changes waiting to sync',
      tone: 'pending',
      symbol: 'waiting',
    };
  }

  if (save.kind === 'saving' || status.local.state === 'pending') {
    return {
      label: 'Saving changes…',
      tone: 'pending',
      symbol: 'saving',
    };
  }

  if (status.server.state === 'confirmed') {
    return {
      label: 'Latest changes saved to server',
      tone: 'confirmed',
      symbol: 'server',
    };
  }

  if (status.server.state === 'pending') {
    return {
      label: 'Changes waiting to sync',
      tone: 'pending',
      symbol: 'waiting',
    };
  }

  if (vault.state === 'confirmed') {
    return {
      label: 'Latest changes backed up to Cloud Vault',
      tone: 'confirmed',
      symbol: 'vault',
    };
  }

  if (vault.state === 'pending') {
    return {
      label: 'Changes waiting for backup',
      tone: 'pending',
      symbol: 'waiting',
    };
  }

  if (status.server.state === 'unknown') {
    return {
      label: 'Server copy not confirmed',
      tone: 'neutral',
      symbol: 'server',
    };
  }

  return {
    label:
      status.local.state === 'confirmed'
        ? 'Saved on this device'
        : status.local.state === 'unavailable'
          ? 'Local storage unavailable'
          : 'Local copy not confirmed',
    tone: 'neutral',
    symbol: 'device',
  };
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
