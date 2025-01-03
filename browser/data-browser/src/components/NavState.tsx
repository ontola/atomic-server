import { createContext, useContext, useEffect, useState } from 'react';

export type NavState = 'PUSH' | 'POP' | 'NONE';

const NavStateContext = createContext<NavState>('PUSH');

/** Tracks navigation to keep a record of the last navigation type.
 * Useful if you need to know if the last navigation was a pop or push.
 */
export const NavStateProvider: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const [navState, setNavState] = useState<NavState>('PUSH');

  useEffect(() => {
    const handlePopState = () => {
      setNavState('POP');
    };

    const oldPushState = window.history.pushState;

    const handlePageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) {
        setNavState('NONE');
      }
    };

    window.addEventListener('popstate', handlePopState);
    window.addEventListener('pageshow', handlePageShow);

    // Modify the pushState function so we can track when it is called.
    window.history.pushState = function (...args) {
      setNavState('PUSH');
      oldPushState.apply(this, args);
    };

    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('pageshow', handlePageShow);
      window.history.pushState = oldPushState;
    };
  }, []);

  return (
    <NavStateContext.Provider value={navState}>
      {children}
    </NavStateContext.Provider>
  );
};

/**
 * Returns the last navigation type.
 */
export const useNavState = (): NavState => {
  return useContext(NavStateContext);
};
