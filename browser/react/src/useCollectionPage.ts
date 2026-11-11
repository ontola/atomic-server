import { Collection } from '@tomic/lib';
import { useEffect, useState } from 'react';

export function useCollectionPage(collection: Collection, page: number) {
  const [items, setItems] = useState<string[]>([]);

  useEffect(() => {
    // A collection that refreshes hands out a new proxy each time, and the
    // reads for earlier ones can settle after the latest. Only the newest
    // read may write, or a stale empty page overwrites the current members.
    let stale = false;

    collection.getMembersOnPage(page).then(members => {
      if (!stale) setItems(members);
    });

    return () => {
      stale = true;
    };
  }, [collection, page]);

  return items;
}
