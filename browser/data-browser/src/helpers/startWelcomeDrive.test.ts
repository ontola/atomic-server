// @wc-ignore-file
import { expect, it, vi } from 'vitest';
import type { Store } from '@tomic/react';

vi.mock('../chunks/Templates/instantiate', () => ({
  instantiateTemplate: vi.fn(async () => ({ subjects: { welcome: 'w' } })),
}));

import { startWelcomeDrive } from './startWelcomeDrive';

it('lands on the welcome drive without arming the title editor', async () => {
  const flagged = new Set<string>();
  const drive = { subject: 'did:ad:drive' };
  const store = {
    createDrive: vi.fn(async () => drive),
    isLocalOnlyDrive: () => true,
    notifyResourceManuallyCreated: vi.fn(async (r: { subject: string }) => {
      flagged.add(r.subject);
    }),
    // What EditableTitle calls when it mounts.
    consumeRecentlyCreated: (subject: string) => flagged.delete(subject),
    getResource: vi.fn(async () => ({ set: vi.fn(), save: vi.fn() })),
    getAgent: () => undefined,
  } as unknown as Store;

  await startWelcomeDrive(store, 'did:ad:personal');

  expect(store.notifyResourceManuallyCreated).toHaveBeenCalled();
  expect(store.consumeRecentlyCreated(drive.subject)).toBe(false);
});
