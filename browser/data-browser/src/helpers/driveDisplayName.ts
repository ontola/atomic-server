/** What a drive is called when its resource has no name on this device. */
export const UNNAMED_DRIVE = 'Drive';

/** What new personal drives were stored as, before they carried no name. */
const OLD_PERSONAL_DRIVE_NAME = 'My drive';

/**
 * The personal drive was stored as "My drive" by default. Show the name people
 * know it by instead; a name the owner chose is returned untouched.
 */
export function personalDriveName(
  name: string | undefined | null,
  personalLabel: string,
): string | undefined | null {
  return !name || name === OLD_PERSONAL_DRIVE_NAME ? personalLabel : name;
}

/**
 * A drive's name for display. A drive this device holds no copy of has no name
 * to read, and its subject (`atomic:W2Q3m…`, `did:ad:…`) is an identifier, not
 * something to put in a title bar or a switcher; a plain label reads better.
 * An ordinary http(s) subject is kept: that is a server's own address.
 */
export function driveDisplayName(
  name: string | undefined | null,
  subject: string,
): string {
  if (name) return name;

  return /^(atomic|did):/.test(subject) ? UNNAMED_DRIVE : subject;
}
