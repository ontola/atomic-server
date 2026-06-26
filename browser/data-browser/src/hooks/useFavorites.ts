import { urls } from '@tomic/react';
import { usePersonalDriveList } from './usePersonalDriveList';

/**
 * The user's favorited resources — a curated quick-access list of ANY
 * resources (on any drive). Stored as the `favorites` ResourceArray on the
 * user's PRIVATE DRIVE (home index), not on the Agent. See
 * {@link usePersonalDriveList}.
 */
export function useFavorites(): [
  favorites: string[],
  add: (subject: string) => void,
  remove: (subject: string) => void,
] {
  return usePersonalDriveList(urls.properties.favorites);
}
