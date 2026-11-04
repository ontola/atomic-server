/** The account key is an opaque `acct_<id>` on newer accounts: never a label. */
const isShowableAddress = (value: string | undefined): value is string =>
  !!value && !value.startsWith('acct_');

/**
 * What the account row calls an identity that has no profile name. A linked
 * identity (account session, or saved to an account) shows the account's
 * address, or a neutral "Account" when none is known; anything else is a
 * guest, also with no portal to ask.
 */
export function fallbackAccountName({
  loading,
  hasAccount,
  linked,
  email,
}: {
  loading: boolean;
  hasAccount: boolean | undefined;
  linked: boolean;
  /** The account's address, if known. An `acct_` id is ignored. */
  email?: string;
}): string {
  if (loading) return '';

  if (hasAccount === true || linked) {
    return isShowableAddress(email) ? email : 'Account';
  }

  return 'Guest';
}

/** The first of these that is an address worth showing. */
export function pickAccountAddress(
  ...candidates: Array<string | undefined>
): string | undefined {
  return candidates.find(isShowableAddress);
}
