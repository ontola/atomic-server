import { removeCachedSearchResults, SearchOpts } from '@tomic/lib';
import { useEffect, useState } from 'react';
import { useStore } from './index.js';
import { useDebounce } from './useDebounce.js';

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
  const [prevDebounedQuery, setPrevDebounedQuery] = useState(debouncedQuery);

  if (prevDebounedQuery !== debouncedQuery) {
    setPrevDebounedQuery(debouncedQuery);
    setLoading(true);

    if (!debouncedQuery && !allowEmptyQuery) {
      setResults([]);
    }
  }

  useEffect(() => {
    if (!debouncedQuery && !allowEmptyQuery) {
      return;
    }

    store
      .search(debouncedQuery, searchOpts)
      .then(r => {
        setResults(r);
        setError(undefined);
      })
      .catch(e => {
        setError(e);
        setResults([]);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [store, allowEmptyQuery, debouncedQuery, searchOpts]);

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
