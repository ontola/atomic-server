import { commits, core } from '@tomic/lib';
import { useEffect, useRef, useState } from 'react';
import { useCollection } from './useCollection.js';
import { useStore } from './hooks.js';
import { StoreEvents } from '@tomic/lib';

/**
 * Returns the subjects of direct children of a resource, sorted by createdAt.
 * Uses the Collection system which queries the WASM DB first, then the server.
 * Automatically refreshes when a new resource is created under this parent.
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

  const { collection, ready, invalidateCollection } = useCollection(
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

  // Extract member subjects whenever the collection changes
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
      const members: string[] = [];
      for (const member of resolved) {
        if (
          member &&
          !member.startsWith('did:ad:commit:') &&
          !seen.has(member)
        ) {
          seen.add(member);
          members.push(member);
        }
      }

      setSubjects(members);
    };

    extractMembers();

    return () => {
      cancelled = true;
    };
  }, [collection, disabled]);

  // Refresh when a resource is created under this parent
  const invalidateRef = useRef(invalidateCollection);
  invalidateRef.current = invalidateCollection;

  const parentRef = useRef(parentSubject);
  parentRef.current = parentSubject;

  useEffect(() => {
    const unsub = store.on(StoreEvents.ResourceManuallyCreated, resource => {
      if (
        parentRef.current &&
        resource.get(core.properties.parent) === parentRef.current
      ) {
        invalidateRef.current();
      }
    });

    return unsub;
  }, [store]);

  return {
    subjects: disabled ? [] : subjects,
    loading: disabled ? false : !ready,
  };
}
