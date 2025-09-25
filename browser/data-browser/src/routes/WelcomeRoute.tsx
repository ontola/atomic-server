import * as React from 'react';
import { createRoute } from '@tanstack/react-router';
import { appRoute } from './RootRoutes';
import { pathNames } from './paths';
import { RootWelcomeGate } from '../views/RootWelcomeGate';
import { useSettings } from '../helpers/AppSettings';
import { getLocalServerOrigin } from '../helpers/tauri';

export const WelcomeRoute = createRoute({
  path: pathNames.welcome,
  getParentRoute: () => appRoute,
  component: WelcomeRouteComponent,
});

function WelcomeRouteComponent(): React.JSX.Element {
  const { baseURL } = useSettings();

  // Use configured Atomic server base as canonical home subject.
  // Fall back to the local server origin (embedded server in Tauri,
  // window.location.origin in a plain browser).
  const subject = baseURL || getLocalServerOrigin();

  return <RootWelcomeGate subject={subject} />;
}
