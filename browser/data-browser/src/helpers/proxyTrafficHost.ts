// @wc-ignore-file

/** How to run your own integration proxy instead of the default one. */
export const PROXY_SELF_HOSTING_URL =
  'https://github.com/ontola/atomic-plugins/blob/main/integration-proxy/SELF_HOSTING.md';

const ATOMIC_PLACE = 'atomic.place';

/**
 * The name to show for the integration proxy a connection's traffic goes
 * through: `atomic.place` for atomic.place or any of its subdomains (so
 * `integrations.atomic.place` reads as the service, not a machine), otherwise
 * the proxy's own host, port included. Falls back to the input when it is not
 * a URL, so a notice never hides where traffic goes.
 */
export function proxyTrafficHost(proxy: string): string {
  let url: URL;

  try {
    url = new URL(proxy);
  } catch {
    return proxy;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');

  if (hostname === ATOMIC_PLACE || hostname.endsWith(`.${ATOMIC_PLACE}`)) {
    return ATOMIC_PLACE;
  }

  return url.host;
}
