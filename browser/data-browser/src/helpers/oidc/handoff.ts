// @wc-ignore-file
/**
 * Hands a recovered agent secret from the OIDC page to the sign-in flow.
 *
 * Held in memory only, taken exactly once, and never persisted: the secret is
 * written to device storage by the existing sign-in path, like a pasted one.
 */
let pending: string | null = null;

export function setOidcHandoff(secret: string): void {
  pending = secret;
}

export function takeOidcHandoff(): string | null {
  const secret = pending;
  pending = null;

  return secret;
}
