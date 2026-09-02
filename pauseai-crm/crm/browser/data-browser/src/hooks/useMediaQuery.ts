import { useEffect, useState } from 'react';

/** Watches a media query and returns a statefull result. */
export function useMediaQuery(query: string, initial = false): boolean {
  const [matches, setMatches] = useState(() => {
    if (!window.matchMedia) {
      return initial;
    }

    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (!window.matchMedia) {
      return;
    }

    const listener = (e: MediaQueryListEvent) => {
      setMatches(e.matches);
    };

    const queryList = window.matchMedia(query);
    queryList.addEventListener('change', listener);

    return () => queryList.removeEventListener('change', listener);
  }, [query]);

  return matches;
}
