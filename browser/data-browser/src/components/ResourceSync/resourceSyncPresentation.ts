import { persistenceCopyComplete } from '@tomic/lib';
import type {
  ResourcePeerSyncStatus,
  ResourceSaveState,
  ResourceSyncStatus,
} from '@tomic/react';

export type SyncTone =
  | 'neutral'
  | 'confirmed'
  | 'peer'
  | 'pending'
  | 'attention';
export type SyncSymbol =
  | 'device'
  | 'server'
  | 'vault'
  | 'peer'
  | 'waiting'
  | 'saving'
  | 'error';

export type ResourceVaultPresentationStatus = {
  state: 'unknown' | 'pending' | 'confirmed';
  confirmedAt?: number;
};

export type AttachmentCopyPresentationStatus = {
  storageId?: string;
  generation?: string;
  state:
    | 'confirmed'
    | 'pending'
    | 'unknown'
    | 'unavailable'
    | 'not-configured'
    | 'error';
  confirmedAt?: number;
};

export type ResourceAttachmentPresentationStatus = {
  required: boolean;
  local: AttachmentCopyPresentationStatus;
  server: AttachmentCopyPresentationStatus;
  vault: AttachmentCopyPresentationStatus;
  peers: readonly (AttachmentCopyPresentationStatus & {
    connectionId: string;
    storageId?: string;
    generation?: string;
  })[];
};

/** A metadata receipt from one peer cannot combine with bytes on another. */
export function peerHasConfirmedContents(
  peer: ResourcePeerSyncStatus['peers'][number],
  contents?: ResourceAttachmentPresentationStatus,
): boolean {
  if (!contents?.required) return true;

  return contents.peers.some(
    copy =>
      copy.connectionId === peer.connectionId &&
      copy.state === 'confirmed' &&
      !!copy.storageId &&
      copy.storageId === peer.storageId &&
      !!copy.generation &&
      copy.generation === peer.generation,
  );
}

export function completePeerCopyCount(
  peers: ResourcePeerSyncStatus,
  contents?: ResourceAttachmentPresentationStatus,
): number {
  if (!contents?.required) return peers.confirmedCount;
  const copies = new Set<string>();

  for (const peer of peers.peers) {
    if (peer.state === 'confirmed' && peerHasConfirmedContents(peer, contents))
      copies.add(JSON.stringify([peer.storageId, peer.generation]));
  }

  return copies.size;
}

export function attachmentCopyLabel(
  status: AttachmentCopyPresentationStatus,
): string {
  switch (status.state) {
    case 'confirmed':
      return 'File contents confirmed';
    case 'pending':
      return 'Checking file contents…';
    case 'error':
      return 'Could not confirm file contents';
    case 'unavailable':
      return 'File storage unavailable';
    default:
      return 'File contents not confirmed';
  }
}

/** Copy is deliberately based on receipts, never an idle queue or presence. */
export function resourceSyncPresentation(
  status: ResourceSyncStatus,
  save: ResourceSaveState,
  vault: ResourceVaultPresentationStatus = { state: 'unknown' },
  peers?: ResourcePeerSyncStatus,
  contents?: ResourceAttachmentPresentationStatus,
): { label: string; tone: SyncTone; symbol: SyncSymbol } {
  if (status.local.state === 'error') {
    return {
      label: 'Could not save on this device',
      tone: 'attention',
      symbol: 'error',
    };
  }

  if (contents?.required && contents.local.state === 'error') {
    return {
      label: 'Could not confirm file contents on this device',
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

  if (
    persistenceCopyComplete(
      status.server.stored ?? 'unknown',
      contents?.required ?? false,
      contents?.server.state,
      status.server,
      contents?.server,
    )
  ) {
    return {
      label: contents?.required
        ? 'Resource and file contents saved to server'
        : 'Latest changes saved to server',
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

  if (
    persistenceCopyComplete(
      vault.state,
      contents?.required ?? false,
      contents?.vault.state,
    )
  ) {
    return {
      label: contents?.required
        ? 'Resource and file contents backed up to Cloud Vault'
        : 'Latest changes backed up to Cloud Vault',
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

  if (
    peers?.state === 'confirmed' &&
    completePeerCopyCount(peers, contents) > 0
  ) {
    return {
      label: contents?.required
        ? 'Resource and file contents received by peers'
        : 'Latest changes received by peers',
      tone: 'peer',
      symbol: 'peer',
    };
  }

  if (peers?.state === 'pending') {
    return {
      label: 'Changes waiting for peers',
      tone: 'pending',
      symbol: 'waiting',
    };
  }

  if (contents?.required) {
    if (status.server.stored === 'confirmed') {
      return {
        label: 'Server file contents not confirmed',
        tone: contents.server.state === 'pending' ? 'pending' : 'neutral',
        symbol: 'server',
      };
    }

    if (vault.state === 'confirmed') {
      return {
        label: 'Cloud Vault file contents not confirmed',
        tone: contents.vault.state === 'pending' ? 'pending' : 'neutral',
        symbol: 'vault',
      };
    }

    if (peers?.state === 'confirmed') {
      return {
        label: 'Peer file copies not confirmed',
        tone: 'neutral',
        symbol: 'peer',
      };
    }

    if (status.server.state === 'not-configured') {
      return {
        label:
          status.local.state === 'confirmed' &&
          contents.local.state === 'confirmed'
            ? 'Resource and file contents saved on this device'
            : attachmentCopyLabel(contents.local),
        tone: contents.local.state === 'error' ? 'attention' : 'neutral',
        symbol: 'device',
      };
    }
  }

  if (
    status.server.state !== 'not-configured' &&
    status.server.stored !== 'confirmed'
  ) {
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
