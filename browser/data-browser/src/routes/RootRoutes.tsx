import { createRootRoute, createRoute, Outlet, useLocation } from '@tanstack/react-router';
import { pathNames } from './paths';
// import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import { Providers } from '../Providers';
import ResourcePage from '../views/ResourcePage';
import { useSettings } from '../helpers/AppSettings';
import { isDev } from '../config';

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
  const { baseURL } = useSettings();

  // In dev, the UI is often on :5173 while JSON-AD is served from the Atomic
  // server (e.g. :9883). Resolve `/` and other top-level paths against baseURL
  // so the root resource matches the server you configured.
  const origin =
    isDev() && baseURL ? new URL(baseURL).origin : window.location.origin;

  const subject = `${origin}${pathname}${window.location.search}`;

  return <ResourcePage subject={subject} key={subject} />;
};

export const topRoute = createRoute({
  path: '$',
  component: TopRouteComponent,
  getParentRoute: () => rootRoute,
});
