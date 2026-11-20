// @wc-ignore-file
/**
 * Integration-proxy connections, as the page manages them for apps
 * (ontola/atomic-plugins#54).
 *
 * The proxy account is the user's Atomic agent. A **connection** (platform +
 * sealed provider token) lives at the proxy and belongs to the agent that
 * redeemed it; a **delegation** says "app agent X may use connection C". The
 * page signs every call it makes to the proxy with the user key, using
 * version 2 request signatures (method and body covered).
 *
 * An app's view runs in a null-origin frame with no storage and never holds
 * the user key. It makes its own key in memory, and the page mints it a
 * short-lived **capability**, signed with the user key and bound to that
 * frame key, after checking that the connection is delegated to this app. The
 * frame hands its signed request to the host for relay; see `viewClient.js`.
 *
 * Built-in views use a separate, owner-signed read relay. The host derives the
 * connection key in memory and includes it in the request it signs. The
 * sandbox never handles the key or a signing capability for the connection.
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { AuthenticatedPrincipalDescription } from 'syncables/browser';
import {
  AGENT_VAULT_PROOF_MESSAGE,
  SIGNATURE_VERSION_HEADER,
  agentSubject,
  canonicalizeScheme,
  decodeB64,
  requestSignatureMessageV2,
  sha256Hex,
  signRequest,
  type Agent,
} from '@tomic/react';
import { agentVaultProof } from './managed/vault';

const PENDING = 'atomic-proxy-connect-v2:';
const KEYED_CONNECTION = 'atomic-proxy-keyed-v1:';
const KEYED_SELECTION = 'atomic-proxy-keyed-selection-v1:';
const CONNECTION_KEY_HEADER = 'x-connection-key';
const PROXY_READ_HEADERS = ['link', 'retry-after', 'etag', 'content-type'];
const MAX_BODY = 10 * 1024 * 1024;
const TIMEOUT = 30_000;

/**
 * How far ahead a capability's `exp` is set. The proxy allows 15 minutes
 * (900 s) by its own clock and ±5 min skew; 10 minutes keeps a capability
 * valid at a proxy whose clock is up to 5 minutes behind this device's.
 */
export const CAPABILITY_TTL_SECONDS = 600;
export const CAPABILITY_MESSAGE_PREFIX = 'integration-proxy-capability-v2\n';

/** Who a connection is being made for. */
export interface ConnectScope {
  drive: string;
  app: string;
  /** The app's own agent (`atomic:agent:…`), which gets the delegation. */
  appAgent: string;
}

interface PendingConnect extends ConnectScope {
  origin: string;
  platform: string;
  /** Where to go once the proxy sends the person back. */
  returnTo: string;
  expires: number;
  codeVerifier: string;
  label: string;
  keyed?: {
    owner: string;
    connectionId: string;
    reconnect?: PrincipalReconnect;
  };
}

export interface ConnectionPrincipal {
  kind: 'authenticated';
  namespace: string;
  subject: string | number;
  clientContext?: string;
}

/** Non-secret proof saved after a host-verified identity response. */
export interface KeyedPrincipalProvenance {
  principal?: ConnectionPrincipal;
  /** Historical marker format stored an already-verified numeric subject. */
  legacyNumericSubject?: number;
}

interface PrincipalReconnect {
  slotId: string;
  principal: ConnectionPrincipal;
  operationId: string;
  previousActiveId: string;
}

/** Non-secret connection provenance, local to this signed-in browser. */
interface KeyedConnectionMarker {
  platform: string;
  principal?: ConnectionPrincipal;
  operationId?: string;
  /** Compatibility only: old markers stored a decimal numeric provider ID. */
  legacyPrincipalId?: string;
  activeId?: string;
  replacement?: true;
}

function legacyPrincipalOperation(
  marker: KeyedConnectionMarker | undefined,
  value: ConnectionPrincipal,
  descriptions: AuthenticatedPrincipalDescription[],
): string | undefined {
  const principal = connectionPrincipal(value);
  if (
    !marker?.legacyPrincipalId ||
    marker.principal ||
    !principal ||
    principal.clientContext !== undefined ||
    typeof principal.subject !== 'number' ||
    !Number.isSafeInteger(principal.subject) ||
    principal.subject <= 0 ||
    String(principal.subject) !== marker.legacyPrincipalId
  )
    return;
  const declared = descriptions.filter(
    description =>
      description.identifier.scope === 'provider' &&
      description.identifier.stable === true &&
      description.identifier.reassigned === false,
  );

  return declared.length === 1 && declared[0].namespace === principal.namespace
    ? declared[0].operationId || undefined
    : undefined;
}

function validConnectionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function connectionPrincipal(value: unknown): ConnectionPrincipal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const p = value as Partial<ConnectionPrincipal>;
  if (
    p.kind !== 'authenticated' ||
    typeof p.namespace !== 'string' ||
    !p.namespace ||
    !(
      (typeof p.subject === 'string' && p.subject.length > 0) ||
      (typeof p.subject === 'number' && Number.isSafeInteger(p.subject))
    ) ||
    (p.clientContext !== undefined &&
      (typeof p.clientContext !== 'string' || !p.clientContext))
  )
    return;

  return {
    kind: 'authenticated',
    namespace: p.namespace,
    subject: p.subject,
    ...(p.clientContext === undefined
      ? {}
      : { clientContext: p.clientContext }),
  };
}

function samePrincipal(
  left: ConnectionPrincipal,
  right: ConnectionPrincipal,
): boolean {
  return (
    left.namespace === right.namespace &&
    left.subject === right.subject &&
    left.clientContext === right.clientContext
  );
}

export type PrincipalCatalogLoader = (
  origin: string,
  platform: string,
  signal: AbortSignal,
) => Promise<import('syncables/browser').OpenApiDocument>;

const loadPrincipalCatalog: PrincipalCatalogLoader = async (
  origin,
  platform,
  signal,
) => {
  const { fetchSyncableDocument } =
    await import('@chunks/PluginRuns/syncableDocument');

  return (await fetchSyncableDocument(origin, signal, platform))
    .document as unknown as import('syncables/browser').OpenApiDocument;
};

export interface ConnectionReference {
  connectionId: string;
  platform: string;
  label?: string;
  canReconnect?: boolean;
}

/** One row of `GET /connections`, as far as this page reads it. */
export interface ProxyConnection {
  connection_id: string;
  platform: string;
  owner?: string;
  label?: string;
  created_at?: string | number;
  last_used_at?: string | number;
  delegations: { agent: string; label?: string }[];
}

/** What the frame gets: the capability, and where to use it. */
export interface MintedCapability {
  capability: string;
  /** The proxy origin, the capability's `aud`. */
  aud: string;
  /** Unix seconds. */
  exp: number;
  connectionId: string;
  platform: string;
}

/** What `hostStore` needs for one app's frame. */
export interface ProxyHost {
  /** Optional host-selected transport. The frame cannot opt into its authority. */
  request?: (
    request: {
      platform?: string;
      connectionId?: string;
      path?: string;
      query?: unknown;
      method?: string;
      body?: string;
      ifMatch?: string;
    },
    signal?: AbortSignal,
  ) => Promise<{
    status: number;
    headers: Record<string, string>;
    text: string;
  }>;
  capability(request: {
    platform: string;
    connectionId: string;
    publicKey: string;
  }): Promise<MintedCapability>;
  connections(platform: string): Promise<ConnectionReference[]>;
  /** The configured proxy's origin: the only place `proxyFetch` may go. */
  origin: string;
}

/** An error the proxy returned: `{error, message}` and the HTTP status. */
export class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export const isPlatformId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value);

export const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

/**
 * `atomic:agent:<base64url-no-pad key>` for an Ed25519 agent id in either
 * prefix (`atomic:agent:`, `did:ad:agent:`) and either base64 alphabet, the
 * form the proxy stores and compares. Throws for anything else.
 */
export function canonicalAgent(id: string): string {
  const match = /^(?:atomic:agent:|did:ad:agent:)([A-Za-z0-9+/_=-]+)$/.exec(
    id.trim(),
  );
  if (!match) throw new Error(`Not an agent id: ${id}`);
  const key = decodeB64(match[1]);
  if (key.length !== 32) throw new Error(`Not an Ed25519 agent id: ${id}`);

  return agentSubject(base64url(key));
}

export async function readLimitedResponseText(
  response: Response,
  source = 'Proxy',
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new Error(source + ' response exceeds 10 MB');
      text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function deriveConnectionKey(
  agent: Agent,
  origin: string,
  platform: string,
  connectionId: string,
): Promise<string> {
  const proof = await agentVaultProof(agent, AGENT_VAULT_PROOF_MESSAGE);
  const info = new TextEncoder().encode(
    JSON.stringify([
      'atomic-integration-proxy-key-v1',
      origin,
      platform,
      connectionId,
    ]),
  );

  return 'k1.' + base64url(hkdf(sha256, proof, undefined, info, 32));
}

function parseBody(text: string): unknown {
  if (text === '') return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The capability payload and the bytes the user key signs.
 *
 * Wire form (agreed with the proxy, #54): `Authorization: Capability
 * <payload>.<sig>`, where `payload` is base64url of the JSON claims and `sig`
 * is the user key's Ed25519 signature over
 * `integration-proxy-capability-v2\n` followed by those same JSON bytes.
 */
export function capabilityClaims(claims: {
  connection_id: string;
  platform: string;
  aud: string;
  app: string;
  cnf: string;
  exp: number;
}): { json: string; message: Uint8Array } {
  // Key order as in the proposal; the proxy verifies the bytes, not a
  // re-serialization, so it does not depend on it.
  const json = JSON.stringify({
    v: 2,
    connection_id: claims.connection_id,
    platform: claims.platform,
    aud: claims.aud,
    app: claims.app,
    cnf: claims.cnf,
    exp: claims.exp,
  });

  return {
    json,
    message: new TextEncoder().encode(CAPABILITY_MESSAGE_PREFIX + json),
  };
}

export class ProxyConnections {
  constructor(
    private storage: Storage,
    /** The proxy origin. */
    readonly origin: string,
    /** The signed-in user. Every call the page makes is signed with it. */
    private agent: () => Agent | undefined,
    private http: typeof fetch = (...args) => fetch(...args),
    private now: () => number = Date.now,
    private catalog: PrincipalCatalogLoader = loadPrincipalCatalog,
  ) {}

  private user(): { agent: Agent; subject: Promise<string> } {
    const agent = this.agent();
    if (!agent) throw new Error('Sign in to use integration connections.');

    return {
      agent,
      subject: agent.getPublicKey().then(key => agentSubject(key)),
    };
  }

  /** One call to the proxy, signed v2 with the user key. */
  private async call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    signer = this.user(),
  ): Promise<unknown> {
    const { agent, subject } = signer;
    const url = new URL(path, this.origin);
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers = await signRequest(
      url.href,
      agent,
      text === undefined ? {} : { 'Content-Type': 'application/json' },
      { method, body: text, agentSubject: await subject },
    );
    const response = await this.http(url.href, {
      method,
      body: text,
      headers,
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const parsed = parseBody(await readLimitedResponseText(response));

    if (!response.ok) {
      const error = parsed as { error?: unknown; message?: unknown } | null;
      const code = typeof error?.error === 'string' ? error.error : undefined;
      const message =
        typeof error?.message === 'string'
          ? error.message
          : `HTTP ${response.status}`;
      throw new ProxyError(
        response.status,
        code,
        `The integration proxy refused ${method} ${url.pathname}: ${message}`,
      );
    }

    return parsed;
  }

  /**
   * Starts the PKCE handoff and returns the proxy URL to send the person to.
   * The proxy only returns to `/app/integrations`, so `returnTo` is where the
   * return handler goes afterwards. No proxy login: the redeem that follows
   * is signed with the user key, and that makes the user the owner.
   */
  async start(
    scope: ConnectScope,
    platform: string,
    returnTo: string,
    label: string,
    pageOrigin = location.origin,
  ): Promise<string> {
    return this.startHandoff(scope, platform, returnTo, label, pageOrigin);
  }

  /** Start a first-party connection using the proxy's client-held key ABI. */
  async startKeyed(
    scope: ConnectScope,
    platform: string,
    returnTo: string,
    label: string,
    pageOrigin = location.origin,
  ): Promise<string> {
    return this.startKeyedHandoff(scope, platform, returnTo, label, pageOrigin);
  }

  /** Reconnect a stable slot to a fresh credential for the same typed principal. */
  async startKeyedReconnect(
    scope: ConnectScope,
    platform: string,
    slotConnectionId: string,
    returnTo: string,
    label: string,
    pageOrigin = location.origin,
  ): Promise<string> {
    return this.startKeyedHandoff(
      scope,
      platform,
      returnTo,
      label,
      pageOrigin,
      slotConnectionId,
    );
  }

  private async startKeyedHandoff(
    scope: ConnectScope,
    platform: string,
    returnTo: string,
    label: string,
    pageOrigin: string,
    slotId?: string,
  ): Promise<string> {
    const signer = this.user();
    const owner = await signer.subject;
    let reconnect: PrincipalReconnect | undefined;

    if (slotId !== undefined) {
      const slot = this.keyedSlot(owner, platform, slotId);
      if (!slot?.principal || !slot.operationId)
        throw new Error(
          'A verified account identity is required to reconnect this source.',
        );
      reconnect = {
        slotId,
        principal: slot.principal,
        operationId: slot.operationId,
        previousActiveId: slot.activeId ?? slotId,
      };
    }

    // Detect an agent that cannot derive a reproducible key before OAuth.
    await agentVaultProof(signer.agent, AGENT_VAULT_PROOF_MESSAGE);

    return this.startHandoff(scope, platform, returnTo, label, pageOrigin, {
      owner,
      connectionId: base64url(crypto.getRandomValues(new Uint8Array(32))),
      reconnect,
    });
  }

  private async startHandoff(
    scope: ConnectScope,
    platform: string,
    returnTo: string,
    label: string,
    pageOrigin: string,
    keyed?: PendingConnect['keyed'],
  ): Promise<string> {
    if (!isPlatformId(platform)) throw new Error('Invalid platform');
    const back = new URL(returnTo, pageOrigin);
    if (back.origin !== pageOrigin) throw new Error('Invalid return URL');
    const appAgent = canonicalAgent(scope.appAgent);

    const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const codeChallenge = base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(codeVerifier),
        ),
      ),
    );
    const callback = new URL('/app/integrations', pageOrigin);
    callback.searchParams.set('integration_state', state);
    callback.searchParams.set('platform', platform);
    const url = new URL('/connect', this.origin);

    for (const [k, v] of Object.entries({
      platform,
      redirect_uri: callback.href,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }))
      url.searchParams.set(k, v);

    const pending: PendingConnect = {
      ...scope,
      appAgent,
      origin: this.origin,
      platform,
      returnTo: back.href,
      expires: this.now() + 600_000,
      codeVerifier,
      label,
      keyed,
    };
    this.storage.setItem(PENDING + state, JSON.stringify(pending));

    return url.href;
  }

  private pending(state: string): PendingConnect | undefined {
    const raw = this.storage.getItem(PENDING + state);
    if (!raw) return undefined;

    try {
      return JSON.parse(raw) as PendingConnect;
    } catch {
      return undefined;
    }
  }

  /** Whether `params` is a return from a handoff this browser started. */
  isReturn(params: URLSearchParams): boolean {
    const state = params.get('integration_state');

    return !!state && !!this.pending(state);
  }

  /** Read the built-in app recovery link before finish consumes the handoff. */
  keyedReturnTo(
    params: URLSearchParams,
    pageOrigin = location.origin,
  ): string | undefined {
    const state = params.get('integration_state');
    const pending = state ? this.pending(state) : undefined;
    if (!pending?.keyed) return;

    try {
      const target = new URL(pending.returnTo);
      if (
        (target.protocol === 'https:' || target.protocol === 'http:') &&
        target.origin === pageOrigin &&
        !target.username &&
        !target.password
      )
        return target.href;
    } catch {
      // A malformed target cannot be used as a recovery link.
    }
  }

  /**
   * Redeems the proxy's handoff code, signed by the new connection's owner.
   * For an installed app, it then delegates the connection to the app agent.
   * Returns where to go next. A refusal at the proxy
   * (`error=access_denied`) drops the pending handoff and still returns
   * there, so the app can offer to connect again.
   */
  async finish(
    params: URLSearchParams,
  ): Promise<{ returnTo: string; connected: boolean; connectionId?: string }> {
    const state = params.get('integration_state') ?? '';
    const c = this.pending(state);
    // Consumed before anything else: the verifier is single-use either way.
    this.storage.removeItem(PENDING + state);

    if (!c || c.origin !== this.origin)
      throw new Error(
        'This connection return is not one this browser started.',
      );

    if (params.get('platform') !== c.platform || c.expires < this.now())
      throw new Error('The connection return expired. Connect again.');

    const code = params.get('connection_code');

    if (!code || code.length > 4096) {
      return { returnTo: c.returnTo, connected: false };
    }

    const signer = this.user();
    const keyed = c.keyed;
    let keyFields:
      | { connection_id: string; connection_key: string }
      | undefined;

    if (keyed) {
      const { owner, connectionId, reconnect } = keyed;
      if (owner !== (await signer.subject))
        throw new Error(
          'Sign in with the Atomic account that started this connection.',
        );
      const key = await deriveConnectionKey(
        signer.agent,
        this.origin,
        c.platform,
        connectionId,
      );
      // Persist only the derivation marker. Record it before redeem so a lost
      // response cannot make an otherwise successful connection undiscoverable.
      this.saveKeyedMarker(owner, connectionId, {
        platform: c.platform,
        ...(reconnect ? { replacement: true } : {}),
      });
      keyFields = { connection_id: connectionId, connection_key: key };
    }

    const result = (await this.call(
      'POST',
      '/connect/redeem',
      { code, code_verifier: c.codeVerifier, ...keyFields },
      signer,
    )) as { connection_id?: unknown; platform?: unknown } | null;

    if (result?.platform !== c.platform)
      throw new Error('The proxy connected a different platform than asked.');

    if (
      typeof result.connection_id !== 'string' ||
      !result.connection_id ||
      result.connection_id.length > 512
    )
      throw new Error('The proxy returned an invalid connection id.');

    let connectionId = result.connection_id;

    if (keyed) {
      if (result.connection_id !== keyed.connectionId)
        throw new Error(
          'The proxy returned a different connection than requested.',
        );

      if (keyed.reconnect) {
        try {
          await this.completePrincipalReconnect(
            keyed.owner,
            c.platform,
            connectionId,
            keyed.reconnect,
          );
        } catch (error) {
          // The fresh replacement is unused and wasn't exposed as an app
          // account. Remove it if re-binding the original slot failed.
          await this.call(
            'DELETE',
            '/connections/' + encodeURIComponent(connectionId),
            undefined,
            signer,
          ).catch(() => undefined);
          this.storage.removeItem(
            this.keyedConnectionMarker(keyed.owner, connectionId),
          );
          throw error;
        }

        connectionId = keyed.reconnect.slotId;
      }
    } else {
      await this.delegate(result.connection_id, c.appAgent, c.label);
    }

    if (keyed && !keyed.reconnect)
      this.storage.setItem(
        this.keyedSelectionMarker(c, c.platform, keyed.owner),
        JSON.stringify({
          connectionId,
          expires: this.now() + 600_000,
        }),
      );

    return {
      returnTo: c.returnTo,
      connected: true,
      connectionId,
    };
  }

  /** This user's connections at the proxy, with their delegations. */
  async list(platform?: string): Promise<ProxyConnection[]> {
    const result = (await this.call('GET', '/connections')) as
      | { connections?: unknown }
      | unknown[]
      | null;
    const rows = Array.isArray(result)
      ? result
      : Array.isArray(result?.connections)
        ? result.connections
        : [];

    return (rows as ProxyConnection[])
      .filter(
        row =>
          typeof row?.connection_id === 'string' &&
          typeof row.platform === 'string' &&
          (platform === undefined || row.platform === platform),
      )
      .map(row => ({
        ...row,
        delegations: Array.isArray(row.delegations) ? row.delegations : [],
      }));
  }

  private keyedSelectionMarker(
    scope: Pick<ConnectScope, 'drive' | 'app'>,
    platform: string,
    owner: string,
  ) {
    return (
      KEYED_SELECTION +
      JSON.stringify([
        this.origin,
        owner,
        canonicalizeScheme(scope.drive),
        canonicalizeScheme(scope.app),
        platform,
      ])
    );
  }

  /** Native-only explicit OAuth choice; routine discovery never selects an older slot. */
  async preferredKeyedConnection(
    scope: Pick<ConnectScope, 'drive' | 'app'>,
    platform: string,
  ): Promise<string | undefined> {
    const owner = await this.user().subject;
    const key = this.keyedSelectionMarker(scope, platform, owner);
    const raw = this.storage.getItem(key);
    if (!raw) return;

    try {
      const selection = JSON.parse(raw) as {
        connectionId?: unknown;
        expires?: unknown;
      };
      if (
        validConnectionId(selection.connectionId) &&
        typeof selection.expires === 'number' &&
        selection.expires > this.now() &&
        selection.expires <= this.now() + 600_000 &&
        this.keyedSlot(owner, platform, selection.connectionId)
      )
        return selection.connectionId;
    } catch {
      // Invalid metadata is not a connection choice.
    }

    this.storage.removeItem(key);
  }

  async consumePreferredKeyedConnection(
    scope: Pick<ConnectScope, 'drive' | 'app'>,
    platform: string,
    connectionId: string,
  ): Promise<void> {
    const owner = await this.user().subject;
    const key = this.keyedSelectionMarker(scope, platform, owner);
    const raw = this.storage.getItem(key);
    if (!raw) return;

    try {
      if (JSON.parse(raw).connectionId === connectionId)
        this.storage.removeItem(key);
    } catch {
      this.storage.removeItem(key);
    }
  }

  private keyedConnectionMarker(owner: string, connectionId: string): string {
    return (
      KEYED_CONNECTION + JSON.stringify([this.origin, owner, connectionId])
    );
  }

  private loadKeyedMarker(
    owner: string,
    connectionId: string,
  ): KeyedConnectionMarker | undefined {
    if (!validConnectionId(connectionId)) return;
    const value = this.storage.getItem(
      this.keyedConnectionMarker(owner, connectionId),
    );
    if (isPlatformId(value)) return { platform: value };
    if (!value) return;

    try {
      const marker = JSON.parse(value) as Partial<KeyedConnectionMarker> | null;

      if (isPlatformId(marker?.platform)) {
        return {
          platform: marker.platform,
          principal: connectionPrincipal(marker.principal),
          operationId:
            typeof marker.operationId === 'string' && marker.operationId
              ? marker.operationId
              : undefined,
          legacyPrincipalId:
            typeof (marker as Record<string, unknown>).githubUserId === 'string'
              ? ((marker as Record<string, unknown>).githubUserId as string)
              : marker.legacyPrincipalId,
          activeId: validConnectionId(marker.activeId)
            ? marker.activeId
            : undefined,
          replacement: marker.replacement === true ? true : undefined,
        };
      }
    } catch {
      // Ignore malformed browser metadata.
    }
  }

  private saveKeyedMarker(
    owner: string,
    connectionId: string,
    marker: KeyedConnectionMarker,
  ): void {
    this.storage.setItem(
      this.keyedConnectionMarker(owner, connectionId),
      JSON.stringify(marker),
    );
  }

  private keyedSlot(
    owner: string,
    platform: string,
    slotId: string,
  ): KeyedConnectionMarker | undefined {
    const marker = this.loadKeyedMarker(owner, slotId);
    if (marker?.platform === platform && !marker.replacement) return marker;
  }

  /** Native compatibility lookup only; never reads a provider or derives a key. */
  async keyedPrincipalProvenance(
    platform: string,
    slotId: string,
  ): Promise<KeyedPrincipalProvenance | undefined> {
    const owner = await this.user().subject;
    const marker = this.keyedSlot(owner, platform, slotId);
    if (!marker) return;
    const raw = marker.legacyPrincipalId;
    const numeric =
      typeof raw === 'string' &&
      /^[1-9][0-9]*$/.test(raw) &&
      Number.isSafeInteger(Number(raw))
        ? Number(raw)
        : undefined;
    if (
      marker.principal &&
      numeric !== undefined &&
      marker.principal.subject !== numeric
    )
      throw new Error('The saved connection identity proofs conflict');
    if (!marker.principal && numeric === undefined) return;

    return {
      ...(marker.principal ? { principal: { ...marker.principal } } : {}),
      ...(numeric === undefined ? {} : { legacyNumericSubject: numeric }),
    };
  }

  async canReconnectKeyed(platform: string, slotId: string): Promise<boolean> {
    const owner = await this.user().subject;
    const marker = this.keyedSlot(owner, platform, slotId);

    return Boolean(marker?.principal && marker.operationId);
  }

  /** Read-only eligibility: the native host supplies a validated saved alias and trusted catalog. */
  async canReconnectLegacyKeyed(
    platform: string,
    slotId: string,
    principal: ConnectionPrincipal,
    descriptions: AuthenticatedPrincipalDescription[],
  ): Promise<boolean> {
    const owner = await this.user().subject;

    return !!legacyPrincipalOperation(
      this.keyedSlot(owner, platform, slotId),
      principal,
      descriptions,
    );
  }

  /** Explicit Reconnect only. Cached proof prepares the fresh identity check at OAuth return. */
  async prepareLegacyKeyedReconnect(
    platform: string,
    slotId: string,
    principal: ConnectionPrincipal,
    descriptions: AuthenticatedPrincipalDescription[],
    assertCurrent: () => void,
  ): Promise<void> {
    const owner = await this.user().subject;
    assertCurrent();
    const marker = this.keyedSlot(owner, platform, slotId);
    const operationId = legacyPrincipalOperation(
      marker,
      principal,
      descriptions,
    );
    if (!marker || !operationId)
      throw new Error(
        'This legacy connection has no unambiguous saved identity proof.',
      );
    this.saveKeyedMarker(owner, slotId, {
      ...marker,
      principal: { ...principal },
      operationId,
      legacyPrincipalId: undefined,
    });
  }

  /** Host-only: called after a fresh catalog-declared identity read is verified. */
  async rememberKeyedPrincipal(
    platform: string,
    slotId: string,
    value: ConnectionPrincipal,
    operationId: string,
  ): Promise<void> {
    const owner = await this.user().subject;
    const principal = connectionPrincipal(value);
    const marker = this.keyedSlot(owner, platform, slotId);
    if (!principal || !marker || !operationId)
      throw new Error('Cannot remember the authenticated account identity.');
    if (
      (marker.principal && !samePrincipal(marker.principal, principal)) ||
      (marker.legacyPrincipalId !== undefined &&
        (typeof principal.subject !== 'number' ||
          String(principal.subject) !== marker.legacyPrincipalId))
    )
      throw new Error(
        'This connection belongs to a different authenticated principal.',
      );
    this.saveKeyedMarker(owner, slotId, {
      ...marker,
      principal,
      operationId,
      legacyPrincipalId: undefined,
    });
  }

  /** Resolve a saved logical slot to its current, host-only transport ID. */
  async activeKeyedConnection(
    platform: string,
    slotId: string,
  ): Promise<string> {
    const owner = await this.user().subject;
    const marker = this.loadKeyedMarker(owner, slotId);
    if (marker?.platform !== platform || marker.replacement)
      throw new Error('Reconnect this account to use it here.');

    return marker.activeId ?? slotId;
  }

  private async completePrincipalReconnect(
    owner: string,
    platform: string,
    connectionId: string,
    reconnect: PrincipalReconnect,
  ): Promise<void> {
    if (
      !connectionPrincipal(reconnect.principal) ||
      !validConnectionId(reconnect.slotId) ||
      !validConnectionId(reconnect.previousActiveId) ||
      typeof reconnect.operationId !== 'string' ||
      !reconnect.operationId
    )
      throw new Error('Invalid saved reconnect identity');
    const { resolveAuthenticatedPrincipal, validatePrincipalRead } =
      await import('syncables/browser');
    const document = await this.catalog(
      this.origin,
      platform,
      AbortSignal.timeout(TIMEOUT),
    );
    const resolved = await resolveAuthenticatedPrincipal(document, {
      operationId: reconnect.operationId,
      namespace: reconnect.principal.namespace,
      clientContext: reconnect.principal.clientContext,
      transport: async request => {
        if (
          !validatePrincipalRead(document, request, {
            operationId: reconnect.operationId,
            namespace: reconnect.principal.namespace,
          })
        )
          throw new Error('Invalid authenticated principal operation');
        const target = new URL(
          '/proxy/' +
            encodeURIComponent(connectionId) +
            '/' +
            platform +
            request.url.pathname,
          this.origin,
        );
        target.search = request.url.search;
        const response = await this.readKeyed(target);

        return { ...response, body: JSON.stringify(response.body) };
      },
    });
    const principal = connectionPrincipal({
      ...resolved,
      kind: 'authenticated',
    });
    if (!principal || !samePrincipal(principal, reconnect.principal))
      throw new Error(
        'Reconnect with the same authenticated account to keep your existing tables.',
      );
    const slot = this.keyedSlot(owner, platform, reconnect.slotId);
    if (
      !slot?.principal ||
      !samePrincipal(slot.principal, reconnect.principal) ||
      slot.operationId !== reconnect.operationId ||
      (slot.activeId ?? reconnect.slotId) !== reconnect.previousActiveId ||
      (await this.user().subject) !== owner
    )
      throw new Error('The connection changed during reconnect. Try again.');
    this.saveKeyedMarker(owner, reconnect.slotId, {
      ...slot,
      activeId: connectionId,
    });
  }

  /** Connections this browser recognizes as created by the built-in host. */
  async listKeyed(platform: string): Promise<ProxyConnection[]> {
    const owner = await this.user().subject;
    const remote = new Map(
      (await this.list(platform)).map(row => [row.connection_id, row]),
    );
    const prefix =
      KEYED_CONNECTION +
      JSON.stringify([this.origin, owner]).slice(0, -1) +
      ',"';
    const slots: ProxyConnection[] = [];

    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(prefix) || !key.endsWith('"]')) continue;
      const slotId = key.slice(prefix.length, -2);
      const marker = this.loadKeyedMarker(owner, slotId);
      if (marker?.platform !== platform || marker.replacement) continue;
      const row = remote.get(marker.activeId ?? slotId);
      if (row) slots.push({ ...row, connection_id: slotId });
      else if (marker.principal || marker.legacyPrincipalId)
        slots.push({ connection_id: slotId, platform, owner, delegations: [] });
    }

    return slots;
  }

  /**
   * Signed, read-only relay for a first-party view. The caller checks the
   * exact source and endpoint before calling; the host signs and retains all
   * credentials. Only the bounded response is returned to the view.
   */
  async readKeyed(
    url: URL,
    signal?: AbortSignal,
    request: { method: 'GET' | 'POST'; body?: string } = { method: 'GET' },
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: unknown;
  }> {
    signal?.throwIfAborted();
    if (
      !['GET', 'POST'].includes(request.method) ||
      (request.method === 'GET' && request.body !== undefined)
    )
      throw new Error('Invalid catalog read request');
    const target = new URL(url.href);
    if (
      target.origin !== this.origin ||
      target.username ||
      target.password ||
      target.hash
    )
      throw new Error('Request is outside the configured proxy origin.');

    const source =
      /^\/proxy\/([A-Za-z0-9_-]{43})\/([a-z0-9-]{1,80})\/[^/]/.exec(
        target.pathname,
      );
    if (!source) throw new Error('Expected a proxy connection and platform.');

    const [, connectionId, platform] = source;
    const { agent, subject } = this.user();
    const owner = await subject;
    if (this.loadKeyedMarker(owner, connectionId)?.platform !== platform)
      throw new Error('Reconnect this account to use it here.');

    const key = await deriveConnectionKey(
      agent,
      this.origin,
      platform,
      connectionId,
    );
    const time = this.now();
    const message = requestSignatureMessageV2(
      request.method,
      target.href,
      time,
      sha256Hex(request.body),
    );
    const publicKey = await agent.getPublicKey();
    const signature = await agent.sign(message + '\n' + sha256Hex(key));
    signal?.throwIfAborted();
    if ((await this.user().subject) !== owner)
      throw new Error(
        'The Atomic account changed before the integration request',
      );
    const response = await this.http(target.href, {
      method: request.method,
      ...(request.body === undefined ? {} : { body: request.body }),
      headers: {
        ...(request.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
        'x-atomic-public-key': publicKey,
        'x-atomic-signature': signature,
        'x-atomic-timestamp': String(time),
        'x-atomic-agent': owner,
        [SIGNATURE_VERSION_HEADER]: '2',
        [CONNECTION_KEY_HEADER]: key,
      },
      credentials: 'omit',
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)])
        : AbortSignal.timeout(TIMEOUT),
    });
    const headers: Record<string, string> = {};

    for (const name of PROXY_READ_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }

    return {
      status: response.status,
      headers,
      body: parseBody(await readLimitedResponseText(response)),
    };
  }

  /** Connections for `platform` delegated to `appAgent`. References only. */
  async delegated(
    appAgent: string,
    platform: string,
  ): Promise<ConnectionReference[]> {
    const app = canonicalAgent(appAgent);

    return (await this.list(platform))
      .filter(row => row.delegations.some(d => sameAgent(d.agent, app)))
      .map(row => ({ connectionId: row.connection_id, platform }));
  }

  /** "App agent X may use connection C." Signed by the owner. */
  async delegate(connectionId: string, agent: string, label?: string) {
    await this.call(
      'POST',
      `/connections/${encodeURIComponent(connectionId)}/agents`,
      { agent: canonicalAgent(agent), ...(label ? { label } : {}) },
    );
  }

  /** Takes a delegation away; the proxy refuses the app from then on. */
  async undelegate(connectionId: string, agent: string) {
    await this.call(
      'DELETE',
      `/connections/${encodeURIComponent(connectionId)}/agents/${encodeURIComponent(canonicalAgent(agent))}`,
    );
  }

  /** Deletes a connection at the proxy, and with it every delegation. */
  async revoke(connectionId: string) {
    await this.call(
      'DELETE',
      `/connections/${encodeURIComponent(connectionId)}`,
    );
  }

  /**
   * Mints a capability for a frame's key, after checking that the connection
   * is this user's, for `platform`, and delegated to `appAgent`. The proxy
   * checks all of that again on every request; checking here as well means a
   * frame cannot get a signed statement about a connection it has no business
   * with.
   */
  async mintCapability(request: {
    appAgent: string;
    platform: string;
    connectionId: string;
    publicKey: string;
  }): Promise<MintedCapability> {
    const { platform, connectionId } = request;
    if (!isPlatformId(platform)) throw new Error('Invalid platform');
    if (typeof connectionId !== 'string' || !connectionId)
      throw new Error('connectionId is required');
    if (typeof request.publicKey !== 'string')
      throw new Error('publicKey is required');
    const cnf = canonicalAgent(agentSubject(request.publicKey));
    const app = canonicalAgent(request.appAgent);
    const { agent } = this.user();

    const row = (await this.list(platform)).find(
      r => r.connection_id === connectionId,
    );

    if (!row || !row.delegations.some(d => sameAgent(d.agent, app)))
      throw new Error(
        `No ${platform} connection ${connectionId} is delegated to this app. Connect again.`,
      );

    const exp = Math.floor(this.now() / 1000) + CAPABILITY_TTL_SECONDS;
    const { json, message } = capabilityClaims({
      connection_id: connectionId,
      platform,
      aud: this.origin,
      app,
      cnf,
      exp,
    });
    const sig = await agent.signBytes(message);

    return {
      capability: `${base64url(new TextEncoder().encode(json))}.${sig}`,
      aud: this.origin,
      exp,
      connectionId,
      platform,
    };
  }

  /** What `hostStore` answers one app's frame with. */
  host(appAgent: () => Promise<string>): ProxyHost {
    return {
      origin: this.origin,
      capability: async request =>
        this.mintCapability({ ...request, appAgent: await appAgent() }),
      connections: async platform => this.delegated(await appAgent(), platform),
    };
  }
}

function sameAgent(a: unknown, canonical: string): boolean {
  if (typeof a !== 'string') return false;

  try {
    return canonicalAgent(a) === canonical;
  } catch {
    return false;
  }
}
