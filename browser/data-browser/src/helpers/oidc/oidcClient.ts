// @wc-ignore-file
/**
 * The browser side of optional OIDC sign-in (`planning/oidc-sign-in.md`).
 *
 * The server proves who the user is at the identity provider and hands back a
 * short-lived ticket in the URL fragment. The ticket lets this browser link an
 * agent it holds the key for, or fetch the recovery blob already linked to the
 * identity. It is not a login session.
 */

export type OidcReturn =
  | { kind: 'ticket'; ticket: string }
  | { kind: 'error'; code: OidcErrorCode };

export type OidcErrorCode = 'denied' | 'expired' | 'policy' | 'provider';

const ERROR_CODES: readonly OidcErrorCode[] = [
  'denied',
  'expired',
  'policy',
  'provider',
];

export type OidcSession =
  | { linked: false; name: string }
  | { linked: true; name: string; agent: string; recovery: string };

/** Reads `#oidc_ticket=…` / `#oidc_error=…`. Anything else is not ours. */
export function parseOidcHash(hash: string): OidcReturn | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const ticket = params.get('oidc_ticket');

  if (ticket && /^[A-Za-z0-9_-]{20,128}$/.test(ticket)) {
    return { kind: 'ticket', ticket };
  }

  const error = params.get('oidc_error');

  if (error) {
    const code = ERROR_CODES.find(c => c === error);

    return { kind: 'error', code: code ?? 'provider' };
  }

  return null;
}

/** Where the browser goes to start signing in. Returns to `returnPath`. */
export function oidcStartUrl(serverUrl: string, returnPath: string): string {
  const base = serverUrl.replace(/\/+$/, '');

  return `${base}/oidc/start?return=${encodeURIComponent(returnPath)}`;
}

/** The exact bytes an agent signs to link itself to a ticket. */
export function linkMessage(ticket: string, agentSubject: string): string {
  return `atomic-oidc-link:v1:${ticket}:${agentSubject}`;
}

async function postJson<T>(
  serverUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${serverUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });

  return {
    status: res.status,
    data: (await res.json().catch(() => ({}))) as T,
  };
}

export async function fetchOidcSession(
  serverUrl: string,
  ticket: string,
): Promise<OidcSession> {
  const { status, data } = await postJson<Record<string, unknown>>(
    serverUrl,
    '/oidc/session',
    { ticket },
  );

  if (status !== 200) {
    throw new Error('Your sign-in expired. Please start again.');
  }

  const name = typeof data.name === 'string' ? data.name : '';

  if (
    data.linked === true &&
    typeof data.agent === 'string' &&
    typeof data.recovery === 'string'
  ) {
    return { linked: true, name, agent: data.agent, recovery: data.recovery };
  }

  return { linked: false, name };
}

export class AlreadyLinkedError extends Error {
  constructor() {
    super('This account is already linked to an identity.');
    this.name = 'AlreadyLinkedError';
  }
}

/** Anything with an agent's `sign`, so tests need no real Agent. */
export type LinkSigner = { sign(message: string): Promise<string> };

export async function linkOidcAgent(
  serverUrl: string,
  args: {
    ticket: string;
    agentSubject: string;
    signer: LinkSigner;
    recovery: string;
    replace?: boolean;
  },
): Promise<void> {
  const signature = await args.signer.sign(
    linkMessage(args.ticket, args.agentSubject),
  );
  const { status } = await postJson(serverUrl, '/oidc/link', {
    ticket: args.ticket,
    agent: args.agentSubject,
    signature,
    recovery: args.recovery,
    replace: args.replace ?? false,
  });

  if (status === 409) throw new AlreadyLinkedError();

  if (status !== 200) {
    throw new Error('Could not link your account. Please start again.');
  }
}
