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
 * Replaces #1657's relay of LocalThought rotating connection codes (flag day,
 * decision 6 of #54): nothing credential-like is kept in this page's storage
 * any more, only a PKCE verifier for the ten minutes of a handoff.
 *
 * The proxy keeps each connection's provider credential sealed under a key it
 * does not store (ontola/atomic-plugins#730). This page derives that key from
 * the user's vault proof and the connection id, which it chooses itself, and
 * sends it once at redeem. A frame gets a **key grant** with each capability:
 * the key encrypted to the proxy, naming the app agent, which the frame passes
 * on in `x-connection-key` without being able to read it. See
 * `connectionKeys.ts`.
 */

import {
  AGENT_VAULT_PROOF_MESSAGE,
  SIGNATURE_VERSION_HEADER,
  requestSignatureMessageV2,
  sha256Hex,
  agentSubject,
  decodeB64,
  signRequest,
  type Agent,
} from '@tomic/react';
import {
  deriveConnectionKey,
  newConnectionId,
  rawConnectionKey,
  sealGrant,
} from './connectionKeys';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { agentVaultProof } from './managed/vault';

const PENDING = 'atomic-proxy-connect-v2:';
const KEYED_CONNECTION = 'atomic-proxy-keyed-v1:';
const CONNECTION_KEY_HEADER = 'x-connection-key';
const PROXY_READ_HEADERS = ['link', 'retry-after', 'etag', 'content-type'];
const GITHUB = 'github-issues';
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
  /**
   * `app` is an Installation: once delegated, the return records
   * `integrationConnections[platform]` on it (#1700, answer 3).
   */
  recordOnInstallation?: boolean;
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
    reconnect?: GithubReconnect;
  };
}

interface GithubReconnect {
  slotId: string;
  githubUserId: string;
  previousActiveId: string;
}

/** Non-secret connection provenance, local to this signed-in browser. */
interface KeyedConnectionMarker {
  platform: string;
  githubUserId?: string;
  activeId?: string;
  replacement?: true;
}

function validConnectionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function githubPrincipal(value: unknown): string | undefined {
  const id = typeof value === 'number' ? String(value) : value;
  if (
    typeof id === 'string' &&
    /^[1-9][0-9]*$/.test(id) &&
    Number.isSafeInteger(Number(id))
  )
    return id;
}

export interface ConnectionReference {
  connectionId: string;
  platform: string;
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

/** One row of `runtimes` in `GET /connections`. */
export interface ProxyRuntime {
  agent: string;
  app: string;
  label?: string | null;
  created_at?: string | number;
  last_used_at?: string | number | null;
}

/** The proxy refuses longer labels. */
const MAX_LABEL = 200;

/** What the frame gets: the capability, and where to use it. */
export interface MintedCapability {
  capability: string;
  /**
   * The `x-connection-key` value the frame sends with the capability: a key
   * grant (`s1.…`) naming the app agent, valid as long as the capability.
   */
  connectionKey: string;
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
  /**
   * Takes this app's delegation off its `platform` connections, and off
   * `also` (connection ids the host knows about, such as an Installation's
   * recorded one). Never deletes a connection. Returns the connection ids.
   */
  disconnect(platform: string, also?: readonly string[]): Promise<string[]>;
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

/** `pets` -> `Pets`, `github-issues` -> `Github Issues`. */
export function platformName(id: string): string {
  return id
    .split('-')
    .map(word => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ');
}

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

async function deriveKeyedConnectionKey(
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
  /** The proxy's grant public key, fetched once per page. */
  private grantKey?: Promise<string>;

  constructor(
    private storage: Storage,
    /** The proxy origin. */
    readonly origin: string,
    /** The signed-in user. Every call the page makes is signed with it. */
    private agent: () => Agent | undefined,
    private http: typeof fetch = (...args) => fetch(...args),
    private now: () => number = Date.now,
  ) {}

  private user(): { agent: Agent; subject: Promise<string> } {
    const agent = this.agent();
    if (!agent) throw new Error('Sign in to use integration connections.');

    return {
      agent,
      subject: agent.getPublicKey().then(key => agentSubject(key)),
    };
  }

  /**
   * The key of `connectionId` at this proxy, derived from the user's vault
   * proof. Every device holding the agent derives the same one.
   */
  private async connectionKey(connectionId: string): Promise<Uint8Array> {
    const { agent } = this.user();
    const proof = await agentVaultProof(agent, AGENT_VAULT_PROOF_MESSAGE);

    return deriveConnectionKey(proof, this.origin, connectionId);
  }

  /** `GET /connection-key-grants/key`, unsigned: the key grants go to. */
  private proxyGrantKey(): Promise<string> {
    this.grantKey ??= (async () => {
      const response = await this.http(
        new URL('/connection-key-grants/key', this.origin).href,
        {
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT),
        },
      );
      const body = parseBody(await readLimitedResponseText(response)) as {
        public_key?: unknown;
        info?: unknown;
      } | null;

      if (
        !response.ok ||
        typeof body?.public_key !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(body.public_key) ||
        body.info !== 'integration-proxy-connection-key-grant-v1'
      )
        throw new Error(
          'The integration proxy publishes no connection-key grant key. It may run an older version.',
        );

      return body.public_key;
    })();
    this.grantKey.catch(() => {
      this.grantKey = undefined;
    });

    return this.grantKey;
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

  /** Reconnect a stable GitHub slot to a fresh credential for the same user. */
  async startKeyedReconnect(
    scope: ConnectScope,
    slotConnectionId: string,
    returnTo: string,
    label: string,
    pageOrigin = location.origin,
  ): Promise<string> {
    return this.startKeyedHandoff(
      scope,
      GITHUB,
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
    let reconnect: GithubReconnect | undefined;

    if (slotId !== undefined) {
      const slot = this.githubSlot(owner, slotId);
      if (!slot?.githubUserId)
        throw new Error(
          'A verified GitHub account is required to reconnect this source.',
        );
      reconnect = {
        slotId,
        githubUserId: slot.githubUserId,
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
  async finish(params: URLSearchParams): Promise<{
    returnTo: string;
    connected: boolean;
    connectionId?: string;
    platform: string;
    app: string;
    recordOnInstallation: boolean;
  }> {
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

    const scope = {
      returnTo: c.returnTo,
      platform: c.platform,
      app: c.app,
      recordOnInstallation: c.recordOnInstallation === true,
    };

    if (!code || code.length > 4096) {
      return { ...scope, connected: false };
    }

    const signer = this.user();
    const keyed = c.keyed;
    const requestedId = keyed?.connectionId ?? newConnectionId();
    let keyFields = {
      connection_id: requestedId,
      connection_key: rawConnectionKey(await this.connectionKey(requestedId)),
    };

    if (keyed) {
      const { owner, connectionId, reconnect } = keyed;
      if (owner !== (await signer.subject))
        throw new Error(
          'Sign in with the Atomic account that started this connection.',
        );
      const key = await deriveKeyedConnectionKey(
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

    if (result.connection_id !== requestedId)
      throw new Error('The proxy returned a different connection id.');

    let connectionId = result.connection_id;

    if (keyed) {
      if (result.connection_id !== keyed.connectionId)
        throw new Error(
          'The proxy returned a different connection than requested.',
        );

      if (keyed.reconnect) {
        try {
          await this.completeGithubReconnect(
            keyed.owner,
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

    return {
      ...scope,
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
          githubUserId: githubPrincipal(marker.githubUserId),
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

  private githubSlot(
    owner: string,
    slotId: string,
  ): KeyedConnectionMarker | undefined {
    const marker = this.loadKeyedMarker(owner, slotId);
    if (marker?.platform === GITHUB && !marker.replacement) return marker;
  }

  async canReconnectGithub(slotId: string): Promise<boolean> {
    const owner = await this.user().subject;

    return Boolean(this.githubSlot(owner, slotId)?.githubUserId);
  }

  /** The host calls this after validating a signed /user response. */
  async rememberKeyedGithubPrincipal(
    slotId: string,
    id: string | number,
  ): Promise<void> {
    const owner = await this.user().subject;
    const githubUserId = githubPrincipal(id);
    const marker = this.githubSlot(owner, slotId);
    if (!githubUserId || !marker)
      throw new Error('Cannot remember the GitHub account identity.');
    if (marker.githubUserId && marker.githubUserId !== githubUserId)
      throw new Error('This connection belongs to a different GitHub account.');
    if (!marker.githubUserId)
      this.saveKeyedMarker(owner, slotId, { ...marker, githubUserId });
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

  private async completeGithubReconnect(
    owner: string,
    connectionId: string,
    reconnect: GithubReconnect,
  ): Promise<void> {
    const response = await this.readKeyed(
      new URL(`/proxy/${connectionId}/${GITHUB}/user`, this.origin),
    );
    if (response.status < 200 || response.status >= 300)
      throw new Error(
        'Could not verify the new GitHub connection. Connect again.',
      );
    const id = (response.body as { id?: unknown } | null)?.id;
    if (
      typeof id !== 'number' ||
      githubPrincipal(id) !== reconnect.githubUserId
    )
      throw new Error(
        'Reconnect with the same GitHub account to keep your existing tables.',
      );

    const slot = this.githubSlot(owner, reconnect.slotId);
    if (
      slot?.githubUserId !== reconnect.githubUserId ||
      (slot.activeId ?? reconnect.slotId) !== reconnect.previousActiveId
    )
      throw new Error(
        'The GitHub connection changed during reconnect. Try again.',
      );
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
      else if (platform === GITHUB && marker.githubUserId)
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
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: unknown;
  }> {
    signal?.throwIfAborted();
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

    const key = await deriveKeyedConnectionKey(
      agent,
      this.origin,
      platform,
      connectionId,
    );
    const time = this.now();
    const message = requestSignatureMessageV2(
      'GET',
      target.href,
      time,
      sha256Hex(undefined),
    );
    const response = await this.http(target.href, {
      method: 'GET',
      headers: {
        'x-atomic-public-key': await agent.getPublicKey(),
        'x-atomic-signature': await agent.sign(message + '\n' + sha256Hex(key)),
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

  /**
   * This user's runtimes at the proxy (`runtimes` of `GET /connections`):
   * node agents that may act for an installation's app id.
   */
  async runtimes(): Promise<ProxyRuntime[]> {
    const result = (await this.call('GET', '/connections')) as {
      runtimes?: unknown;
    } | null;
    const rows = Array.isArray(result?.runtimes) ? result.runtimes : [];

    return (rows as ProxyRuntime[]).filter(
      row => typeof row?.agent === 'string' && typeof row.app === 'string',
    );
  }

  /**
   * Registers a node's agent as a runtime of installation `app`
   * (`POST /runtimes {app, agent, label?}`), signed by the owner. The proxy
   * upserts on (owner, agent), so registering again is harmless.
   */
  async registerRuntime(app: string, agent: string, label?: string) {
    await this.call('POST', '/runtimes', {
      app: canonicalAgent(app),
      agent: canonicalAgent(agent),
      ...(label ? { label: [...label].slice(0, MAX_LABEL).join('') } : {}),
    });
  }

  /** Removes a runtime; the proxy refuses that agent from then on. */
  async unregisterRuntime(agent: string) {
    await this.call(
      'DELETE',
      `/runtimes/${encodeURIComponent(canonicalAgent(agent))}`,
    );
  }

  /**
   * Takes `appAgent`'s delegation off every `platform` connection delegated
   * to it, and off `also`, one `DELETE /connections/{id}/agents/{agent}`
   * each. Only this app loses access: the connection stays, with any other
   * app's delegation, because deleting it is the person's call on a page, not
   * an app's. A delegation the proxy no longer has (404) counts as gone.
   * Returns the connection ids it was taken off.
   */
  async disconnectApp(
    appAgent: string,
    platform: string,
    also: readonly string[] = [],
  ): Promise<string[]> {
    if (!isPlatformId(platform)) throw new Error('Invalid platform');
    const ids = [
      ...new Set([
        ...(await this.delegated(appAgent, platform)).map(r => r.connectionId),
        ...also,
      ]),
    ];

    for (const id of ids) {
      try {
        await this.undelegate(id, appAgent);
      } catch (e) {
        if (!(e instanceof ProxyError && e.status === 404)) throw e;
      }
    }

    return ids;
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
    // The grant names the app, not the frame key: the capability (signed by
    // `cnf`) is what binds a request to this frame, and it expires with it.
    const connectionKey = await sealGrant({
      proxyPublicKey: await this.proxyGrantKey(),
      connectionId,
      sub: app,
      key: await this.connectionKey(connectionId),
      exp,
    });

    return {
      capability: `${base64url(new TextEncoder().encode(json))}.${sig}`,
      connectionKey,
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
      disconnect: async (platform, also) =>
        this.disconnectApp(await appAgent(), platform, also),
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
