import type { Agent } from './agent.js';
import type { HeadersObject } from './client.js';
import { getTimestampNow } from './commit.js';

/** Returns a JSON-AD resource of an Authentication */
export async function createAuthentication(subject: string, agent: Agent) {
  const timestamp = getTimestampNow();

  if (!agent.subject) {
    throw new Error('Agent has no subject, cannot authenticate');
  }

  const object = {
    'https://atomicdata.dev/properties/auth/agent': agent.subject,
    'https://atomicdata.dev/properties/auth/requestedSubject': subject,
    'https://atomicdata.dev/properties/auth/publicKey':
      await agent.getPublicKey(),
    'https://atomicdata.dev/properties/auth/timestamp': timestamp,
    'https://atomicdata.dev/properties/auth/signature':
      await agent.createSignature(subject, timestamp),
  };

  return object;
}

/** Localhost Agents are not allowed to sign requests to external domain */
function localTryingExternal(subject: string, agent: Agent) {
  return (
    !subject.startsWith('http://localhost') &&
    agent?.subject?.startsWith('http://localhost')
  );
}

/**
 * Creates authentication headers and signs the request. Does not add headers if
 * the Agents subject is missing.
 */
export async function signRequest(
  /** The resource meant to be fetched */
  subject: string,
  agent: Agent,
  headers: HeadersObject,
): Promise<HeadersObject> {
  const timestamp = getTimestampNow();
  const newHeaders = { ...headers };

  if (agent?.subject && !localTryingExternal(subject, agent)) {
    newHeaders['x-atomic-public-key'] = await agent.getPublicKey();
    newHeaders['x-atomic-signature'] = await agent.createSignature(
      subject,
      timestamp,
    );
    newHeaders['x-atomic-timestamp'] = timestamp.toString();

    if (agent.subject) {
      newHeaders['x-atomic-agent'] = agent.subject;
    }
  }

  return newHeaders;
}

/**
 * How long a signed authentication proof stays valid, mirroring the server's
 * `AUTH_MAX_AGE_MS` in `lib/src/authentication.rs`. Before 0.41 a proof never
 * expired, so anything that stored one could keep presenting it; now anything
 * that stores one has to replace it before it ages out.
 */
export const AUTH_PROOF_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * When a stored proof counts as due for replacement. Comfortably inside
 * {@link AUTH_PROOF_MAX_AGE_MS}, so a request that goes out just before the
 * refresh still reaches the server with minutes to spare.
 */
export const AUTH_PROOF_REFRESH_MS = 2 * 60 * 1000;

/**
 * Every parent domain a host-only cookie could have wrongly been scoped to.
 *
 * `staging.example.com` → `['staging.example.com', 'example.com']`. The TLD
 * itself is never included: browsers reject `Domain=com`, and attempting it
 * would only produce a no-op write.
 */
export function parentDomainsOf(hostname: string): string[] {
  const labels = hostname.split('.');
  const out: string[] = [];

  for (let i = 0; i < labels.length - 1; i++) {
    out.push(labels.slice(i).join('.'));
  }

  return out;
}

/**
 * An auth cookie is only ever valid for the exact server that signed it — its
 * `requestedSubject` is that server's URL — so it must not be sent anywhere
 * else.
 *
 * This used to set `Domain=<hostname>` explicitly, which does the opposite of
 * what it looks like: naming a domain *widens* a cookie to every subdomain.
 * A session minted on `example.com` was therefore sent to
 * `staging.example.com`, where the server rightly rejected it —
 * "Wrong requested subject in auth token, expected https://staging.example.com/…
 * was https://example.com" — and the user was locked out of a sibling
 * deployment by merely having visited the main one.
 *
 * Omitting `Domain` entirely makes the cookie host-only, which is what was
 * meant all along.
 */
const setCookieExpires = (
  name: string,
  value: string,
  serverUrl: string,
  expires_in_ms = AUTH_PROOF_MAX_AGE_MS,
) => {
  const expiry = new Date(Date.now() + expires_in_ms).toUTCString();
  const encodedValue = encodeURIComponent(value);

  // `Secure` whenever the page is served over TLS, so the session never rides
  // along on a plain-http request to the same host. Omitted on http (local
  // dev), where a Secure cookie would simply never be stored.
  const secure =
    typeof window !== 'undefined' && window.location?.protocol === 'https:'
      ? ';Secure'
      : '';

  // No `Domain=`: host-only. See the note above.
  const cookieString = `${name}=${encodedValue};Expires=${expiry};SameSite=Lax;path=/${secure}`;
  document.cookie = cookieString;
};

/**
 * Deletes any copy of `name` that an older build scoped to a parent domain.
 *
 * Shipping the host-only fix is not enough on its own: browsers already hold
 * the over-broad cookie, and it keeps being sent to sibling hosts until it
 * expires. A parent-domain cookie can only be cleared by naming that same
 * domain, so walk them explicitly.
 */
const clearParentDomainCookies = (name: string) => {
  if (typeof document === 'undefined' || typeof location === 'undefined') {
    return;
  }

  // Includes the current hostname deliberately. A cookie written with
  // `Domain=example.com` is a *different* entry from the host-only cookie for
  // `example.com`, and on the apex host it is the very one doing the leaking —
  // skipping it would leave production still poisoning its own subdomains.
  // Deleting by domain does not touch the host-only cookie set alongside it.
  for (const domain of parentDomainsOf(location.hostname)) {
    document.cookie = `${name}=;Max-Age=-99999999;Domain=${domain};path=/`;
  }
};

const COOKIE_NAME_AUTH = 'atomic_session';

/** Sets a cookie for the current Agent, signing the Authentication. It expires after some default time. */
export const setCookieAuthentication = async (
  serverURL: string,
  agent: Agent,
): Promise<void> => {
  // Returns a promise so callers (e.g. the HTTP request signing path
  // in client.fetchResourceHTTP) can await the cookie before issuing
  // the request. Without an await, the first request after `setAgent`
  // race-conditions a 401: the cookie isn't installed yet because the
  // signing is async. The catch is per-caller — failures here are
  // surfaced via the request 401 if the cookie ever did matter.
  try {
    // Drop any parent-domain copy left by an older build first, so the
    // browser isn't left holding two `atomic_session` cookies — the stale
    // wide one would otherwise keep being sent alongside this one.
    clearParentDomainCookies(COOKIE_NAME_AUTH);
    const auth = await createAuthentication(serverURL, agent);
    setCookieExpires(COOKIE_NAME_AUTH, btoa(JSON.stringify(auth)), serverURL);
  } catch (e) {
    console.warn('[Auth] cookie installation failed:', e);
  }
};

const AUTH_TIMESTAMP_PROPERTY =
  'https://atomicdata.dev/properties/auth/timestamp';

/** The value of the auth cookie this browser holds, if it holds one. */
const readAuthCookie = (): string | undefined => {
  if (typeof document === 'undefined') {
    return undefined;
  }

  return document.cookie.match(
    new RegExp(`(?:^|;)\\s*${COOKIE_NAME_AUTH}\\s*=\\s*([^;]+)`),
  )?.[1];
};

/** When the proof inside a cookie value was signed, if it can be read. */
const proofSignedAt = (cookieValue: string): number | undefined => {
  try {
    const proof = JSON.parse(atob(decodeURIComponent(cookieValue)));
    const signedAt = proof?.[AUTH_TIMESTAMP_PROPERTY];

    return typeof signedAt === 'number' ? signedAt : undefined;
  } catch {
    // Not a cookie this library wrote, or not one it can still parse.
    return undefined;
  }
};

/**
 * Whether this browser holds an auth cookie the server will still accept.
 *
 * Presence alone is not enough, and treating it as enough is what produced
 * thousands of 401s a day on staging. The cookie carries a proof signed at the
 * moment it was installed, and since 0.41 the server refuses one older than
 * `AUTH_MAX_AGE_MS` (see {@link AUTH_PROOF_MAX_AGE_MS}). The cookie itself
 * outlived that by a wide margin, so a session went on presenting the same
 * dead proof for as long as the tab stayed open: one staging tab re-sent an
 * identical `signed at` timestamp every five seconds for hours, each time
 * answered with "Authentication timestamp rejected".
 *
 * Reporting an ageing proof as absent is what makes the request path
 * (`Client.fetchResourceHTTP`) sign and install a fresh one, well before the
 * server would refuse it.
 */
export const checkAuthenticationCookie = (): boolean => {
  const value = readAuthCookie();

  if (value === undefined) {
    return false;
  }

  const signedAt = proofSignedAt(value);

  // A proof whose age cannot be read is not one to keep presenting.
  if (signedAt === undefined) {
    return false;
  }

  // Both timestamps come from this device, so the difference is elapsed time
  // regardless of how wrong the device's clock is.
  return Date.now() - signedAt < AUTH_PROOF_REFRESH_MS;
};

export const removeCookieAuthentication = () => {
  document.cookie = `${COOKIE_NAME_AUTH}=;Max-Age=-99999999;path=/`;
  // Signing out must also clear the over-broad cookies older builds wrote,
  // otherwise a "signed out" browser keeps presenting one to sibling hosts.
  clearParentDomainCookies(COOKIE_NAME_AUTH);
};
