// @wc-ignore-file
import {
  errorMessageFromResponse,
  parseRouteStatus,
  parseRouteTokens,
  signRequest,
  type InstallationRouteStatus,
  type RouteToken,
  type Store,
} from '@tomic/react';

/**
 * The host's calls about an Installation's public endpoints (#1721), shared
 * by the Installation page and the plugin view's host calls. Each is signed
 * as the person, with its arguments in the signed URL, so a signature
 * answers that one request only.
 */
async function call(
  store: Store,
  path: '/plugin-route-status' | '/plugin-route-tokens',
  installation: string,
  options: { revoke?: string; missingIsEmpty?: boolean } = {},
): Promise<unknown> {
  const agent = store.getAgent();

  if (!agent) throw new Error('Sign in to manage this app');

  let url = `${store.getServerUrl()}${path}?installation=${encodeURIComponent(installation)}`;

  if (options.revoke) url += `&revoke=${encodeURIComponent(options.revoke)}`;

  const headers = await signRequest(url, agent, {});
  const response = await fetch(url, {
    method: options.revoke ? 'POST' : 'GET',
    headers,
  });
  const body = await response.text();

  // A server built without plugin routes has no such endpoint.
  if (options.missingIsEmpty && response.status === 404) return undefined;

  if (!response.ok) {
    throw new Error(errorMessageFromResponse(body, response.status));
  }

  try {
    return JSON.parse(body);
  } catch (e) {
    // Such a server may answer its app shell instead of a 404.
    if (options.missingIsEmpty) return undefined;
    throw e;
  }
}

/**
 * `readRouteStatus`: the Installation's routes, their 24-hour counts and last
 * errors, and its delivery queue. `undefined` when this server was built
 * without plugin routes.
 */
export async function fetchRouteStatus(
  store: Store,
  installation: string,
): Promise<InstallationRouteStatus | undefined> {
  const body = await call(store, '/plugin-route-status', installation, {
    missingIsEmpty: true,
  });

  return body === undefined ? undefined : parseRouteStatus(body);
}

/** The tokens the Installation's routes issued, as the server answers them. */
export function routeTokensBody(
  store: Store,
  installation: string,
): Promise<unknown> {
  return call(store, '/plugin-route-tokens', installation);
}

/** Revokes one token; the server answers `{ revoked }`. */
export function revokeRouteTokenBody(
  store: Store,
  installation: string,
  tokenId: string,
): Promise<unknown> {
  return call(store, '/plugin-route-tokens', installation, {
    revoke: tokenId,
  });
}

/** The tokens the Installation's routes issued; never their values. */
export async function fetchRouteTokens(
  store: Store,
  installation: string,
): Promise<RouteToken[]> {
  return parseRouteTokens(await routeTokensBody(store, installation));
}

/** Whether the token was revoked (false when it was already gone). */
export async function revokeRouteToken(
  store: Store,
  installation: string,
  tokenId: string,
): Promise<boolean> {
  const body = await revokeRouteTokenBody(store, installation, tokenId);

  return (body as { revoked?: unknown } | undefined)?.revoked === true;
}
