import { useSettings } from '@helpers/AppSettings';
import { useStore } from '@tomic/react';
import { useEffect, useState } from 'react';

/** Subscribes to vector indexing state for a drive via `store.subscribeIndexStatus`. */
export function useVectorIndexStatus(): boolean {
  const store = useStore();
  const { drive } = useSettings();
  const [indexing, setIndexing] = useState(false);

  useEffect(() => {
    if (!drive) {
      return;
    }

    return store.subscribeIndexStatus(drive, setIndexing);
  }, [store, drive]);

  return !!drive && indexing;
}
