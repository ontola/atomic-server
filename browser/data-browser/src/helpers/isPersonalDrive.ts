/**
 * Whether a subject is the agent's own home drive.
 *
 * Kept apart from the hook that feeds it so it can be read and tested on its
 * own — importing the hook pulls in the provider tree, and this is a
 * comparison of two strings.
 *
 * While the answer is still unknown it says no rather than maybe. A title that
 * is briefly uneditable, or a warning that appears on an ordinary drive and
 * then vanishes, teaches people to ignore both.
 */
export function isPersonalDrive(
  subject: string | undefined,
  personalDrive: string | undefined,
  loading: boolean,
): boolean {
  if (loading || !personalDrive || !subject) {
    return false;
  }

  return subject === personalDrive;
}
