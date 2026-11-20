// @wc-ignore-file
import { localCopyLabel, serverCopyLabel } from './resourceCopyLabels';
import type { ResourceSaveState, ResourceSyncStatus } from '@tomic/react';
import { describe, expect, it } from 'vitest';
import {
  resourceSyncPresentation,
  completePeerCopyCount,
  type ResourceAttachmentPresentationStatus,
} from './resourceSyncPresentation';

const idle: ResourceSaveState = {
  kind: 'idle',
  scheduledCount: 0,
  error: undefined,
  reason: undefined,
};
const confirmed: ResourceSyncStatus = {
  local: { state: 'confirmed', confirmedAt: 100 },
  server: {
    state: 'confirmed',
    stored: 'confirmed',
    storageId: 'server-store',
    generation: 'server-generation',
    url: 'https://studio.example',
    confirmedAt: 100,
  },
};

describe('resource sync presentation', () => {
  it('does not label transport acceptance as persistent server storage', () => {
    const accepted: ResourceSyncStatus = {
      local: { state: 'confirmed' },
      server: { state: 'confirmed', accepted: 'confirmed', stored: 'unknown' },
    };
    expect(resourceSyncPresentation(accepted, idle).tone).not.toBe('confirmed');
    expect(serverCopyLabel(accepted.server, idle)).toBe('Copy not confirmed');
  });

  it('does not turn an idle save queue into a confirmed remote copy', () => {
    const status: ResourceSyncStatus = {
      local: { state: 'confirmed' },
      server: { state: 'unknown', url: 'https://studio.example' },
    };
    expect(resourceSyncPresentation(status, idle)).toMatchObject({
      label: 'Server copy not confirmed',
      tone: 'neutral',
    });
    expect(serverCopyLabel(status.server, idle)).toBe('Copy not confirmed');
    expect(localCopyLabel(status.local)).toBe('Saved on this device');
  });

  it.each([
    ['dirty', 'Changes waiting to save'],
    ['scheduled', 'Changes waiting to save'],
    ['saving', 'Saving changes…'],
    ['queued', 'Changes waiting to sync'],
    ['error', 'Changes could not be saved'],
  ] as const)('does not let a receipt mask a newer %s save', (kind, label) => {
    const save: ResourceSaveState = { ...idle, kind };
    expect(resourceSyncPresentation(confirmed, save).label).toBe(label);
    expect(resourceSyncPresentation(confirmed, save).tone).not.toBe(
      'confirmed',
    );
    expect(serverCopyLabel(confirmed.server, save)).not.toBe(
      'Latest changes saved',
    );
  });

  it('keeps local persistence failure visible even if the server has the resource', () => {
    const status: ResourceSyncStatus = {
      ...confirmed,
      local: { state: 'error', error: 'Storage is full' },
    };
    expect(resourceSyncPresentation(status, idle)).toMatchObject({
      label: 'Could not save on this device',
      tone: 'attention',
    });
    expect(serverCopyLabel(status.server, idle)).toBe('Latest changes saved');
  });

  it('does not call a pending local write saved while the remote copy is current', () => {
    const status: ResourceSyncStatus = {
      ...confirmed,
      local: { state: 'pending' },
    };
    expect(resourceSyncPresentation(status, idle).tone).toBe('pending');
    expect(localCopyLabel(status.local)).toBe('Saving on this device…');
    expect(serverCopyLabel(status.server, idle)).toBe('Latest changes saved');
  });

  it('distinguishes intentional local-only storage from an unconfirmed server', () => {
    const status: ResourceSyncStatus = {
      local: { state: 'confirmed' },
      server: { state: 'not-configured' },
    };
    expect(resourceSyncPresentation(status, idle)).toEqual({
      label: 'Saved on this device',
      tone: 'neutral',
      symbol: 'device',
    });
    expect(serverCopyLabel(status.server, idle)).toBe('No server configured');
  });

  it('keeps unavailable and unconfirmed local storage separate', () => {
    expect(localCopyLabel({ state: 'unavailable' })).toBe(
      'Local storage unavailable',
    );
    expect(localCopyLabel({ state: 'unknown' })).toBe(
      'Local copy not confirmed',
    );
  });
});

describe('attachment confirmation presentation', () => {
  const contents: ResourceAttachmentPresentationStatus = {
    required: true,
    local: { state: 'confirmed' },
    server: { state: 'unknown' },
    vault: { state: 'unknown' },
    peers: [],
  };
  const peer = {
    state: 'confirmed' as const,
    confirmedCount: 1,
    connectedCount: 1,
    peers: [
      {
        connectionId: 'a',
        peerAgent: 'agent',
        storageId: 'store-a',
        generation: '1',
        state: 'confirmed' as const,
      },
    ],
  };

  it('does not turn metadata-only confirmation into a complete file copy', () => {
    expect(
      resourceSyncPresentation(confirmed, idle, undefined, undefined, contents),
    ).toMatchObject({
      label: 'Server file contents not confirmed',
      tone: 'neutral',
    });
    expect(
      resourceSyncPresentation(confirmed, idle, undefined, undefined, {
        ...contents,
        server: {
          state: 'confirmed',
          storageId: 'server-store',
          generation: 'server-generation',
        },
      }),
    ).toMatchObject({
      label: 'Resource and file contents saved to server',
      tone: 'confirmed',
    });
  });

  it('selects a complete Vault copy when only metadata is confirmed on the server', () => {
    expect(
      resourceSyncPresentation(
        confirmed,
        idle,
        { state: 'confirmed' },
        undefined,
        {
          ...contents,
          vault: { state: 'confirmed' },
        },
      ),
    ).toMatchObject({ symbol: 'vault', tone: 'confirmed' });
  });

  it('cannot combine peer metadata with another connection, storage identity or generation', () => {
    for (const other of [
      { connectionId: 'b', storageId: 'store-a', generation: '1' },
      { connectionId: 'a', storageId: 'store-b', generation: '1' },
      { connectionId: 'a', storageId: 'store-a', generation: '2' },
      { connectionId: 'a' },
    ]) {
      expect(
        completePeerCopyCount(peer, {
          ...contents,
          peers: [{ ...other, state: 'confirmed' }],
        }),
      ).toBe(0);
    }

    expect(
      completePeerCopyCount(peer, { ...contents, peers: peer.peers }),
    ).toBe(1);
  });

  it('counts shared storage once and requires current metadata as well as bytes', () => {
    const shared = {
      ...peer,
      confirmedCount: 1,
      peers: [peer.peers[0], { ...peer.peers[0], connectionId: 'b' }],
    };
    expect(
      completePeerCopyCount(shared, { ...contents, peers: shared.peers }),
    ).toBe(1);
    expect(
      completePeerCopyCount(
        {
          ...shared,
          peers: shared.peers.map(copy => ({ ...copy, state: 'pending' })),
        },
        {
          ...contents,
          peers: shared.peers,
        },
      ),
    ).toBe(0);
  });

  it('keeps unsaved metadata visible even while contents are confirmed', () => {
    expect(
      resourceSyncPresentation(
        confirmed,
        { ...idle, kind: 'dirty' },
        undefined,
        undefined,
        {
          ...contents,
          server: {
            state: 'confirmed',
            storageId: 'server-store',
            generation: 'server-generation',
          },
        },
      ),
    ).toMatchObject({ label: 'Changes waiting to save', tone: 'pending' });
  });

  it('keeps a local contents failure visible even with a complete server copy', () => {
    expect(
      resourceSyncPresentation(confirmed, idle, undefined, undefined, {
        ...contents,
        local: { state: 'error' },
        server: {
          state: 'confirmed',
          storageId: 'server-store',
          generation: 'server-generation',
        },
      }),
    ).toMatchObject({
      label: 'Could not confirm file contents on this device',
      tone: 'attention',
    });
  });
});

describe('resource vault sync presentation', () => {
  it('shows proven vault backup when no current server copy is confirmed', () => {
    for (const state of ['unknown', 'not-configured'] as const) {
      expect(
        resourceSyncPresentation({ ...confirmed, server: { state } }, idle, {
          state: 'confirmed',
        }),
      ).toEqual({
        label: 'Latest changes backed up to Cloud Vault',
        tone: 'confirmed',
        symbol: 'vault',
      });
    }
  });

  it('retains the server indicator when both destinations have the current version', () => {
    expect(
      resourceSyncPresentation(confirmed, idle, { state: 'confirmed' }),
    ).toMatchObject({
      label: 'Latest changes saved to server',
      symbol: 'server',
      tone: 'confirmed',
    });
  });

  it('does not let backup proof hide pending server changes or unsaved edits', () => {
    expect(
      resourceSyncPresentation(
        { ...confirmed, server: { state: 'pending' } },
        idle,
        { state: 'confirmed' },
      ),
    ).toMatchObject({ label: 'Changes waiting to sync', tone: 'pending' });

    for (const kind of [
      'dirty',
      'scheduled',
      'saving',
      'queued',
      'error',
    ] as const) {
      expect(
        resourceSyncPresentation(
          confirmed,
          { ...idle, kind },
          { state: 'confirmed' },
        ),
      ).toEqual(resourceSyncPresentation(confirmed, { ...idle, kind }));
    }
  });

  it('keeps a local write failure visible even when the vault has the resource', () => {
    expect(
      resourceSyncPresentation(
        { ...confirmed, local: { state: 'error', error: 'Disk full' } },
        idle,
        { state: 'confirmed' },
      ),
    ).toMatchObject({
      label: 'Could not save on this device',
      tone: 'attention',
    });
  });

  it('uses pending vault proof as a fallback without hiding a confirmed server', () => {
    expect(
      resourceSyncPresentation(
        { ...confirmed, server: { state: 'unknown' } },
        idle,
        { state: 'pending' },
      ),
    ).toMatchObject({ label: 'Changes waiting for backup', tone: 'pending' });
    expect(
      resourceSyncPresentation(confirmed, idle, { state: 'pending' }),
    ).toMatchObject({
      label: 'Latest changes saved to server',
      symbol: 'server',
    });
  });
});

describe('resource peer sync presentation', () => {
  const localOnly: ResourceSyncStatus = {
    local: { state: 'confirmed' },
    server: { state: 'not-configured' },
  };
  const vault = { state: 'unknown' as const };
  const peer = {
    state: 'confirmed' as const,
    connectedCount: 1,
    confirmedCount: 1,
    peers: [],
  };

  it('gives exact browser proof its own colour and icon for otherwise unconfirmed remote copies', () => {
    for (const serverState of ['not-configured', 'unknown'] as const) {
      expect(
        resourceSyncPresentation(
          { ...localOnly, server: { state: serverState } },
          idle,
          vault,
          peer,
        ),
      ).toEqual({
        label: 'Latest changes received by peers',
        tone: 'peer',
        symbol: 'peer',
      });
    }
  });

  it('does not equate connected browsers with confirmed resource copies', () => {
    expect(
      resourceSyncPresentation(localOnly, idle, vault, {
        ...peer,
        state: 'unknown',
        connectedCount: 2,
        confirmedCount: 0,
      }),
    ).toEqual(resourceSyncPresentation(localOnly, idle));
    expect(
      resourceSyncPresentation(localOnly, idle, vault, {
        ...peer,
        state: 'pending',
        confirmedCount: 0,
      }),
    ).toMatchObject({ label: 'Changes waiting for peers', tone: 'pending' });
  });

  it('preserves server and vault confirmation ahead of temporary browser copies', () => {
    expect(resourceSyncPresentation(confirmed, idle, vault, peer)).toEqual(
      resourceSyncPresentation(confirmed, idle, vault),
    );
    expect(
      resourceSyncPresentation(localOnly, idle, { state: 'confirmed' }, peer),
    ).toEqual(
      resourceSyncPresentation(localOnly, idle, { state: 'confirmed' }),
    );
  });

  it('keeps outstanding local/server/backup work and failures ahead of browser confirmation', () => {
    for (const kind of [
      'dirty',
      'scheduled',
      'saving',
      'queued',
      'error',
    ] as const) {
      expect(
        resourceSyncPresentation(localOnly, { ...idle, kind }, vault, peer),
      ).toEqual(resourceSyncPresentation(localOnly, { ...idle, kind }, vault));
    }

    for (const local of [
      { state: 'pending' as const },
      { state: 'error' as const, error: 'Disk full' },
    ]) {
      expect(
        resourceSyncPresentation({ ...localOnly, local }, idle, vault, peer),
      ).toEqual(resourceSyncPresentation({ ...localOnly, local }, idle, vault));
    }

    expect(
      resourceSyncPresentation(
        { ...localOnly, server: { state: 'pending' } },
        idle,
        vault,
        peer,
      ),
    ).toMatchObject({ label: 'Changes waiting to sync', tone: 'pending' });
    expect(
      resourceSyncPresentation(localOnly, idle, { state: 'pending' }, peer),
    ).toMatchObject({ label: 'Changes waiting for backup', tone: 'pending' });
  });
});
