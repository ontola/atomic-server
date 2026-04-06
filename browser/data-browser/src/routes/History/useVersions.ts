import { Resource, Version, unknownSubject } from '@tomic/react';
import { useState, useEffect, useRef } from 'react';

export interface UseVersionsResult {
  versions: Version[];
  loading: boolean;
  error: Error | undefined;
}

/**
 * Extracts version history from the resource's Loro OpLog.
 * Instant — no network requests needed, no progress bar.
 */
export function useVersions(resource: Resource): UseVersionsResult {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | undefined>(undefined);
  const isRunning = useRef(false);

  useEffect(() => {
    if (resource.getSubject() === unknownSubject || resource.loading) {
      return;
    }

    if (isRunning.current) {
      return;
    }

    isRunning.current = true;

    try {
      const history = resource.getLoroHistory();
      setVersions(history);
    } catch (e) {
      console.error('Failed to get Loro history:', e);
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
      isRunning.current = false;
    }
  }, [resource, resource.loading]);

  return { versions, loading, error };
}
