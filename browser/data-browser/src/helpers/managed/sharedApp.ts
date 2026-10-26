import { safePortalUrl } from './api';

/**
 * Where to send someone who opened the app on a node's own address
 * (`node1.atomicserver.eu`) instead of on the shared app of the portal that
 * manages it (`app.atomic.place`).
 *
 * A node's origin is a different site from the portal: the portal's session
 * cookie never reaches it and the control plane refuses its cross-origin
 * calls, so Cloud Vault and "Sign in" cannot work there however the person
 * signs in. The portal derives its app host the same way (`app.` + its own
 * hostname), see `defaultAtomicAppBase` in the portal.
 *
 * Undefined when there is nothing to fix: no known portal, this origin is the
 * portal's own site, or it is not a public https host (localhost, a
 * self-hoster's own origin without a managed node).
 */
export function sharedAppUrl(
  here: Pick<
    Location,
    'origin' | 'hostname' | 'protocol' | 'pathname' | 'search' | 'hash'
  >,
  portalUrl: string | null | undefined,
): string | undefined {
  const portal = safePortalUrl(portalUrl);

  if (!portal || here.protocol !== 'https:') return undefined;

  const portalHost = new URL(portal).hostname;
  const appHost = portalHost.startsWith('app.')
    ? portalHost
    : `app.${portalHost}`;
  const bareHost = portalHost.replace(/^app\./, '');

  if (here.hostname === bareHost || here.hostname.endsWith(`.${bareHost}`)) {
    return undefined;
  }

  const target = new URL(`https://${appHost}${here.pathname}${here.search}`);

  // Keep a `?server=` the link already carried; it is the more specific hint.
  if (!target.searchParams.has('server')) {
    target.searchParams.set('server', here.origin);
  }

  target.hash = here.hash;

  return target.toString();
}
