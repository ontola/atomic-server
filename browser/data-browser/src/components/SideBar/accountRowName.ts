/**
 * What the account row calls an identity that has no profile name. "Signed
 * in" is only true when an account session exists or this identity is saved
 * to an account; anything else is a guest, also with no portal to ask.
 */
export function fallbackAccountName({
  loading,
  hasAccount,
  linked,
}: {
  loading: boolean;
  hasAccount: boolean | undefined;
  linked: boolean;
}): string {
  if (loading) return '';

  return hasAccount === true || linked ? 'Signed in' : 'Guest';
}
