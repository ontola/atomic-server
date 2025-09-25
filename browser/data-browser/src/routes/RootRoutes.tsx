import { createRootRoute, createRoute, Outlet, useLocation } from '@tanstack/react-router';
import { useStore } from '@tomic/react';
import { useEffect, useState } from 'react';
import { pathNames, paths } from './paths';
// import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import { Providers } from '../Providers';
import ResourcePage from '../views/ResourcePage';
import { useSettings } from '../helpers/AppSettings';
import { isDev } from '../config';
import { getLocalServerOrigin, isRunningInTauri } from '../helpers/tauri';
import { fetchPersonalDriveSubject } from '../helpers/personalDrive';
import { constructOpenURL } from '../helpers/navigation';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';

export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: pathNames.app,
  component: () => <Outlet />,
  notFoundComponent: () => <p>404 Not found</p>,
});

export const rootRoute = createRootRoute({
  component: () => (
    <Providers>
      <Outlet />
      {/* Uncomment to get Tanstack Router Devtools */}
      {/* <TanStackRouterDevtools position='bottom-right' /> */}
    </Providers>
  ),
});

const TopRouteComponent: React.FC = () => {
  const { pathname } = useLocation();
  const { baseURL, agent, drive } = useSettings();
  const store = useStore();
  const navigate = useNavigateWithTransition();

  // When the URL is the bare root, we shouldn't assume the server root IS a
  // drive — often it isn't, or the user isn't authorized to see it. Prefer:
  //   1. signed-in agent with a personal drive → open that drive
  //   2. no agent → go to the welcome / sign-in flow
  //   3. otherwise → fall through to whatever lives at `/`
  const isRoot = pathname === '/' || pathname === '';
  const [resolvingRoot, setResolvingRoot] = useState(isRoot);

  useEffect(() => {
    if (!isRoot) {
      setResolvingRoot(false);
      return;
    }

    if (!agent) {
      navigate({ to: paths.welcome, replace: true });
      return;
    }

    // Fast path: user's last-used drive (persisted by AppSettings). Skip it
    // when it's still the initial default that equals the server root, since
    // that's the subject we're specifically trying to avoid landing on.
    if (drive && drive !== baseURL) {
      navigate(constructOpenURL(drive));
      return;
    }

    let cancelled = false;

    fetchPersonalDriveSubject(store, agent)
      .then(resolved => {
        if (cancelled) return;

        if (resolved && resolved !== baseURL) {
          navigate(constructOpenURL(resolved));
        } else {
          setResolvingRoot(false);
        }
      })
      .catch(() => {
        if (!cancelled) setResolvingRoot(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isRoot, agent, drive, baseURL, store, navigate]);

  // In dev, the UI is often on :5173 while JSON-AD is served from the Atomic
  // server (e.g. :9883). In Tauri, the UI is on a custom protocol while the
  // embedded server is on 9883. In both cases, resolve `/` against the
  // configured server (baseURL) or the embedded-server fallback — not
  // window.location.origin, which isn't fetchable.
  const origin =
    (isDev() || isRunningInTauri()) && baseURL
      ? new URL(baseURL).origin
      : (isDev() || isRunningInTauri())
        ? getLocalServerOrigin()
        : window.location.origin;

  const subject = `${origin}${pathname}${window.location.search}`;

  if (resolvingRoot) return null;

  return <ResourcePage subject={subject} key={subject} />;
};

export const topRoute = createRoute({
  path: '$',
  component: TopRouteComponent,
  getParentRoute: () => rootRoute,
});
