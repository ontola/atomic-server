/**
 * Whether a subject is the agent's own home drive.
 *
 * ## Two words on purpose
 *
 * Users read **private drive**, everywhere, with no second name for it — a
 * person who meets "personal drive" in one screen and "private drive" in
 * another has to work out whether they are the same thing.
 *
 * The code says **personal**, because the data does: an Agent carries
 * `https://atomicdata.dev/properties/personalDrive`, and stored property
 * subjects are not renamed to match a label. Aligning the code to the UI would
 * be a migration paid by every existing account for no visible gain.
 *
 * So: `personalDrive` in identifiers and property names, "private drive" in
 * anything a user reads. Not an oversight — please leave it.
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
