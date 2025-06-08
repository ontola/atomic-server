import * as React from 'react';
import { createRoute } from '@tanstack/react-router';
import { appRoute } from './RootRoutes';
import { pathNames } from './paths';
import { FullScreenNewIdentityPage } from '../views/FullScreenNewIdentityPage';

export const OnboardingRoute = createRoute({
  path: pathNames.onboarding,
  component: () => <FullScreenNewIdentityPage />,
  getParentRoute: () => appRoute,
});
