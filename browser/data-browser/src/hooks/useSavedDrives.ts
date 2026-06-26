import { urls } from '@tomic/react';
import { usePersonalDriveList } from './usePersonalDriveList';

/**
 * The user's saved drives (the drive-switcher list). Stored as the `drives`
 * ResourceArray on the user's PRIVATE DRIVE — the per-user home index — not on
 * the Agent. See {@link usePersonalDriveList}.
 */
export function useSavedDrives(): [
  savedDrives: string[],
  add: (drive: string) => void,
  remove: (drive: string) => void,
] {
  return usePersonalDriveList(urls.properties.drives);
}
