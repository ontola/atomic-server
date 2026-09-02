import {
  createContext,
  useContext,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';

/**
 * Layout-only context: when the root URL shows the welcome gate, we hide global
 * chrome (sidebar, top bar, AI panel). Kept separate from AppSettings so
 * “user preferences” and “this screen’s shell” stay distinct.
 */
type Value = {
  rootWelcomeChromeHidden: boolean;
  setRootWelcomeChromeHidden: (hidden: boolean) => void;
};

const RootWelcomeLayoutContext = createContext<Value | null>(null);

export function RootWelcomeLayoutProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [rootWelcomeChromeHidden, setRootWelcomeChromeHidden] = useState(false);

  const value = useMemo(
    () => ({ rootWelcomeChromeHidden, setRootWelcomeChromeHidden }),
    [rootWelcomeChromeHidden],
  );

  return (
    <RootWelcomeLayoutContext.Provider value={value}>
      {children}
    </RootWelcomeLayoutContext.Provider>
  );
}

export function useRootWelcomeLayout(): Value {
  const ctx = useContext(RootWelcomeLayoutContext);

  if (!ctx) {
    throw new Error(
      'useRootWelcomeLayout must be used within RootWelcomeLayoutProvider',
    );
  }

  return ctx;
}
