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

const AccountRedirect = redirectTo(paths.accountSettings);
const ProfileRedirect = redirectTo(paths.profileSettings);

export const AgentSettingsRoute = createRoute({
  path: pathNames.agentSettings,
  // `?add=passkey` (from atomic.place) belongs with account recovery.
  component: () => {
    const Redirect = new URLSearchParams(window.location.search).has('add')
      ? AccountRedirect
      : ProfileRedirect;

    return <Redirect />;
  },
  getParentRoute: () => appRoute,
});

export const ServerSettingsRoute = createRoute({
  path: pathNames.serverSettings,
  component: redirectTo(paths.accountSettings),
  getParentRoute: () => appRoute,
});
