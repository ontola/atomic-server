import type { Collection } from '@tomic/react';
import { useEffect, useState } from 'react';

/**
 * Every member of a collection, loaded up front — for views that bucket or
 * split the whole table (board columns, open/closed issues) rather than show
 * one page of it. Re-fetched when the collection identity or size changes
 * (new/removed rows).
 */
export function useAllMembers(collection: Collection): string[] {
  const [members, setMembers] = useState<string[]>([]);
  const totalMembers = collection.totalMembers;

  useEffect(() => {
    let cancelled = false;

    void collection
      .getAllMembers()
      .then(result => {
        if (!cancelled) setMembers(result);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [collection, totalMembers]);

  return members;
}
