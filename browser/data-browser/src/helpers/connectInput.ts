import { looksLikePairingUri } from '@tomic/lib';
import { normalizeServerUrl } from './serverUrl';
import {
  isLocalNetworkUrl,
  requiresLocalNetworkPermission,
} from './localNetworkAccess';

/**
 * What someone typed or pasted into the "Add a device" box.
 *
 * One box takes both kinds of thing a device can be reached by: a pairing code
 * (a device you carry) or an address (an always-on device). The person should
 * not have to say which, so it is decided here.
 */
export type ConnectInput =
  | { kind: 'empty' }
  /** A pairing code or deep link, to hand to the pairing flow as typed. */
  | { kind: 'code'; code: string }
  /** An address, already given a scheme. */
  | { kind: 'server'; url: string }
  | { kind: 'invalid' };

export function classifyConnectInput(raw: string): ConnectInput {
  const input = raw.trim();

  if (!input) return { kind: 'empty' };

  if (looksLikePairingUri(input)) return { kind: 'code', code: input };

  // An address has no spaces, and an identifier with another scheme is not one.
  if (/\s/.test(input) || /^(atomic|did):/i.test(input)) {
    return { kind: 'invalid' };
  }

  try {
    const url = new URL(normalizeServerUrl(input));

    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      return { kind: 'invalid' };
    }

    return { kind: 'server', url: normalizeServerUrl(input) };
  } catch {
    return { kind: 'invalid' };
  }
}

/**
 * Why a server that did not answer might not have answered, said so a person
 * can act on it. A local server is the common case: the address is fine, but
 * the browser may be holding the request back.
 */
export function describeUnreachable(url: string): string {
  if (!isLocalNetworkUrl(url)) return 'Could not reach that address.';

  if (url.startsWith('https://')) {
    return `Could not reach ${url}. A server on your own machine usually speaks plain http, so try ${url.replace('https://', 'http://')}.`;
  }

  if (requiresLocalNetworkPermission(url)) {
    return `Could not reach ${url}. Check that the server is running, and that this site is allowed to access other apps and services on this device (the lock icon in the address bar, then site settings). The server must also allow this site's origin.`;
  }

  return `Could not reach ${url}. Check that the server is running on that port.`;
}
