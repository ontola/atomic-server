import { useCallback, useMemo } from 'react';
import { useSettings } from '../helpers/AppSettings';
import { useLocalStorage } from './useLocalStorage';

const MAX_DRIVE_HISTORY = 5;
const EMPTY: string[] = [];

/** Per agent: a browser can hold several identities, and one must not see the
 * drives another one opened. */
export const driveHistoryKey = (agent?: string) => `driveHistory:${agent}`;

/** The key used before history was per agent. Its owner is unknown, so it is
 * dropped, not migrated. */
const LEGACY_KEY = 'driveHistory';

try {
  window.localStorage.removeItem(LEGACY_KEY);
} catch {
  /* Storage unavailable: there is nothing to remove. */
}

export function useDriveHistory(
  filter: string[] = [],
  limit = Number.MAX_VALUE,
): [
  driveHistory: string[],
  addDriveToHistory: (drive: string) => void,
  removeFromHistory: (drive: string) => void,
] {
  const { agent } = useSettings();
  const agentSubject = agent?.subject;
  // Without an agent nothing is shown and nothing is written.
  const [stored, setDriveHistory] = useLocalStorage<string[]>(
    driveHistoryKey(agentSubject),
    EMPTY,
  );
  const driveHistory = agentSubject ? stored : EMPTY;

  const addDriveToHistory = useCallback(
    (drive: string) => {
      if (!agentSubject) {
        return;
      }

      setDriveHistory(prev => {
        if (prev[0] === drive) {
          return prev;
        }

        return [drive, ...prev.filter(d => d !== drive)].slice(
          0,
          MAX_DRIVE_HISTORY,
        );
      });
    },
    [setDriveHistory, agentSubject],
  );

  const removeFromHistory = useCallback(
    (drive: string) => {
      if (!agentSubject) {
        return;
      }

      setDriveHistory(prev => prev.filter(d => d !== drive));
    },
    [setDriveHistory, agentSubject],
  );

  const slicedAndFilteredHistory = useMemo(
    () => driveHistory.slice(0, limit).filter(d => !filter.includes(d)),
    [driveHistory, filter, limit],
  );

  return [slicedAndFilteredHistory, addDriveToHistory, removeFromHistory];
}
