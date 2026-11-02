/**
 * Whether a subject is the agent's own home drive.
 *
 * ## Names
 *
 * Users read **personal drive**, everywhere. Identifiers here say
 * `privateDrive` and stored property subjects are not renamed to match a
 * label, so those stay. Anything a user reads about their own home drive says
 * "personal".
 *
 * Kept apart from the hook that feeds it so it can be read and tested on its
 * own — importing the hook pulls in the provider tree, and this is a
 * comparison of two strings.
 *
 * While the answer is still unknown it says no rather than maybe. A title that
 * is briefly uneditable, or a warning that appears on an ordinary drive and
 * then vanishes, teaches people to ignore both.
 */
export function isPrivateDrive(
  subject: string | undefined,
  privateDrive: string | undefined,
  loading: boolean,
): boolean {
  if (loading || !privateDrive || !subject) {
    return false;
  }

  return subject === privateDrive;
}
