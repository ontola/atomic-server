/**
 * Server URLs as people type and read them.
 *
 * Shared by every surface that takes a server from someone or shows one back.
 * Kept in step with `flutter/lib/atomic/server_url.dart`: the same URL typed
 * into either client should mean the same thing.
 */

/**
 * Whether `authority` (`host` or `host:port`) names a machine on this network
 * rather than the internet: loopback, the RFC 1918 private ranges, or mDNS.
 *
 * Not just `localhost`, because `localhost` is only local to the machine that
 * types it. Another device on the network reaches this one by its LAN address,
 * and that address wants `http` for the same reason `localhost` does — no
 * public certificate exists for it.
 */
export function isLocalAddress(authority: string): boolean {
  const host = authority.split(':')[0].toLowerCase();

  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) {
    return true;
  }

  const octets = host.split('.').map(Number);

  if (octets.length !== 4 || octets.some(o => !Number.isInteger(o))) {
    return false;
  }

  const [a, b] = octets;

  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31)
  );
}

/**
 * Turn what someone types in the connect box into a full server URL. A bare
 * `host[:port]` is fine — a local address gets `http://`, anything else
 * `https://` — so no one has to type the scheme.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `${isLocalAddress(trimmed) ? 'http' : 'https'}://${trimmed}`;
}

/**
 * Whether two server URLs point at the same origin — how "is this the one in
 * use?" is decided, tolerant of trailing slashes and paths.
 */
export function sameOrigin(a: string, b: string | undefined): boolean {
  if (!b) {
    return false;
  }

  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * A server's `host:port` for display, so two `localhost`s on different ports
 * (e.g. an embedded node and a stale one) are distinguishable.
 */
export function serverLabel(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}
