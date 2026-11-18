import { useStore } from '@tomic/react';
import { useEffect, useState } from 'react';
import { fetchRowGrant, onRowGrantChange, type RowGrant } from './rowGrant';

/**
 * The live row grant for `app` on `table`, kept current across this page's
 * grants and revokes. `undefined` while loading or when there is nothing to
 * ask about (no app, no table, signed out); `null` when there is no grant.
 */
export function useRowGrant(
  table: string | undefined,
  app: string | undefined,
): RowGrant | null | undefined {
  const store = useStore();
  const drive = store.getDrive();
  const [grant, setGrant] = useState<RowGrant | null>();
  const [version, setVersion] = useState(0);

  useEffect(() => onRowGrantChange(() => setVersion(v => v + 1)), []);

  const enabled = !!table && !!app && !!drive && !!store.getAgent();

  useEffect(() => {
    if (!table || !app || !drive || !store.getAgent()) return;

    let cancelled = false;

    fetchRowGrant(store, { drive, table, app })
      .then(status => {
        if (!cancelled) setGrant(status.grant);
      })
      .catch(() => {
        if (!cancelled) setGrant(undefined);
      });

    return () => {
      cancelled = true;
    };
  }, [store, drive, table, app, version]);

  return enabled ? grant : undefined;
}
