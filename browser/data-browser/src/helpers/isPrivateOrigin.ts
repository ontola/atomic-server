/**
 * Can only this machine or its local network reach `url`?
 *
 * True for `localhost`, loopback and private-range addresses. Invite links and
 * pairing codes built on such an address cannot be opened from anywhere else.
 * Unparseable input counts as not private, so we never show a false warning.
 */
export function isPrivateOrigin(url: string | undefined): boolean {
  if (!url) return false;

  let host: string;

  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  // IPv6 hostnames keep their brackets in `URL.hostname`.
  host = host.replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  if (host === '::1' || host.startsWith('fe80:')) return true;

  // Unique local addresses, fc00::/7.
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;

  const parts = host.split('.');

  if (parts.length !== 4 || !parts.every(p => /^\d{1,3}$/.test(p))) {
    return false;
  }

  const [a, b] = parts.map(Number);

  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}
