import { core } from './ontologies/core.js';
import { dataBrowser } from './ontologies/dataBrowser.js';
import { server } from './ontologies/server.js';
import {
  agentSubjectFromPublicKey,
  bindAccessAgent,
  issueAccessAgent,
} from './issue-access-agent.js';
import type { Store } from './store.js';

/**
 * OAuth-style scope URI, not a resource. Expand to the workspaces the user
 * can currently write to at consent time — the AS interprets the scope, the
 * client does not name the user's drive DIDs.
 */
export const APP_KEY_SCOPE_ALL_WORKSPACES =
  'https://atomicdata.dev/app-keys/all-workspaces';

const REQUEST_LOCAL_ID_PREFIX = 'app-key-request:';

export interface AccessRequestSpec {
  name: string;
  description?: string;
  write: boolean;
  /** Resource subjects and/or {@link APP_KEY_SCOPE_ALL_WORKSPACES}. */
  targets: string[];
  /** App-minted public key or `did:ad:agent:…`. */
  publicKey?: string;
  redirectUri?: string;
  /** Correlation id. Also the request's `localId`, so the same authorize URL is idempotent. */
  state?: string;
}

export type ParseAuthorizeResult =
  | { ok: true; spec: AccessRequestSpec }
  | { ok: false; error: string };

export interface ApproveAccessRequestResult {
  subject: string;
  /** Present only when this session minted the keypair (no `publicKey` on the request). */
  secret?: string;
}

/**
 * Parse an OAuth-shaped `/app/authorize` query.
 *
 * | OAuth | Here |
 * | --- | --- |
 * | `client_id` | `name` (display) + optional `agent` / `public_key` |
 * | `scope` | `write` + `targets` (subjects, or `*` for all workspaces) |
 * | `redirect_uri` | `redirect_uri` — never carries the secret |
 * | `state` | `state` |
 */
export function parseAuthorizeQuery(
  search: URLSearchParams | string,
): ParseAuthorizeResult {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const name = (params.get('name') ?? '').trim();

  if (!name) {
    return { ok: false, error: 'An app key request needs a name' };
  }

  const writeRaw = (params.get('write') ?? '').trim().toLowerCase();
  const write = writeRaw === '1' || writeRaw === 'true' || writeRaw === 'yes';

  const targetsRaw = (params.get('targets') ?? params.get('scope') ?? '*').trim();
  const targets = parseTargetsParam(targetsRaw);

  if (targets.length === 0) {
    return { ok: false, error: 'Choose at least one resource' };
  }

  const agent = (params.get('agent') ?? '').trim();
  const publicKeyRaw = (
    params.get('public_key') ??
    params.get('publicKey') ??
    ''
  ).trim();
  const publicKey = agent || publicKeyRaw || undefined;
  const redirectUri = (
    params.get('redirect_uri') ??
    params.get('redirectUri') ??
    ''
  ).trim();
  const state = (params.get('state') ?? '').trim();
  const description = (params.get('description') ?? '').trim();

  return {
    ok: true,
    spec: {
      name,
      write,
      targets,
      ...(publicKey ? { publicKey } : {}),
      ...(redirectUri ? { redirectUri } : {}),
      ...(state ? { state } : {}),
      ...(description ? { description } : {}),
    },
  };
}

function parseTargetsParam(raw: string): string[] {
  if (
    raw === '' ||
    raw === '*' ||
    raw === 'all' ||
    raw === 'all-workspaces'
  ) {
    return [APP_KEY_SCOPE_ALL_WORKSPACES];
  }

  return [
    ...new Set(
      raw
        .split(',')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part =>
          part === '*' || part === 'all' || part === 'all-workspaces'
            ? APP_KEY_SCOPE_ALL_WORKSPACES
            : part,
        ),
    ),
  ];
}

/** Turn scope URIs into the resources that will actually receive the ACL. */
export function expandAccessRequestTargets(
  targets: string[],
  workspaces: string[],
): string[] {
  const expanded: string[] = [];

  for (const target of targets) {
    if (target === APP_KEY_SCOPE_ALL_WORKSPACES) {
      expanded.push(...workspaces);
    } else {
      expanded.push(target);
    }
  }

  return [...new Set(expanded)];
}

export function isAllWorkspacesScope(targets: string[]): boolean {
  return targets.includes(APP_KEY_SCOPE_ALL_WORKSPACES);
}

/**
 * Persist a pending authorization in the well-known requests folder.
 * Same `state` on the same drive returns the existing row (OAuth retry).
 */
export async function createAccessRequest(
  store: Store,
  opts: AccessRequestSpec & { parent: string; drive: string },
): Promise<string> {
  const current = store.getAgent();

  if (!current?.subject) {
    throw new Error('Cannot store an app key request while signed out');
  }

  const name = opts.name.trim();

  if (!name) {
    throw new Error('An app key request needs a name');
  }

  if (opts.targets.length === 0) {
    throw new Error('Choose at least one resource');
  }

  const localId = opts.state
    ? `${REQUEST_LOCAL_ID_PREFIX}${opts.state}`
    : `${REQUEST_LOCAL_ID_PREFIX}fp:${opts.drive}:${fingerprintRequest(opts)}`;

  if (localId) {
    for (const loaded of store.resources.values()) {
      if (loaded.get(core.properties.localId) === localId) {
        return loaded.subject;
      }
    }
  }

  const publicKey = opts.publicKey
    ? agentSubjectFromPublicKey(opts.publicKey).publicKey
    : undefined;
  const agent = publicKey
    ? agentSubjectFromPublicKey(publicKey).subject
    : undefined;

  const resource = await store.newResource({
    parent: opts.parent,
    propVals: {
      [core.properties.name]: name,
      [dataBrowser.properties.resources]: opts.targets,
      [server.properties.write]: opts.write,
      ...(opts.description
        ? { [core.properties.description]: opts.description }
        : {}),
      ...(publicKey ? { [server.properties.publicKey]: publicKey } : {}),
      ...(agent ? { [server.properties.agent]: agent } : {}),
      ...(opts.redirectUri
        ? { [server.properties.destination]: opts.redirectUri }
        : {}),
      ...(localId ? { [core.properties.localId]: localId } : {}),
    },
  });
  await resource.save();
  resource.new = false;
  await store.notifyResourceManuallyCreated(resource);

  return resource.subject;
}

export function readAccessRequest(
  resource: Awaited<ReturnType<Store['getResource']>>,
): AccessRequestSpec {
  const name = ((resource.get(core.properties.name) as string | undefined) ?? '')
    .trim();
  const description = (
    (resource.get(core.properties.description) as string | undefined) ?? ''
  ).trim();
  const write = Boolean(resource.get(server.properties.write));
  const targets = (
    (resource.get(dataBrowser.properties.resources) as string[] | undefined) ??
    []
  ).filter(Boolean);
  const publicKey = (
    (resource.get(server.properties.publicKey) as string | undefined) ??
    (resource.get(server.properties.agent) as string | undefined) ??
    ''
  ).trim();
  const redirectUri = (
    (resource.get(server.properties.destination) as string | undefined) ?? ''
  ).trim();
  const localId = (
    (resource.get(core.properties.localId) as string | undefined) ?? ''
  ).trim();
  const state = localId.startsWith(REQUEST_LOCAL_ID_PREFIX)
    ? localId.slice(REQUEST_LOCAL_ID_PREFIX.length)
    : undefined;
  const clientState =
    state && !state.startsWith('fp:') ? state : undefined;

  return {
    name,
    write,
    targets,
    ...(description ? { description } : {}),
    ...(publicKey ? { publicKey } : {}),
    ...(redirectUri ? { redirectUri } : {}),
    ...(clientState ? { state: clientState } : {}),
  };
}

/**
 * Consent: grant the requested (or down-scoped) targets, then drop the
 * pending row. The issued agent in the App keys folder is the grant.
 */
export async function approveAccessRequest(
  store: Store,
  requestSubject: string,
  opts: {
    targets: string[];
    parent?: string;
  },
): Promise<ApproveAccessRequestResult> {
  const request = await store.getResource(requestSubject);

  if (request.error) {
    throw request.error;
  }

  const spec = readAccessRequest(request);

  if (opts.targets.length === 0) {
    throw new Error('Choose at least one resource');
  }

  const grantOpts = {
    name: spec.name,
    description: spec.description,
    write: spec.write,
    targets: opts.targets,
    parent: opts.parent,
  };

  let result: ApproveAccessRequestResult;

  if (spec.publicKey) {
    const bound = await bindAccessAgent(store, {
      ...grantOpts,
      publicKey: spec.publicKey,
    });
    result = { subject: bound.subject };
  } else {
    const issued = await issueAccessAgent(store, grantOpts);
    result = { subject: issued.subject, secret: issued.secret };
  }

  await request.destroy();

  return result;
}

export async function denyAccessRequest(
  store: Store,
  requestSubject: string,
): Promise<void> {
  const request = await store.getResource(requestSubject);

  if (request.error) {
    throw request.error;
  }

  await request.destroy();
}

/**
 * Front-channel return after consent. Never includes the secret — same reason
 * OAuth deprecated the implicit flow. Copy/paste is skipped when the app
 * sent a public key *and* a safe `redirect_uri`: it already holds the
 * private key, so `agent=` on the return URL is enough.
 */
export function authorizeRedirectUrl(
  redirectUri: string | undefined,
  params: {
    granted: boolean;
    agent?: string;
    state?: string;
    error?: string;
  },
): string | undefined {
  if (!redirectUri || !isSafeRedirectUri(redirectUri)) {
    return undefined;
  }

  try {
    const url = new URL(redirectUri);
    url.searchParams.set('granted', params.granted ? 'true' : 'false');

    if (params.granted && params.agent) {
      url.searchParams.set('agent', params.agent);
    }

    if (!params.granted) {
      url.searchParams.set('error', params.error ?? 'access_denied');
    }

    if (params.state) {
      url.searchParams.set('state', params.state);
    }

    return url.toString();
  } catch {
    return undefined;
  }
}

/** Host or scheme shown on the consent screen (“you’ll return to …”). */
export function authorizeReturnLabel(
  redirectUri: string | undefined,
): string | undefined {
  if (!redirectUri || !isSafeRedirectUri(redirectUri)) {
    return undefined;
  }

  try {
    const url = new URL(redirectUri);

    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return url.host;
    }

    const scheme = url.protocol.replace(/:$/, '');
    return url.host ? `${scheme}://${url.host}` : `${scheme}:`;
  } catch {
    return undefined;
  }
}

export function isSafeRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);

    if (url.protocol === 'https:') {
      return true;
    }

    if (url.protocol === 'http:') {
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    }

    if (url.protocol === 'javascript:' || url.protocol === 'data:') {
      return false;
    }

    // Native apps: `raycast://`, `atomic://`, …
    return url.protocol.length > 1 && url.protocol.endsWith(':');
  } catch {
    return false;
  }
}

function fingerprintRequest(spec: AccessRequestSpec): string {
  return [
    spec.name,
    spec.write ? 'w' : 'r',
    [...spec.targets].sort().join(','),
    spec.publicKey ?? '',
    spec.redirectUri ?? '',
  ].join('|');
}
