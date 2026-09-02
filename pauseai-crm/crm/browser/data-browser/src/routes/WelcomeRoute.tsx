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
  // `next`: a drive subject to return to after a sign-in guard sent the user
  // here. `from_portal`: set when arriving from the managed portal post-verify.
  // Both are read in GettingStartedFlow.
  validateSearch: (
    search: Record<string, unknown>,
  ): { next?: string; from_portal?: boolean } => ({
    next: typeof search.next === 'string' ? search.next : undefined,
    // tanstack coerces `?from_portal=true` to a boolean before we see it, so
    // accept both. Dropping it here would also strip it from the URL.
    from_portal:
      search.from_portal === true || search.from_portal === 'true' || undefined,
  }),
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
