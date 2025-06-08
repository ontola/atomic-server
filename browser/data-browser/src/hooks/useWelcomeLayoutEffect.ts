import { useEffect } from 'react';
import { useRootWelcomeLayout } from '../context/RootWelcomeLayoutContext';

/**
 * While the root welcome gate is mounted, hide global chrome (sidebar, top bar,
 * AI panel). See {@link RootWelcomeLayoutProvider}.
 */
export function useWelcomeLayoutEffect(): void {
  const { setRootWelcomeChromeHidden } = useRootWelcomeLayout();

  useEffect(() => {
    setRootWelcomeChromeHidden(true);

    return () => setRootWelcomeChromeHidden(false);
  }, [setRootWelcomeChromeHidden]);
}
