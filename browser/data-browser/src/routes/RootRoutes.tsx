import {
  createRootRoute,
  createRoute,
  Outlet,
  useLocation,
} from '@tanstack/react-router';
import { pathNames } from './paths';
// import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import { Providers } from '../Providers';
import ResourcePage from '../views/ResourcePage';

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
  const { href } = useLocation();

  // We need to combine origin with tanstack's href because tanstack does not include the origin in the href but the normal window.location.href is not reactive.
  const subject = window.location.origin + href;

  return <ResourcePage subject={subject} key={subject} />;
};

export const topRoute = createRoute({
  path: '$',
  component: TopRouteComponent,
  getParentRoute: () => rootRoute,
});
