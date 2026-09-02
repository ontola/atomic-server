import { urls } from '@tomic/react';
import { usePrivateDriveList } from './usePrivateDriveList';

/**
 * The user's saved drives (the drive-switcher list). Stored as the `drives`
 * ResourceArray on the user's PRIVATE DRIVE — the per-user home index — not on
 * the Agent. See {@link usePrivateDriveList}.
 */
export function useSavedDrives(): [
  savedDrives: string[],
  add: (drive: string) => void,
  remove: (drive: string) => void,
] {
  return usePrivateDriveList(urls.properties.drives);
}
