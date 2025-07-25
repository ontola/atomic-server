import { core, StoreEvents, useCollection, useStore } from '@tomic/react';
import { useEffect, useRef, useState } from 'react';

/**
 * Returns the subjects of direct children of a resource, sorted by createdAt.
 * Uses the Collection system which queries the WASM DB first, then the server.
 * Automatically refreshes when a new resource is created under this parent.
 */
export function useChildren(parentSubject: string | undefined): string[] {
  const store = useStore();
  const [subjects, setSubjects] = useState<string[]>([]);

  const { collection, invalidateCollection } = useCollection(
    {
      property: core.properties.parent,
      value: parentSubject,
      sort_by: core.properties.createdAt,
      sort_desc: false,
    },
    { pageSize: 500 },
  );

  // Extract member subjects whenever the collection changes
  useEffect(() => {
    const extractMembers = async () => {
      await collection.waitForReady();
      const members: string[] = [];

      for (let i = 0; i < collection.totalMembers; i++) {
        const member = await collection.getMemberWithIndex(i);

        if (member) {
          members.push(member);
        }
      }

      setSubjects(members);
    };

    extractMembers();
  }, [collection]);

  // Refresh when a resource is created under this parent
  const invalidateRef = useRef(invalidateCollection);
  invalidateRef.current = invalidateCollection;

  const parentRef = useRef(parentSubject);
  parentRef.current = parentSubject;

  useEffect(() => {
    const unsub = store.on(
      StoreEvents.ResourceManuallyCreated,
      resource => {
        if (resource.get(core.properties.parent) === parentRef.current) {
          invalidateRef.current();
        }
      },
    );

    return unsub;
  }, [store]);

  return subjects;
}
