import type {
  Copy,
  PeerCopy,
  ResourceCopies,
  ResourceSaveState,
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

/** A metadata receipt from one peer cannot combine with bytes on another. */
export function peerHasConfirmedContents(
  peer: PeerCopy,
  required: boolean,
): boolean {
  return (
    !required ||
    (peer.contents.state === 'confirmed' &&
      !!peer.storageId &&
      !!peer.generation)
  );
}

export function completePeerCopyCount({
  peers,
  required,
}: ResourceCopies): number {
  if (!required) return peers.confirmedCount;
  const copies = new Set<string>();

  for (const peer of peers.peers) {
    if (peer.state === 'confirmed' && peerHasConfirmedContents(peer, required))
      copies.add(JSON.stringify([peer.storageId, peer.generation]));
  }

  return copies.size;
}

export function attachmentCopyLabel(status: Copy): string {
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
  copies: ResourceCopies,
  save: ResourceSaveState,
): { label: string; tone: SyncTone; symbol: SyncSymbol } {
  const { local, server, vault, peers, required } = copies;

  if (local.state === 'error') {
    return {
      label: 'Could not save on this device',
      tone: 'attention',
      symbol: 'error',
    };
  }

  if (required && local.contents.state === 'error') {
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

  if (save.kind === 'saving' || local.state === 'pending') {
    return {
      label: 'Saving changes…',
      tone: 'pending',
      symbol: 'saving',
    };
  }

  if (
    server.state === 'confirmed' &&
    (!required || server.contents.state === 'confirmed')
  ) {
    return {
      label: required
        ? 'Resource and file contents saved to server'
        : 'Latest changes saved to server',
      tone: 'confirmed',
      symbol: 'server',
    };
  }

  if (server.state === 'pending') {
    return {
      label: 'Changes waiting to sync',
      tone: 'pending',
      symbol: 'waiting',
    };
  }

  if (
    vault.state === 'confirmed' &&
    (!required || vault.contents.state === 'confirmed')
  ) {
    return {
      label: required
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

  if (peers.state === 'confirmed' && completePeerCopyCount(copies) > 0) {
    return {
      label: required
        ? 'Resource and file contents received by peers'
        : 'Latest changes received by peers',
      tone: 'peer',
      symbol: 'peer',
    };
  }

  if (peers.state === 'pending') {
    return {
      label: 'Changes waiting for peers',
      tone: 'pending',
      symbol: 'waiting',
    };
  }

  if (required) {
    if (server.state === 'confirmed') {
      return {
        label: 'Server file contents not confirmed',
        tone: server.contents.state === 'pending' ? 'pending' : 'neutral',
        symbol: 'server',
      };
    }

    if (vault.state === 'confirmed') {
      return {
        label: 'Cloud Vault file contents not confirmed',
        tone: vault.contents.state === 'pending' ? 'pending' : 'neutral',
        symbol: 'vault',
      };
    }

    if (peers.state === 'confirmed') {
      return {
        label: 'Peer file copies not confirmed',
        tone: 'neutral',
        symbol: 'peer',
      };
    }

    if (server.state === 'not-configured') {
      return {
        label:
          local.state === 'confirmed' && local.contents.state === 'confirmed'
            ? 'Resource and file contents saved on this device'
            : attachmentCopyLabel(local.contents),
        tone: local.contents.state === 'error' ? 'attention' : 'neutral',
        symbol: 'device',
      };
    }
  }

  if (server.state === 'unknown') {
    return {
      label: 'Server copy not confirmed',
      tone: 'neutral',
      symbol: 'server',
    };
  }

  return {
    label:
      local.state === 'confirmed'
        ? 'Saved on this device'
        : local.state === 'unavailable'
          ? 'Local storage unavailable'
          : 'Local copy not confirmed',
    tone: 'neutral',
    symbol: 'device',
  };
}
