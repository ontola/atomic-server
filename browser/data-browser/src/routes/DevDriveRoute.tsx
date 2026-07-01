import { createLazyRoute } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useDevDrive } from '../hooks/useDevDrive';

// Module-level guard: React 19 StrictMode in dev mode mounts effects twice
// (mount → fake-unmount → remount), and concurrent rendering can re-mount
// the route again on rapid navigation. Without this guard each mount fires
// `createDevDrive()` and we end up with 2-4 fresh agents + drives stacked
// in the local store on a single visit. The ref short-circuits anything
// past the first invocation in this page's lifetime.
let inFlight: Promise<void> | null = null;

const DevDriveRoute: React.FC = () => {
  const { createDevDrive } = useDevDrive();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (inFlight) return;
    inFlight = createDevDrive().finally(() => {
      inFlight = null;
    });
  }, []);

  return <p style={{ padding: '1rem' }}>Setting up dev drive...</p>;
};

export const devDriveRouteLazy = createLazyRoute('/app/dev-drive')({
  component: DevDriveRoute,
});
