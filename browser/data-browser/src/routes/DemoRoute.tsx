import { createLazyRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@tomic/react';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../helpers/navigation';
import { isClientDbEnabled } from '../helpers/clientDbMode';
import {
  Shell,
  Card,
  CardTitle,
} from '../views/getting-started/GettingStartedFlow';

// React 19 StrictMode mounts effects twice and rapid navigation can
// remount the route; without this module-level guard each mount would
// build a whole demo workspace (see DevDriveRoute for the same pattern).
let inFlight: Promise<void> | null = null;

/**
 * Starts the demo workspace immediately: mints a guest agent when
 * nobody is signed in, builds a FRESH drive (cleaning up a previous
 * demo run), starts the scripted scenario, and navigates to the
 * welcome doc. No interstitial — "Try the live demo" means the demo
 * starts.
 */
const DemoRoute: React.FC = () => {
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const [error, setError] = useState<Error | undefined>();
  const startedRef = useRef(false);

  const supported = isClientDbEnabled();

  useEffect(() => {
    if (!supported) return;
    if (startedRef.current) return;
    startedRef.current = true;
    if (inFlight) return;

    inFlight = (async () => {
      const { startDemoWorkspace } = await import('../chunks/Demo/startDemo');
      const manifest = await startDemoWorkspace(store);
      navigate(constructOpenURL(manifest.welcomeDoc));
    })()
      .catch(e => {
        setError(
          e instanceof Error ? e : new Error('Could not start the demo'),
        );
      })
      .finally(() => {
        inFlight = null;
      });
  }, []);

  return (
    <Shell>
      <Card>
        <CardTitle>
          {error ? 'The demo could not start' : 'Setting up your demo team…'}
        </CardTitle>
        {!supported && (
          <p>
            The demo needs the local database, which is disabled in this
            environment.
          </p>
        )}
        {error && <p role='alert'>{error.message}</p>}
      </Card>
    </Shell>
  );
};

export const demoRouteLazy = createLazyRoute('/app/demo')({
  component: DemoRoute,
});
