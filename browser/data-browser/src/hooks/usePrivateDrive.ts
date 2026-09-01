import { StoreEvents, useStore } from '@tomic/react';
import { useEffect, useState } from 'react';
import { useSettings } from '../helpers/AppSettings';
import { fetchPrivateDriveSubject } from '../helpers/privateDrive';

/**
 * Resolves the signed-in agent's personal (private) home drive.
 * Uses `initialDrive` optimistically while fetching authoritative value from the server.
 * Re-resolves when the Agent resource is updated (invite persist writes
 * `privateDrive` after the first `setAgent`).
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

    const apply = (resolved: string | undefined) => {
      if (!cancelled) {
        setPrivateDrive(resolved);
        setLoading(false);
      }
    };

    void fetchPrivateDriveSubject(store, agent).then(apply);

    const unsub = store.on(StoreEvents.ResourceUpdated, resource => {
      if (resource.subject !== agent.subject) {
        return;
      }

      void fetchPrivateDriveSubject(store, agent).then(apply);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [store, agent]);

  return { privateDrive, loading };
}
