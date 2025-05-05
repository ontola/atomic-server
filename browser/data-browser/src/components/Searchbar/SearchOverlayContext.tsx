import {
  createContext,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';

type OpenSearch = (query?: string, filters?: string) => void;

interface SearchOverlayContextValue {
  isOpen: boolean;
  query: string;
  filters: string | undefined;
  inputRef: RefObject<HTMLInputElement | null>;
  openSearch: OpenSearch;
  closeSearch: () => void;
  setQuery: (q: string) => void;
}

// Module-level state — avoids needing context just to open from HotKeysWrapper
let isOpen = false;
let query = '';
let filters: string | undefined = undefined;
const listeners = new Set<
  (isOpen: boolean, query: string, filters?: string) => void
>();

function notify() {
  listeners.forEach(listener => listener(isOpen, query, filters));
}

export function openSearchOverlay(q = '', f?: string) {
  isOpen = true;
  query = q;
  filters = f;
  notify();
}

export function closeSearchOverlay() {
  isOpen = false;
  query = '';
  filters = undefined;
  notify();
}

export function setQueryOverlay(q: string) {
  query = q;
  notify();
}

const SearchOverlayContext = createContext<SearchOverlayContextValue | null>(
  null,
);

export function useSearchOverlay(): SearchOverlayContextValue {
  const ctx = useContext(SearchOverlayContext);

  if (!ctx) {
    throw new Error(
      'useSearchOverlay must be used within SearchOverlayContext.Provider',
    );
  }

  return ctx;
}

export function SearchOverlayContextProvider({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  const [localIsOpen, setLocalIsOpen] = useState(false);
  const [localQuery, setLocalQuery] = useState('');
  const [localFilters, setLocalFilters] = useState<string | undefined>(
    undefined,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const handler = (open: boolean, q: string, f?: string) => {
      setLocalIsOpen(open);
      setLocalQuery(q);
      setLocalFilters(f);
    };

    listeners.add(handler);

    return () => {
      listeners.delete(handler);
    };
  }, []);

  const openSearch: OpenSearch = useCallback((q = '', f?: string) => {
    openSearchOverlay(q, f);
  }, []);

  const closeSearch = useCallback(() => {
    closeSearchOverlay();
  }, []);

  const setQuery = useCallback((q: string) => {
    setQueryOverlay(q);
  }, []);

  return (
    <SearchOverlayContext.Provider
      value={{
        isOpen: localIsOpen,
        query: localQuery,
        filters: localFilters,
        inputRef,
        openSearch,
        closeSearch,
        setQuery,
      }}
    >
      {children}
    </SearchOverlayContext.Provider>
  );
}
