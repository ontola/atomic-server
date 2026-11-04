import { useCallback } from 'react';
import { canonicalizeScheme } from '@tomic/lib';
import { useSettings } from '../helpers/AppSettings';
import { useLocalStorage } from './useLocalStorage';

/** Per agent, so one identity does not see the drives another one visited. */
export const driveVisitsKey = (agent?: string) => `driveVisits:${agent}`;

/** The key from before visits were per agent. Its owner is unknown, so it is
 * dropped, not migrated. */
try {
  window.localStorage.removeItem('driveVisits');
} catch {
  /* Storage unavailable: there is nothing to remove. */
}

const EMPTY: Record<string, number> = {};

/** Last visit time (ms) per drive, keyed by canonical subject. */
export function useDriveVisits(): [
  driveVisits: Record<string, number>,
  recordVisit: (subject: string) => void,
] {
  const { agent } = useSettings();
  const agentSubject = agent?.subject;
  // Without an agent nothing is shown and nothing is written.
  const [stored, setDriveVisits] = useLocalStorage<Record<string, number>>(
    driveVisitsKey(agentSubject),
    EMPTY,
  );
  const driveVisits = agentSubject ? stored : EMPTY;

  const recordVisit = useCallback(
    (subject: string) => {
      if (!agentSubject) {
        return;
      }

      setDriveVisits(prev => ({
        ...prev,
        [canonicalizeScheme(subject)]: Date.now(),
      }));
    },
    [setDriveVisits, agentSubject],
  );

  return [driveVisits, recordVisit];
}
