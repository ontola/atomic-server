import { useStore } from '@tomic/react';
import { useEffect, useState } from 'react';
import { useSettings } from '../helpers/AppSettings';
import { fetchPersonalDriveSubject } from '../helpers/personalDrive';

/**
 * Resolves the signed-in agent's personal (private) home drive.
 * Uses `initialDrive` optimistically while fetching authoritative value from the server.
 */
export function usePersonalDrive(): {
  personalDrive: string | undefined;
  loading: boolean;
} {
  const store = useStore();
  const { agent } = useSettings();
  const [personalDrive, setPersonalDrive] = useState<string | undefined>(
    () => agent?.initialDrive,
  );
  const [loading, setLoading] = useState(!!agent);

  useEffect(() => {
    if (!agent) {
      setPersonalDrive(undefined);
      setLoading(false);

      return;
    }

    let cancelled = false;
    setLoading(true);
    setPersonalDrive(agent.initialDrive);

    void fetchPersonalDriveSubject(store, agent).then(resolved => {
      if (!cancelled) {
        setPersonalDrive(resolved);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [store, agent]);

  return { personalDrive, loading };
}
