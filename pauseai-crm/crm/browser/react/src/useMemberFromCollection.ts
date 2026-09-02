import {
  Collection,
  OptionalClass,
  Resource,
  unknownSubject,
} from '@tomic/lib';
import { useEffect, useState } from 'react';
import { useResource } from './hooks.js';

/**
 * Gets a member from a collection by index. Handles pagination for you.
 */
export function useMemberFromCollection<C extends OptionalClass = never>(
  collection: Collection,
  index: number,
): Resource<C> {
  const [subject, setSubject] = useState(unknownSubject);
  const resource = useResource(subject);

  useEffect(() => {
    // `index` can momentarily exceed the collection's size — e.g. a filter
    // shrinks `totalMembers` while a virtualized row for an old index is still
    // mounted. `getMemberWithIndex` rejects with "Index out of bounds" there;
    // swallow it (the row unmounts / re-resolves on the next render) instead of
    // surfacing an unhandled rejection.
    let cancelled = false;

    collection
      .getMemberWithIndex(index)
      .then(s => {
        if (!cancelled && s) {
          setSubject(s);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [collection, index]);

  return resource;
}
