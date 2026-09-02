import { useStore } from '@tomic/react';
import { useEffect, useState } from 'react';
import { useSettings } from '../helpers/AppSettings';
import { fetchPrivateDriveSubject } from '../helpers/privateDrive';

/**
 * Resolves the signed-in agent's personal (private) home drive.
 * Uses `initialDrive` optimistically while fetching authoritative value from the server.
 */
export function usePrivateDrive(): {
  privateDrive: string | undefined;
  loading: boolean;
} {
  const store = useStore();
  const { agent } = useSettings();
  const [privateDrive, setPrivateDrive] = useState<string | undefined>(
    () => agent?.initialDrive,
  );
  const [loading, setLoading] = useState(!!agent);

  useEffect(() => {
    if (!agent) {
      setPrivateDrive(undefined);
      setLoading(false);

      return;
    }

    let cancelled = false;
    setLoading(true);
    setPrivateDrive(agent.initialDrive);

    void fetchPrivateDriveSubject(store, agent).then(resolved => {
      if (!cancelled) {
        setPrivateDrive(resolved);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [store, agent]);

  return { privateDrive, loading };
}
