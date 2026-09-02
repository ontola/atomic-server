import { useCallback } from 'react';
import { useLocalStorage } from './useLocalStorage';

const KEY = 'atomic.comments.lastSeen';

type LastSeenMap = Record<string, number>;

/**
 * Device-local record of how many comments on a resource the user has seen,
 * keyed by the commented resource's subject. Not synced across devices.
 *
 * Returns the last seen count (undefined if the thread was never opened) and
 * a function to mark the current count as seen.
 */
export function useLastSeenComments(
  chatSubject: string | undefined,
): [lastSeen: number | undefined, markSeen: (count: number) => void] {
  const [map, setMap] = useLocalStorage<LastSeenMap>(KEY, {});

  const markSeen = useCallback(
    (count: number) => {
      if (!chatSubject) {
        return;
      }

      setMap(prev =>
        prev[chatSubject] === count ? prev : { ...prev, [chatSubject]: count },
      );
    },
    [chatSubject, setMap],
  );

  return [chatSubject ? map[chatSubject] : undefined, markSeen];
}
