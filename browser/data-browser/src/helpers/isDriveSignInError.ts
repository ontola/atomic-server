import { type Agent, type Resource, isUnauthorized } from '@tomic/react';
import { isRootWelcomeResourceError } from './isRootWelcomeResourceError';

/**
 * True when a not-signed-in visitor opened a resource they can't read that is
 * NOT the server home — e.g. a private drive opened from the cloud portal on a
 * new device. This drives the drive-aware sign-in guard (welcome panel's
 * sign-in step, with the resource carried as `next` so we return there after
 * sign-in), as distinct from the server-home welcome gate
 * ({@link isRootWelcomeResourceError}).
 *
 * Gated on `!agent`: an already-signed-in atomic-server identity opens the
 * resource directly — its access is independent of any cloud/SaaS session.
 */
export function isDriveSignInError(
  resource: Resource,
  agent: Agent | undefined,
  baseURL: string,
): boolean {
  return (
    !agent &&
    !isRootWelcomeResourceError(resource, agent, baseURL) &&
    isUnauthorized(resource.error)
  );
}
