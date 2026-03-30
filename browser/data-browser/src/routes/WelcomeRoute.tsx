import * as React from 'react';
import { createRoute } from '@tanstack/react-router';
import { appRoute } from './RootRoutes';
import { pathNames } from './paths';
import { RootWelcomeGate } from '../views/RootWelcomeGate';
import { useSettings } from '../helpers/AppSettings';

export const WelcomeRoute = createRoute({
  path: pathNames.welcome,
  getParentRoute: () => appRoute,
  component: WelcomeRouteComponent,
});

function WelcomeRouteComponent(): React.JSX.Element {
  const { baseURL } = useSettings();

  // Use configured Atomic server base as canonical home subject.
  // Falls back to current origin if baseURL is unset.
  const subject = baseURL || window.location.origin;

  return <RootWelcomeGate subject={subject} />;
}

