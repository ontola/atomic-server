// @wc-ignore-file
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  portal: null as string | null,
  openExternal: vi.fn(async (_url: string) => undefined),
}));

vi.mock('./openExternal', () => ({ openExternal: state.openExternal }));
vi.mock('./managed/cloudSync', () => ({
  getManagedPortalUrl: () => state.portal,
}));
vi.mock('./managed/api', () => ({
  getRememberedManagedPortalUrl: () => null,
  safePortalUrl: (u: string | null) => u ?? undefined,
}));

const { openCloudServerSales } = await import('./openCloudServerSales');

describe('openCloudServerSales', () => {
  beforeEach(() => state.openExternal.mockClear());

  it('opens the portal sales page for the drive', async () => {
    state.portal = 'https://atomic.place/';
    expect(await openCloudServerSales('did:ad:d', 'My drive')).toBe(true);
    expect(state.openExternal).toHaveBeenCalledWith(
      'https://atomic.place/cloud-server?drive=did%3Aad%3Ad&name=My+drive',
    );
  });

  it('does nothing without a portal', async () => {
    state.portal = null;
    expect(await openCloudServerSales('did:ad:d')).toBe(false);
    expect(state.openExternal).not.toHaveBeenCalled();
  });
});
