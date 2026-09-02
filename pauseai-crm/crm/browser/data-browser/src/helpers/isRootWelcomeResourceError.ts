import {
  type Agent,
  type Resource,
  isNotFound,
  isUnauthorized,
} from '@tomic/react';
import { isAtomicServerHome } from './isAtomicServerHome';

/**
 * True when loading the server home failed in a way that should show the
 * full-page welcome gate (fresh self-host, no agent, not found or need to sign in).
 */
export function isRootWelcomeResourceError(
  resource: Resource,
  agent: Agent | undefined,
  baseURL: string,
): boolean {
  if (!resource.error) {
    return false;
  }

  return (
    isAtomicServerHome(resource.subject, baseURL) &&
    !agent &&
    (isNotFound(resource.error) || isUnauthorized(resource.error))
  );
}
