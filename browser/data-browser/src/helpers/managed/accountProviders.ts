import { managedFetch } from './api';

export type AccountProviders = {
  /** "Continue with Google" is configured on the account service. */
  google: boolean;
  /** Signing in to the account is enough to unlock the identity. */
  assisted_recovery: boolean;
};

const NONE: AccountProviders = { google: false, assisted_recovery: false };
let pending: Promise<AccountProviders> | null = null;

/** What the account service offers, read once per page. */
export function getAccountProviders(): Promise<AccountProviders> {
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
