import { createRoute } from '@tanstack/react-router';
import { appRoute } from './RootRoutes';
import { pathNames } from './paths';
import { OidcSignInPage } from '../views/OidcSignInPage';

/** The identity provider's redirect lands here (see `OidcSignInPage`). */
export const OidcRoute = createRoute({
  path: pathNames.oidc,
  getParentRoute: () => appRoute,
  component: OidcSignInPage,
});
