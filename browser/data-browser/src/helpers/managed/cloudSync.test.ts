import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  getManagedPortalUrl,
  isCloudSyncAvailable,
  enableCloudSyncForDrive,
} from './cloudSync';

// These run in the node environment (no `window`), so the localhost dev
// fallback can't be exercised here — it's covered by the app at runtime. What's
// asserted is the deterministic precedence: an advertised portal wins, and with
// nothing to resolve to the answer is null (→ CTA hidden).

describe('getManagedPortalUrl', () => {
  it('uses the connected node’s advertised portal', () => {
    expect(
      getManagedPortalUrl({ managed: true, portalUrl: 'https://portal.example' }),
    ).toBe('https://portal.example');
  });

  it('is null when no portal is known (pure self-hosted / no window)', () => {
    expect(getManagedPortalUrl({ managed: false, portalUrl: null })).toBeNull();
  });
});

describe('isCloudSyncAvailable', () => {
  it('true when a portal resolves, false otherwise', () => {
    expect(
      isCloudSyncAvailable({ managed: true, portalUrl: 'https://portal.example' }),
    ).toBe(true);
    expect(isCloudSyncAvailable({ managed: false, portalUrl: null })).toBe(false);
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
