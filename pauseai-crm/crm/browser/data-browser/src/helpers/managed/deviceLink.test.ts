import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  approvalUrl,
  awaitDeviceLink,
  isDeviceLinked,
  pollDeviceLink,
  requestDeviceLink,
  unlinkDevice,
  type LinkRequest,
} from './deviceLink';
import {
  getManagedApiBase,
  getManagedDeviceToken,
  getRememberedManagedPortalUrl,
  setManagedDeviceToken,
} from './api';

// The case that matters here is the one with no origin to fall back on. A
// browser on the provider's own site resolves `/api` same-origin and never
// depends on what linking remembered; the desktop and Android apps, on
// `tauri://localhost`, depend on it entirely.
const inTauri = { value: false };
vi.mock('../tauri', () => ({ isRunningInTauri: () => inTauri.value }));

const PORTAL = 'https://portal.example';

// The default vitest environment here is `node`, so there is no localStorage —
// the same stand-in `knownPeers.test.ts` uses. Without it every token read
// returns null through the module's own storage-disabled fallback, which would
// make these tests pass for the wrong reason.
function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();

  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;

  return store;
}

const request: LinkRequest = {
  device_code: 'dc-long-secret',
  user_code: 'K3F9-2XQP',
  expires_in: 600,
  interval: 0,
};

beforeEach(() => {
  installLocalStorage();
  setManagedDeviceToken(null);
  vi.restoreAllMocks();
});

afterEach(() => {
  setManagedDeviceToken(null);
});

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

describe('requestDeviceLink', () => {
  it('names this device, so the approver is not signing a blank cheque', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(request));

    await requestDeviceLink(PORTAL, 'Joep’s Pixel');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${PORTAL}/api/device-link`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      device_name: 'Joep’s Pixel',
    });
  });

  /** A throttled provider must not read as an unreachable one. */
  it('distinguishes rate limiting from an unreachable provider', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 429));
    await expect(requestDeviceLink(PORTAL)).rejects.toThrow(/Too many/);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 500));
    await expect(requestDeviceLink(PORTAL)).rejects.toThrow(
      /Check the address/,
    );
  });
});

describe('pollDeviceLink', () => {
  it('reads pending and approved', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ state: 'pending' }),
    );
    expect(await pollDeviceLink(PORTAL, 'dc')).toEqual({ state: 'pending' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ state: 'approved', token: 'sess' }),
    );
    expect(await pollDeviceLink(PORTAL, 'dc')).toEqual({
      state: 'approved',
      token: 'sess',
    });
  });

  /**
   * The provider answers 404 for unknown, expired and already-collected alike,
   * on purpose. The client must not invent a distinction it was denied.
   */
  it('treats a 404 as "start again" rather than an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(null, 404));
    expect(await pollDeviceLink(PORTAL, 'dc')).toEqual({ state: 'expired' });
  });
});

describe('awaitDeviceLink', () => {
  it('keeps the session once approved', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ state: 'pending' }))
      .mockResolvedValueOnce(
        jsonResponse({ state: 'approved', token: 'sess' }),
      );

    expect(await awaitDeviceLink(PORTAL, request)).toBe('linked');
    expect(getManagedDeviceToken()).toBe('sess');
    expect(isDeviceLinked()).toBe(true);
  });

  /**
   * A session is useless without knowing where to spend it. The desktop and
   * Android apps learn their control plane from nowhere else: `tauri://localhost`
   * has no same-origin `/api`, and their embedded node is not managed and names
   * no portal. Linking once stored this under a key `getManagedApiBase()` did
   * not read, so every managed call afterwards resolved against
   * `tauri.localhost/api` — the link looked fine and the vault simply never
   * appeared.
   */
  it('remembers the provider where the API base will look for it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ state: 'approved', token: 'sess' }),
    );

    inTauri.value = true;

    try {
      await awaitDeviceLink(PORTAL, request);

      expect(getRememberedManagedPortalUrl()).toBe(PORTAL);
      expect(getManagedApiBase()).toBe(`${PORTAL}/api`);
    } finally {
      inTauri.value = false;
    }
  });

  it('gives up when the provider says the code is gone', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(null, 404));

    expect(await awaitDeviceLink(PORTAL, request)).toBe('expired');
    expect(getManagedDeviceToken()).toBeNull();
  });

  /**
   * A user who navigates away must not leave a request polling for its full
   * ten minutes.
   */
  it('stops when aborted', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ state: 'pending' }));
    const controller = new AbortController();
    controller.abort();

    expect(
      await awaitDeviceLink(PORTAL, request, { signal: controller.signal }),
    ).toBe('expired');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** Nothing is stored until a provider actually says yes. */
  it('stores nothing while pending', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ state: 'pending' }),
    );

    await awaitDeviceLink(PORTAL, { ...request, expires_in: 0 });
    expect(getManagedDeviceToken()).toBeNull();
  });
});

describe('unlinkDevice', () => {
  it('forgets the session', () => {
    setManagedDeviceToken('sess');
    expect(isDeviceLinked()).toBe(true);

    unlinkDevice();
    expect(isDeviceLinked()).toBe(false);
    expect(getManagedDeviceToken()).toBeNull();
  });
});

describe('approvalUrl', () => {
  it('points at the provider’s own page, trailing slash or not', () => {
    expect(approvalUrl(PORTAL, 'K3F9-2XQP')).toBe(
      'https://portal.example/link?code=K3F9-2XQP',
    );
    expect(approvalUrl(`${PORTAL}/`, 'K3F9-2XQP')).toBe(
      'https://portal.example/link?code=K3F9-2XQP',
    );
  });
});
