import {
  getEffectiveConstraint,
  ResourceEvents,
  type Constraint,
} from '@tomic/lib';
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { useStore } from './hooks.js';

/**
 * The constraint that applies to a property for instances of the given classes:
 * the merged class `constraints` maps, falling back per keyword to the
 * Property's legacy `allowsOnly`, `classtype` and `min`/`max`.
 * See {@link getEffectiveConstraint}.
 *
 * Re-renders when any of the classes or the property changes, including edits
 * that have not been saved yet. The returned object is rebuilt on every render
 * because the underlying resources mutate in place; do not use it as an effect
 * dependency, use its fields.
 */
export function useEffectiveConstraint(
  classSubjects: string[] | undefined,
  propertySubject: string | undefined,
): Constraint {
  const store = useStore();
  const key = (classSubjects ?? []).join('\n');
  const stableSubjects = useMemo(() => (key ? key.split('\n') : []), [key]);
  const watched = useMemo(
    () =>
      propertySubject ? [...stableSubjects, propertySubject] : stableSubjects,
    [stableSubjects, propertySubject],
  );

  // The resources mutate in place, so a counter stands in for their snapshot.
  const version = useRef(0);
  const subscribe = useCallback(
    (callback: () => void) => {
      const bump = () => {
        version.current += 1;
        callback();
      };

      // `store.subscribe` covers loads and commits; `LocalChange` covers
      // `set()` before it is saved.
      const unsubscribers = watched.flatMap(subject => [
        store.subscribe(subject, bump),
        store
          .getResourceLoading(subject)
          .stable.on(ResourceEvents.LocalChange, bump),
      ]);

      return () => unsubscribers.forEach(unsubscribe => unsubscribe());
    },
    [store, watched],
  );
  const getVersion = () => version.current;

  useSyncExternalStore(subscribe, getVersion, getVersion);

  if (!propertySubject) return {};

  return getEffectiveConstraint(store, stableSubjects, propertySubject);
}
