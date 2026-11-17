import { useEffect } from 'react';
import { createRoute } from '@tanstack/react-router';
import { pathNames, paths } from '../paths';
import { appRoute } from '../RootRoutes';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';

/** Account and drive settings live on the settings page now; these routes only
 *  survive so old links and bookmarks keep working. */
const redirectTo = (target: string) =>
  function Redirect() {
    const navigate = useNavigateWithTransition();

    useEffect(() => {
      // Keep other params, such as atomic.place's `?add=passkey`.
      const extra = new URLSearchParams(window.location.search).toString();

      navigate({
        to: extra ? `${target}&${extra}` : target,
        replace: true,
      });
    }, [navigate]);

    return null;
  };

export const AgentSettingsRoute = createRoute({
  path: pathNames.agentSettings,
  component: redirectTo(paths.accountSettings),
  getParentRoute: () => appRoute,
});

export const ServerSettingsRoute = createRoute({
  path: pathNames.serverSettings,
  component: redirectTo(paths.accountSettings),
  getParentRoute: () => appRoute,
});
