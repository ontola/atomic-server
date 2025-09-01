import { createRoute } from '@tanstack/react-router';
import { useStore } from '@tomic/react';
import ResourcePage from '../views/ResourcePage';
import { appRoute } from './RootRoutes';
import { pathNames } from './paths';

/**
 * /app/invite?token=... route.
 * Constructs the server-side invite subject from the token and renders it.
 * The InvitePage component (selected by ResourcePage via class detection)
 * handles the onboarding UX when the user isn't signed in.
 */
export const InviteRoute = createRoute({
  path: pathNames.invite,
  component: InviteRouteComponent,
  getParentRoute: () => appRoute,
});

function InviteRouteComponent() {
  const store = useStore();
  const token = new URLSearchParams(window.location.search).get('token');

  if (!token) {
    return <p>No invite token provided.</p>;
  }

  const subject = `${store.getServerUrl()}/invites?token=${encodeURIComponent(token)}`;

  return <ResourcePage subject={subject} key={subject} />;
}
