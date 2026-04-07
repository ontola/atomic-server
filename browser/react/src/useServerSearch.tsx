import { removeCachedSearchResults, SearchOpts } from '@tomic/lib';
import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { useStore } from './index.js';
import { useDebounce } from './useDebounce.js';
import { useOnValueChange } from './helpers/useOnValueChange.js';

interface SearchResults {
  /** Subject URLs for resources that match the query */
  results: string[];
  loading: boolean;
  error?: Error;
}

interface SearchOptsHook extends SearchOpts {
  /**
   * Debouncing makes queries slower, but prevents sending many request. Number
   * respresents milliseconds.
   */
  debounce?: number;
  allowEmptyQuery?: boolean;
}

/** Escape values for use in filter string */
export const escapeFilterValue = (value: string) =>
  value.replace(/[+^`:{}"[\]()!\\*\s]/gm, '\\$&');

/** Pass a query to search the current server */
export function useServerSearch(
  query: string | undefined,
  opts: SearchOptsHook = {},
): SearchResults {
  const { debounce = 50, allowEmptyQuery = false, ...searchOpts } = opts;
  const store = useStore();
  const [results, setResults] = useState<string[]>([]);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const debouncedQuery = useDebounce(query, debounce) ?? '';

  // Memoize searchOpts by content, not reference. searchOpts is a new object
  // every render (destructured from the caller's inline object literal).
  const searchOptsKey = JSON.stringify(searchOpts);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const memoizedSearchOpts = useMemo(() => searchOpts, [searchOptsKey]);

  useOnValueChange(() => {
    if (debouncedQuery) {
      setLoading(true);
    }

    if (!debouncedQuery && !allowEmptyQuery) {
      setResults([]);
      setLoading(false);
    }
  }, [debouncedQuery, allowEmptyQuery]);

  const updateResults = useEffectEvent(
    (r: string[], relevantQuery: string, relevantOpts: SearchOpts) => {
      // If the query became empty since the last fetch, don't update the results
      if (relevantQuery !== debouncedQuery || relevantOpts !== memoizedSearchOpts) {
        return;
      }

      setResults(r);
    },
  );

  useEffect(() => {
    if (!debouncedQuery && !allowEmptyQuery) {
      return;
    }

    store
      .search(debouncedQuery, memoizedSearchOpts)
      .then(r => {
        updateResults(r, debouncedQuery, memoizedSearchOpts);
        setError(undefined);
      })
      .catch(e => {
        setError(e);
        setResults([]);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [store, allowEmptyQuery, debouncedQuery, memoizedSearchOpts]);

  // Remove cached results when component unmounts.
  useEffect(() => {
    return () => {
      removeCachedSearchResults(store);
    };
  }, [store]);

  return {
    results,
    loading,
    error,
  };
}
