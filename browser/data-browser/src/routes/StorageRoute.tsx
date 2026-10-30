import { useEffect, useState } from 'react';
import { createRoute, Link } from '@tanstack/react-router';
import { useStore } from '@tomic/react';
import { pathNames, paths } from './paths';
import { appRoute } from './RootRoutes';
import { constructOpenURL } from '../helpers/navigation';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { fetchDriveBreakdown } from '../helpers/storageMapApi';
import { driveUsageOnHost } from '../embed/hostActions';
import { buildStorageTree } from '../helpers/storageMap';
import { StorageView, type Loaded } from '../components/StorageView';

export const StorageRoute = createRoute({
  path: pathNames.storage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { at?: string; drive?: string } => ({
    at: typeof search.at === 'string' ? search.at : undefined,
    drive: typeof search.drive === 'string' ? search.drive : undefined,
  }),
  component: () => <StoragePage />,
  getParentRoute: () => appRoute,
});

/** Fetches the drive's per-resource usage and hands it to the size map. */
function StoragePage() {
  const store = useStore();
  const { at, drive: asked } = StorageRoute.useSearch();
  const navigate = useNavigateWithTransition();
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });

  useEffect(() => {
    const { drive: current, serverUrl } = store.getSyncStatus();
    const drive = asked ?? current;
    const agent = store.getAgent();
    let cancelled = false;

    if (!drive) {
      setLoaded({ state: 'failed' });

      return;
    }

    // In the app the drive is measured on this device; elsewhere its server
    // reports it.
    driveUsageOnHost(drive)
      .then(
        rows =>
          rows ?? (agent ? fetchDriveBreakdown(serverUrl, drive, agent) : null),
      )
      .then(rows => {
        if (cancelled) return;

        setLoaded(
          rows
            ? { state: 'ready', root: buildStorageTree(rows, drive) }
            : { state: 'failed' },
        );
      });

    return () => {
      cancelled = true;
    };
  }, [store, asked]);

  return (
    <StorageView
      loaded={loaded}
      startAt={at}
      onOpen={subject => navigate(constructOpenURL(subject))}
      backTo={
        <p>
          <Link to={paths.sync}>Back to sync settings</Link>
        </p>
      }
    />
  );
}
