import { createRoute, createRouter, Link } from '@tanstack/react-router';
import { ShowRoute } from './ShowRoute';
import { SearchRoute } from './Search/SearchRoute';
import { NewRoute } from './NewResource/NewRoute';
import { AppSettingsRoute } from './AppSettings';
import { EditRoute } from './EditRoute';
import { DataRoute } from './DataRoute';
import { ShortcutsRoute } from './ShortcutsRoute';
import { AboutRoute } from './AboutRoute';
import { AgentSettingsRoute } from './SettingsAgent';
import { ServerSettingsRoute } from './SettingsServer';
import { pathNames } from './paths';
import { ShareRoute } from './Share/ShareRoute';
import { TokenRoute } from './TokenRoute';
import { isDev } from '../config';
import { rootRoute, topRoute, appRoute } from './RootRoutes';
import { unavailableLazyRoute } from './UnavailableLazyRoute';
import { ImportRoute } from './ImportRoute';
import { HistoryRoute } from './History/HistoryRoute';

const PruneTestsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: pathNames.pruneTests,
}).lazy(() => {
  if (isDev()) {
    return import('./PruneTestsRoute').then(mod => mod.pruneTestRouteLazy);
  } else {
    return Promise.resolve(unavailableLazyRoute);
  }
});

const SandboxRoute = createRoute({
  getParentRoute: () => appRoute,
  path: pathNames.sandbox,
}).lazy(() => {
  if (isDev()) {
    return import('./Sandbox').then(mod => mod.sandboxRouteLazy);
  } else {
    return Promise.resolve(unavailableLazyRoute);
  }
});

const routeTree = rootRoute.addChildren({
  appRoute: appRoute.addChildren({
    ShowRoute,
    SearchRoute,
    AppSettingsRoute,
    ShortcutsRoute,
    AgentSettingsRoute,
    ServerSettingsRoute,
    DataRoute,
    EditRoute,
    ImportRoute,
    ShareRoute,
    AboutRoute,
    TokenRoute,
    HistoryRoute,
    NewRoute,
    PruneTestsRoute,
    SandboxRoute,
  }),
  topRoute,
});

export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: () => {
    return (
      <div>
        <p>Not found!</p>
        <Link to='/'>Go home</Link>
      </div>
    );
  },
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
