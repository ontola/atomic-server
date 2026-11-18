// @wc-ignore-file
import type { ResourceSaveState, ResourceSyncStatus } from '@tomic/react';
import { describe, expect, it } from 'vitest';
import {
  localCopyLabel,
  resourceSyncPresentation,
  serverCopyLabel,
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
    url: 'https://studio.example',
    confirmedAt: 100,
  },
};

describe('resource sync presentation', () => {
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
