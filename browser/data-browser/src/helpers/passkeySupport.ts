/** API availability only; this does not promise that a credential provider
 * supports passkeys or the PRF extension used for encrypted recovery. */
export function hasPasskeyApi(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function'
  );
}

type ClientCapabilities = Record<string, boolean | undefined>;

type PasskeyCredentialApi = {
  getClientCapabilities?: () => Promise<ClientCapabilities>;
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
  isConditionalMediationAvailable?: () => Promise<boolean>;
};

/**
 * Whether this device has something to sign in with, beyond the API being
 * there. Some mobile browsers expose WebAuthn with no authenticator behind
 * it (no screen lock, no passkey provider, no phone as key), where a
 * passkey button only leads to an error. Callers hide it on `false`.
 * A question the browser cannot answer counts as yes, so a browser we
 * cannot read keeps the button rather than losing passkeys it may have.
 * The portal asks the same question of the same browser.
 */
export async function deviceCanUsePasskeys(): Promise<boolean> {
  if (!hasPasskeyApi()) return false;

  const api = window.PublicKeyCredential as unknown as PasskeyCredentialApi;

  try {
    const capabilities = await api.getClientCapabilities?.();

    if (capabilities) {
      if (
        capabilities.passkeyPlatformAuthenticator ||
        capabilities.hybridTransport ||
        capabilities.conditionalGet
      ) {
        return true;
      }

      if (
        'passkeyPlatformAuthenticator' in capabilities ||
        'hybridTransport' in capabilities
      ) {
        return false;
      }
    }

    if (
      !api.isUserVerifyingPlatformAuthenticatorAvailable &&
      !api.isConditionalMediationAvailable
    ) {
      return true;
    }

    const [platform, conditional] = await Promise.all([
      api.isUserVerifyingPlatformAuthenticatorAvailable?.().catch(() => false),
      api.isConditionalMediationAvailable?.().catch(() => false),
    ]);

    return Boolean(platform || conditional);
  } catch {
    return true;
  }
}
