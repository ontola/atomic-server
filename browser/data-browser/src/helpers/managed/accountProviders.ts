import { hasManagedApi, managedFetch } from './api';

export type AccountProviders = {
  /** "Continue with Google" is configured on the account service. */
  google: boolean;
  /** Signing in to the account is enough to unlock the identity. */
  assisted_recovery: boolean;
};

const NONE: AccountProviders = { google: false, assisted_recovery: false };
let pending: Promise<AccountProviders> | null = null;

/**
 * What the account service offers, read once per page. A build that knows no
 * account service (the FOSS release, a self-hosted node) asks nobody and gets
 * nothing, so it never depends on atomic.place.
 */
export function getAccountProviders(): Promise<AccountProviders> {
  if (!hasManagedApi()) return Promise.resolve(NONE);
  pending ??= managedFetch('/auth/providers')
    .then(res => (res.ok ? res.json() : NONE))
    .then((body: Partial<AccountProviders>) => ({
      google: body?.google === true,
      assisted_recovery: body?.assisted_recovery === true,
    }))
    .catch(() => {
      // Not cached: a network blip must not switch these off for the rest of
      // the page's life.
      pending = null;

      return NONE;
    });

  return pending;
}

/**
 * Where "Continue with Google" starts, on the account service, returning to
 * `returnTo` (this page) once signed in.
 */
export function googleSignInUrl(portalUrl: string, returnTo: string): string {
  const start = new URL('/api/auth/google/start', portalUrl);
  start.searchParams.set('next', returnTo);

  return start.toString();
}

/**
 * Email a sign-in link, the same one the portal sends. The link opens on the
 * portal; this page notices the session through the shared cookie. Returns
 * the link itself where the service hands it out (local development).
 */
export async function sendAccountEmailLink(
  email: string,
): Promise<string | null> {
  const res = await managedFetch('/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.trim() }),
  });
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(
      typeof body?.error === 'string'
        ? body.error
        : 'Could not send the sign-in link. Try again.',
    );
  }

  return typeof body?.magic_link === 'string' ? body.magic_link : null;
}
