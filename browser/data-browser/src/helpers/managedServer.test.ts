import { describe, it, expect } from 'vitest';
import { accountCreationTarget, type ManagedInfo } from './managedServer';

describe('accountCreationTarget', () => {
  it('managed node with a portal URL → the managed portal', () => {
    const info: ManagedInfo = {
      managed: true,
      portalUrl: 'https://portal.example/',
    };

    expect(accountCreationTarget(info)).toEqual({
      kind: 'portal',
      url: 'https://portal.example/',
    });
  });

  it('self-hosted / FOSS node → local identity (keeps the FOSS UX)', () => {
    expect(
      accountCreationTarget({ managed: false, portalUrl: null }),
    ).toEqual({ kind: 'local' });
  });

  it('managed but without a portal URL → local (no portal to send to)', () => {
    expect(
      accountCreationTarget({ managed: true, portalUrl: null }),
    ).toEqual({ kind: 'local' });
  });

  it('a portal URL present but not managed → local', () => {
    expect(
      accountCreationTarget({
        managed: false,
        portalUrl: 'https://portal.example/',
      }),
    ).toEqual({ kind: 'local' });
  });
});
