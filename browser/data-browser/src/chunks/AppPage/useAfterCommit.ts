import { useStore } from '@tomic/react';
import { useEffect, useState } from 'react';
import {
  fetchAfterCommit,
  onAfterCommitChange,
  type AfterCommitStatus,
} from './afterCommit';
import { onRowGrantChange } from './rowGrant';

/** How often an open tab asks again: proposals arrive from the background. */
const POLL_MS = 15_000;

/**
 * What `app`'s `afterCommit` hook is doing on `table`, or on every table it
 * follows when `table` is left out. Kept current across this page's answers
 * and grants, and polled while mounted, since the hook proposes edits with
 * nobody watching. `undefined` while loading or when there is nothing to ask
 * about (no app, signed out, or the request failed).
 */
export function useAfterCommit(
  app: string | undefined,
  table?: string,
): AfterCommitStatus | undefined {
  const store = useStore();
  const drive = store.getDrive();
  const [status, setStatus] = useState<AfterCommitStatus>();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const bump = () => setVersion(v => v + 1);
    const offHook = onAfterCommitChange(bump);
    const offGrant = onRowGrantChange(bump);
    const timer = setInterval(bump, POLL_MS);

    return () => {
      offHook();
      offGrant();
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!app || !drive || !store.getAgent()) return;

    let cancelled = false;

    fetchAfterCommit(store, { drive, app, table })
      .then(next => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setStatus(undefined);
      });

    return () => {
      cancelled = true;
    };
  }, [store, drive, app, table, version]);

  return app && drive ? status : undefined;
}
