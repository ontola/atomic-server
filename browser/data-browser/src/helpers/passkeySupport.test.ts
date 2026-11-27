import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceCanUsePasskeys, hasPasskeyApi } from './passkeySupport';

afterEach(() => vi.unstubAllGlobals());

describe('passkey API availability', () => {
  it('rejects embedded browsers without PublicKeyCredential', () => {
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', { credentials: { create() {}, get() {} } });
    expect(hasPasskeyApi()).toBe(false);
  });

  it('requires both credential operations and a secure context', () => {
    vi.stubGlobal('window', {
      isSecureContext: true,
      PublicKeyCredential: class {},
    });
    vi.stubGlobal('navigator', { credentials: { get() {} } });
    expect(hasPasskeyApi()).toBe(false);
    vi.stubGlobal('navigator', { credentials: { create() {}, get() {} } });
    expect(hasPasskeyApi()).toBe(true);
    vi.stubGlobal('window', {
      isSecureContext: false,
      PublicKeyCredential: class {},
    });
    expect(hasPasskeyApi()).toBe(false);
  });

  it('rejects Android WebViews, which freeze the app on use', () => {
    vi.stubGlobal('window', {
      isSecureContext: true,
      PublicKeyCredential: class {},
    });
    const credentials = { create() {}, get() {} };
    const chrome = 'Mozilla/5.0 (Linux; Android 14; Pixel 8';
    vi.stubGlobal('navigator', {
      credentials,
      userAgent: `${chrome}; wv) AppleWebKit/537.36 Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36`,
    });
    expect(hasPasskeyApi()).toBe(false);
    vi.stubGlobal('navigator', {
      credentials,
      userAgent: `${chrome}) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36`,
    });
    expect(hasPasskeyApi()).toBe(true);
  });
});

describe('a device that can use passkeys', () => {
  const withApi = (api: Record<string, unknown>) => {
    vi.stubGlobal('window', {
      isSecureContext: true,
      PublicKeyCredential: Object.assign(function () {}, api),
    });
    vi.stubGlobal('navigator', { credentials: { create() {}, get() {} } });
  };

  it('is no without the API', async () => {
    vi.stubGlobal('window', { isSecureContext: true });
    expect(await deviceCanUsePasskeys()).toBe(false);
  });

  it('follows the client capabilities when the browser reports them', async () => {
    withApi({
      getClientCapabilities: async () => ({
        passkeyPlatformAuthenticator: true,
      }),
    });
    expect(await deviceCanUsePasskeys()).toBe(true);
    withApi({
      getClientCapabilities: async () => ({
        passkeyPlatformAuthenticator: false,
        hybridTransport: false,
      }),
    });
    expect(await deviceCanUsePasskeys()).toBe(false);
  });

  it('falls back to the platform authenticator probes', async () => {
    withApi({
      isUserVerifyingPlatformAuthenticatorAvailable: async () => false,
      isConditionalMediationAvailable: async () => false,
    });
    expect(await deviceCanUsePasskeys()).toBe(false);
    withApi({
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
    });
    expect(await deviceCanUsePasskeys()).toBe(true);
  });

  it('keeps the button when the browser cannot answer', async () => {
    withApi({});
    expect(await deviceCanUsePasskeys()).toBe(true);
    withApi({
      getClientCapabilities: async () => {
        throw new Error('unavailable');
      },
    });
    expect(await deviceCanUsePasskeys()).toBe(true);
  });
});
