import {
  Collection,
  CollectionBuilder,
  proxyCollection,
  QueryFilter,
  Store,
  StoreEvents,
} from '@tomic/lib';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './hooks.js';

export type CollectionItemProps = { collection: Collection; index: number };
export type UseCollectionResult = {
  collection: Collection;
  /** Whether the collection has completed its initial fetch. */
  ready: boolean;
  invalidateCollection: () => Promise<void>;
  /**
   * Helper function for rendering a list of all a collections members.
   * @example
   * ```tsx
   * const List = () => {
   *  const { mapAll } = useCollection(queryFilter);
   *
   *  return (
   *    <ul>
   *    {mapAll((props) => (
   *      <li key={props.index}>
   *        <Item {...props}/>
   *      </li>
   *      ))}
   *    </ul>
   *  );
   * }
   *
   * const Item = ({ index, collection }) => {
   *  const member = useMemberFromCollection(collection, index);
   *
   *  return <div>{member.title}</div>;
   * }
   * ```
   */
  mapAll: <T>(func: (props: CollectionItemProps) => T) => T[];
};

export type UseCollectionOptions = {
  /** The max number of members on one page, defaults to 30 */
  pageSize?: number;
  /** URL of the server that should be queried. defaults to the store's serverURL */
  server?: string;
  /** Whether to include nested resources in the collection, defaults to false */
  includeNested?: boolean;
};

const buildCollection = (
  store: Store,
  server: string | undefined,
  { property, value, sort_by, sort_desc }: QueryFilter,
  pageSize?: number,
  includeNested?: boolean,
) => {
  const builder = new CollectionBuilder(store, server);

  if (property) builder.setProperty(property);
  if (value) builder.setValue(value);
  if (sort_by) builder.setSortBy(sort_by);
  if (sort_desc !== undefined) builder.setSortDesc(sort_desc);
  if (pageSize) builder.setPageSize(pageSize);
  if (includeNested) builder.setIncludeNested(includeNested);

  return builder.build();
};

/**
 * Creates a collection resource that is rebuild when the query filter changes or `invalidateCollection` is called.
 * @param queryFilter
 * @param pageSize number of items per collection resource, defaults to 30.
 */
export function useCollection(
  queryFilter: QueryFilter,
  {
    pageSize = undefined,
    server = undefined,
    includeNested = false,
  }: UseCollectionOptions = {},
): UseCollectionResult {
  const store = useStore();
  const queryFilterMemo = useQueryFilterMemo(queryFilter);

  // Build collection once, reuse on remount. Only rebuild when query params change.
  const collectionRef = useRef<Collection | null>(null);
  const [collection, setCollection] = useState(() => {
    const col = buildCollection(
      store,
      server,
      queryFilterMemo,
      pageSize,
      includeNested,
    );
    collectionRef.current = col.__internalObject;

    return col;
  });
  const [ready, setReady] = useState(false);

  const mapAll = useCallback(
    <T>(func: ({ index, collection }: CollectionItemProps) => T): T[] => {
      const list: T[] = [];

      for (let index = 0; index < collection.totalMembers; index++) {
        list.push(func({ index, collection }));
      }

      return list;
    },
    [collection],
  );

  useEffect(() => {
    // Reuse the collection from useState if it matches (first mount).
    // Rebuild when ANY query param changes — `sort_by` / `sort_desc` aren't
    // mutable on a Collection (they're baked into the page subject the
    // server returns), so a sort toggle has to construct a new one.
    let col = collectionRef.current;

    if (
      !col ||
      col.property !== queryFilterMemo.property ||
      col.value !== queryFilterMemo.value ||
      col.sortBy !== queryFilterMemo.sort_by ||
      col.sortDesc !== !!queryFilterMemo.sort_desc
    ) {
      const built = buildCollection(
        store,
        server,
        queryFilterMemo,
        pageSize,
        includeNested,
      );
      col = built.__internalObject;
      collectionRef.current = col;
    }

    let cancelled = false;

    col.waitForReady().then(() => {
      if (cancelled) return;

      setCollection(proxyCollection(col!));
      setReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [queryFilterMemo, pageSize, store, server, includeNested]);

  const invalidateCollection = useCallback(async () => {
    const target = collection.__internalObject;
    await target.refresh();
    // Stale-write guard: a filter swap between when we kicked the
    // refresh and when it resolved would have replaced
    // `collectionRef.current` with a freshly-built Collection for the
    // new filter. Writing the OLD collection's proxy on top of that
    // would flip the UI back to the previous filter's data until the
    // next render. Only commit if this is still the active collection.
    if (collectionRef.current === target) {
      setCollection(proxyCollection(target));
    }
  }, [collection.__internalObject]);

  // Live-membership bridge. Each store-level resource change runs through
  // `applyResourceChange`, which either:
  //   - decides the change is irrelevant to this filter (most events) →
  //     unchanged, no work
  //   - finds a member that no longer matches → strips it from the cached
  //     page in place, no fetch
  //   - sees a new-or-newly-matching subject → returns `'membership-stale'`
  //     and we trigger a `/query` refresh so the server-authoritative count
  //     and ordering land. Without that fall-back, locally tracking the
  //     count drifts past the server's actual page count and the table
  //     virtualizer asks for non-existent pages, flooding `/query` GETs.
  // The storm reduction is preserved: only collections whose filter matches
  // the change ever invalidate.
  const invalidateRef = useRef(invalidateCollection);
  invalidateRef.current = invalidateCollection;

  useEffect(() => {
    const col = collectionRef.current;
    if (!col) return;

    const unsubUpdated = store.on(StoreEvents.ResourceUpdated, resource => {
      const result = col.applyResourceChange(resource.subject, resource);
      if (result === 'membership-stale') {
        invalidateRef.current();
      } else if (result === 'member-removed' || result === 'member-added') {
        setCollection(proxyCollection(col));
      }
    });

    const unsubRemoved = store.on(StoreEvents.ResourceRemoved, subject => {
      const result = col.applyResourceChange(subject, undefined);
      if (result === 'member-removed') {
        setCollection(proxyCollection(col));
      }
    });

    return () => {
      unsubUpdated();
      unsubRemoved();
    };
  }, [
    store,
    queryFilterMemo.property,
    queryFilterMemo.value,
    queryFilterMemo.sort_by,
    queryFilterMemo.sort_desc,
  ]);

  return { collection, ready, invalidateCollection, mapAll };
}

function useQueryFilterMemo(queryFilter: QueryFilter) {
  return useMemo(
    () => queryFilter,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      queryFilter.property,
      queryFilter.value,
      queryFilter.sort_by,
      queryFilter.sort_desc,
    ],
  );
}
