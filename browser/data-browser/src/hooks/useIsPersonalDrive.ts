import { usePersonalDrive } from './usePersonalDrive';
import { isPersonalDrive } from '@helpers/isPersonalDrive';

/**
 * Whether this subject is the agent's own home drive.
 *
 * The personal drive is not an ordinary drive that happens to be yours. Its
 * subject is derived from the agent's public key, so there is exactly one and
 * it cannot be replaced; and it is where the app keeps the things that follow
 * a person rather than a project — the list of drives, favourites, shared-with-me,
 * notifications, AI chats.
 *
 * Treating it as a workspace is therefore a mistake the product should make
 * hard rather than merely allow: renaming it to "Q3 Launch" gives it a name
 * that lies, and sharing it hands over everything above.
 *
 * One hook so the rule has one home. Every surface that needs to hold the
 * personal drive apart asks this, rather than each re-deriving what "personal"
 * means and drifting.
 */
export function useIsPersonalDrive(subject: string | undefined): boolean {
  const { personalDrive, loading } = usePersonalDrive();

  return isPersonalDrive(subject, personalDrive, loading);
}
