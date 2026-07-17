import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  getManagedPortalUrl,
  isCloudSyncAvailable,
  enableCloudSyncForDrive,
} from './cloudSync';

// The portal URL is node-driven (or an explicit build-time override) — never
// hardcoded — so a pure self-hosted node resolves to null and the CTA hides.

describe('getManagedPortalUrl', () => {
  it('uses the connected node’s advertised portal', () => {
    expect(
      getManagedPortalUrl({
        managed: true,
        portalUrl: 'https://portal.example',
      }),
    ).toBe('https://portal.example');
  });

  it('is null when the node advertises no portal (pure self-hosted)', () => {
    expect(getManagedPortalUrl({ managed: false, portalUrl: null })).toBeNull();
  });
});

describe('isCloudSyncAvailable', () => {
  it('true when a portal resolves, false otherwise', () => {
    expect(
      isCloudSyncAvailable({
        managed: true,
        portalUrl: 'https://portal.example',
      }),
    ).toBe(true);
    expect(isCloudSyncAvailable({ managed: false, portalUrl: null })).toBe(
      false,
    );
  });
});

describe('enableCloudSyncForDrive', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('bails to the portal (never throws) when there is no managed session', async () => {
    // GET /api/me → 401 means "no session".
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 401,
      ok: false,
    } as Response);

    const setServer = vi.fn();
    const store = {
      // Should never be touched on the no-account path.
      isLocalOnlyDrive: vi.fn(() => true),
      promoteLocalDrive: vi.fn(),
      getSyncStatus: vi.fn(() => ({ serverConnected: false })),
    };

    const result = await enableCloudSyncForDrive({
      store: store as never,
      drive: 'did:ad:somedrive',
      agentSubject: 'did:ad:agent:abc',
      setServer,
      managedInfo: { managed: true, portalUrl: 'https://portal.example' },
    });

    expect(result).toEqual({
      ok: false,
      reason: 'no-account',
      portalUrl: 'https://portal.example',
    });
    expect(setServer).not.toHaveBeenCalled();
    expect(store.promoteLocalDrive).not.toHaveBeenCalled();
  });
});
