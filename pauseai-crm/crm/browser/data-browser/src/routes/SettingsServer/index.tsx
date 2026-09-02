import { useEffect } from 'react';
import { createRoute } from '@tanstack/react-router';
import { pathNames, paths } from '../paths';
import { appRoute } from '../RootRoutes';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';

export const ServerSettingsRoute = createRoute({
  path: pathNames.serverSettings,
  component: () => <RedirectToUserSettings />,
  getParentRoute: () => appRoute,
});

/** Drive management lives on the User Settings page now (a user HAS drives);
 *  this route only survives so old links and bookmarks keep working. */
function RedirectToUserSettings() {
  const navigate = useNavigateWithTransition();

  useEffect(() => {
    navigate({ to: paths.agentSettings, replace: true });
  }, [navigate]);

  return null;
}
