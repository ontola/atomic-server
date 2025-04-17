import * as React from 'react';
import { createRoute } from '@tanstack/react-router';
import { appRoute } from './RootRoutes';
import { pathNames } from './paths';
import { OnboardingPage } from '../views/OnboardingPage';

export const OnboardingRoute = createRoute({
  path: pathNames.onboarding,
  component: () => <OnboardingPage />,
  getParentRoute: () => appRoute,
});
