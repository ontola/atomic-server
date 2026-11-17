import { useEffect } from 'react';
import { createRoute } from '@tanstack/react-router';
import { pathNames, paths } from './paths';
import { appRoute } from './RootRoutes';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';

/** Sync lives in the settings page now; this route only survives so old links
 *  and bookmarks keep working. `?drive=` and `#sync-problem` come along. */
function SyncRedirect() {
  const navigate = useNavigateWithTransition();

  useEffect(() => {
    const { search, hash } = window.location;
    const extra = search.replace(/^\?/, '');

    navigate({
      to: `${paths.sync}${extra ? `&${extra}` : ''}${hash}`,
      replace: true,
    });
  }, [navigate]);

  return null;
}

export const SyncRoute = createRoute({
  path: pathNames.sync,
  component: SyncRedirect,
  getParentRoute: () => appRoute,
});
