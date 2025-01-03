import { createRoute } from '@tanstack/react-router';
import { pathNames } from './paths';
import { appRoute } from './RootRoutes';
import { ImporterPage } from '../views/ImporterPage';

export const ImportRoute = createRoute({
  path: pathNames.import,
  component: () => <ImporterPage />,
  getParentRoute: () => appRoute,
});
