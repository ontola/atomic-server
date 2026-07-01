import { describe, it, expect } from 'vitest';
import { accountCreationTarget, type ManagedInfo } from './managedServer';

describe('accountCreationTarget', () => {
  it('managed node with a dashboard URL → the cloud portal', () => {
    const info: ManagedInfo = {
      managed: true,
      dashboardUrl: 'https://portal.example/',
    };

    expect(accountCreationTarget(info)).toEqual({
      kind: 'portal',
      url: 'https://portal.example/',
    });
  });

  it('self-hosted / FOSS node → local identity (keeps the FOSS UX)', () => {
    expect(
      accountCreationTarget({ managed: false, dashboardUrl: null }),
    ).toEqual({ kind: 'local' });
  });

  it('managed but without a dashboard URL → local (no portal to send to)', () => {
    expect(
      accountCreationTarget({ managed: true, dashboardUrl: null }),
    ).toEqual({ kind: 'local' });
  });

  it('a dashboard URL present but not managed → local', () => {
    expect(
      accountCreationTarget({
        managed: false,
        dashboardUrl: 'https://portal.example/',
      }),
    ).toEqual({ kind: 'local' });
  });
});
