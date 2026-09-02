import { urls } from '@tomic/react';
import { usePrivateDriveList } from './usePrivateDriveList';

/**
 * The user's favorited resources — a curated quick-access list of ANY
 * resources (on any drive). Stored as the `favorites` ResourceArray on the
 * user's PRIVATE DRIVE (home index), not on the Agent. See
 * {@link usePrivateDriveList}.
 */
export function useFavorites(): [
  favorites: string[],
  add: (subject: string) => void,
  remove: (subject: string) => void,
] {
  return usePrivateDriveList(urls.properties.favorites);
}
