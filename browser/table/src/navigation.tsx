import { createContext, useContext, type PropsWithChildren } from 'react';

/** Table-owned location only. The host retains resource and collection routing. */
export interface TableLocation {
  view?: string;
  editColumn?: string;
}

export interface TableNavigation {
  /** Reactive snapshot supplied by the host, including Back/Forward changes. */
  location: Readonly<TableLocation>;
  /** Patch the latest host location; undefined explicitly clears a field. */
  navigate: (
    patch: Partial<TableLocation>,
    options?: { replace?: boolean },
  ) => void | Promise<void>;
}

const NavigationContext = createContext<TableNavigation | undefined>(undefined);

export function TableNavigationProvider({
  value,
  children,
}: PropsWithChildren<{ value: TableNavigation }>) {
  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  );
}

/** Used by a host boundary to preserve an already supplied embedding adapter. */
export const useOptionalTableNavigation = () => useContext(NavigationContext);

export function useTableNavigation(): TableNavigation {
  const navigation = useOptionalTableNavigation();
  if (!navigation) throw new Error('TableNavigationProvider is required');

  return navigation;
}
