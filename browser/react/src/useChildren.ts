import { commits, core, dataBrowser, StoreEvents } from '@tomic/lib';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCollection } from './useCollection.js';
import { useStore } from './hooks.js';

/**
 * Returns the subjects of direct children of a resource.
 *
 * Server side, the live `parent=`/`sort_by=createdAt` Collection query
 * provides the candidate set (creation-time ordering). After that the
 * hook re-sorts client-side by the user-controllable
 * `dataBrowser.properties.sortOrder` (a fractional float written by
 * drag-and-drop). Resources without an explicit `sortOrder` fall back
 * to their `createdAt` timestamp as the implicit key — so a folder full
 * of legacy resources still displays in creation order, and a reorder
 * only needs to touch the single dragged resource (set its sortOrder to
 * the midpoint between its new neighbors).
 *
 * Pass `undefined` to disable fetching (e.g. for Tables/ChatRooms that show
 * children in their own UI).
 */
export function useChildren(parentSubject: string | undefined): {
  subjects: string[];
  loading: boolean;
} {
  const store = useStore();
  const [subjects, setSubjects] = useState<string[]>([]);
  const disabled = !parentSubject;

  // `subjectsRef` mirrors `subjects` for the `ResourceUpdated` listener
  // below — that listener subscribes once and reads the latest list
  // from the ref instead of being torn down + recreated on every
  // re-sort (which would race the optimistic re-render).
  const subjectsRef = useRef<string[]>([]);
  subjectsRef.current = subjects;

  const { collection, ready } = useCollection(
    {
      property: core.properties.parent,
      // `Collection.fetchPage` short-circuits when value is undefined, so
      // disabled hooks never hit the server. No sentinel needed.
      value: parentSubject,
      sort_by: commits.properties.createdAt,
      sort_desc: false,
    },
    { pageSize: 500 },
  );

  /**
   * Sort a list of subjects by `sortOrder` (explicit) with `createdAt`
   * as the implicit fallback, breaking ties with the original index
   * (= server-side createdAt order). Awaits each resource so the
   * sortOrder value reflects the latest save before we read it.
   */
  const sortMembers = useCallback(
    async (members: readonly string[]): Promise<string[]> => {
      const keyed = await Promise.all(
        members.map(async (subject, index) => {
          const resource = await store.getResource(subject);
          const explicit = resource.get(dataBrowser.properties.sortOrder);
          const createdAt = resource.get(commits.properties.createdAt);
          const key =
            typeof explicit === 'number'
              ? explicit
              : typeof createdAt === 'number'
                ? createdAt
                : 0;

          return { subject, key, index };
        }),
      );

      keyed.sort((a, b) =>
        a.key === b.key ? a.index - b.index : a.key - b.key,
      );

      return keyed.map(s => s.subject);
    },
    [store],
  );

  // Pull candidate set + initial sort from the collection.
  useEffect(() => {
    if (disabled) {
      setSubjects([]);

      return;
    }

    // Cancellation flag prevents a slow extract run from
    // `setSubjects(...stale)` after a fresh one already landed. The
    // collection-invalidate path can trigger overlapping runs when the
    // user creates resources faster than `waitForReady` resolves, and
    // the late writer used to overwrite the new data with the old.
    let cancelled = false;

    const extractMembers = async () => {
      await collection.waitForReady();
      if (cancelled) return;

      // Resolve all members in parallel — `getMemberWithIndex` is a
      // worker round-trip per call, so a 200-child folder used to pay
      // 200× sequential RTT on cold open. Promise.all hands the worker
      // a batch which it can process while the UI thread is otherwise
      // idle.
      const resolved = await Promise.all(
        Array.from({ length: collection.totalMembers }, (_, i) =>
          collection.getMemberWithIndex(i),
        ),
      );
      if (cancelled) return;

      // Drop commit subjects: they leak into parent= queries when a resource
      // is created/updated, but they're never tree-children. Also dedupe —
      // collection refreshes can race, leaving the same subject indexed
      // twice across pages.
      const seen = new Set<string>();
      const candidates: string[] = [];

      for (const member of resolved) {
        if (
          member &&
          !member.startsWith('did:ad:commit:') &&
          !seen.has(member)
        ) {
          seen.add(member);
          candidates.push(member);
        }
      }

      const sorted = await sortMembers(candidates);
      if (cancelled) return;
      setSubjects(sorted);
    };

    extractMembers();

    return () => {
      cancelled = true;
    };
  }, [collection, disabled, sortMembers]);

  /**
   * Re-sort when any current child's `sortOrder` (or `createdAt`)
   * changes. Drag-and-drop writes `sortOrder` on the dragged resource
   * and `Resource.save()` emits `ResourceUpdated` — that's the signal
   * we hook here. The collection's own subject set hasn't changed (only
   * a property within an existing member), so `useCollection` doesn't
   * re-emit and the candidate-fetch effect above doesn't re-fire.
   *
   * The listener reads the current subject list from a ref instead of
   * a closed-over copy, so a re-sort that itself triggers a save
   * (rare, but possible via fan-out updates) re-evaluates against the
   * fresh list rather than reverting to the pre-sort order.
   */
  useEffect(() => {
    if (disabled) return;

    let cancelled = false;

    const unsub = store.on(StoreEvents.ResourceUpdated, async resource => {
      const current = subjectsRef.current;

      if (current.length === 0 || !current.includes(resource.subject)) {
        return;
      }

      const resorted = await sortMembers(current);
      if (cancelled) return;

      setSubjects(prev =>
        prev.length === resorted.length &&
        prev.every((s, i) => s === resorted[i])
          ? prev
          : resorted,
      );
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [disabled, sortMembers, store]);

  // `useCollection` listens for `ResourceManuallyCreated` and routes
  // it through `applyResourceChange` for an optimistic add — no full
  // refetch needed. The previous duplicate listener here called
  // `invalidateCollection` instead, which races: invalidate clears
  // the optimistic page right back out while the underlying `/query`
  // refresh is still in flight.

  return {
    subjects: disabled ? [] : subjects,
    loading: disabled ? false : !ready,
  };
}
