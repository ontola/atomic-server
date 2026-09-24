// @wc-ignore-file
/**
 * Integration-proxy connections held by this page on behalf of apps.
 *
 * An app's view runs in a null-origin frame with no storage, and a credential
 * must never be written into a resource (it would sync, and drives are
 * shared). So the page holds the connection — LocalThought's rotating
 * connection code, in this origin's `localStorage` — and relays calls for the
 * frame, which only ever names a connection by `{ platform, connectionId }`.
 *
 * Each connection is bound to the proxy origin, drive, agent and **app** it
 * was made for. Another app on the same drive cannot relay through it.
 *
 * Interim by design: atomic-server#1624 / atomic-plugins#40 replace the
 * rotating code with a short-lived capability the parent mints, at which
 * point this file shrinks to minting. The transport half is a port of
 * atomic-plugins' `integrations/localthought/browser.ts`, which the
 * data-browser no longer imports.
 */

const KEY = 'atomic-proxy-connection-v1:';
const MAX_BODY = 10 * 1024 * 1024;
const TIMEOUT = 30_000;
/** Response headers a frame may see. Never `x-connection-code`. */
const EXPOSED_HEADERS = ['link', 'retry-after', 'etag', 'content-type'];
const METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;

export type ProxyMethod = (typeof METHODS)[number];

/** Who a connection belongs to. All four must match to use it. */
export interface ConnectionScope {
  drive: string;
  actor: string;
  app: string;
}

interface StoredConnection extends ConnectionScope {
  origin: string;
  platform: string;
  /** Where to go once the proxy sends the person back. */
  returnTo: string;
  /** Only for the PKCE handoff window. */
  expires: number;
  codeVerifier?: string;
  code?: string;
  ready: boolean;
}

export interface ProxyRelayRequest {
  platform: string;
  connectionId: string;
  path: string;
  method?: string;
  query?: Record<string, string>;
  /** JSON text. */
  body?: string;
  ifMatch?: string;
}

export interface ProxyRelayResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the body is JSON, the raw text otherwise. */
  body: unknown;
}

export interface ConnectionReference {
  connectionId: string;
  platform: string;
}

/** What `hostStore` needs for one app; see `ProxyConnections.relay`. */
export interface ProxyRelay {
  request(request: ProxyRelayRequest): Promise<ProxyRelayResponse>;
  connections(platform: string): ConnectionReference[];
}

type Locks = Pick<LockManager, 'request'>;

export const isPlatformId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value);

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

async function limitedText(response: Response): Promise<string> {
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
      if (size > MAX_BODY) throw new Error('Proxy response exceeds 10 MB');
      text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseBody(text: string): unknown {
  if (text === '') return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `path` plus `query`, checked to stay under `/proxy/<platform>/`. */
export function proxyUrl(
  origin: string,
  platform: string,
  path: string,
  query?: Record<string, string>,
): URL {
  if (!isPlatformId(platform)) throw new Error('Invalid platform');

  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\\#]/.test(path) ||
    path.length > 4096
  )
    throw new Error('Invalid proxy path');
  const url = new URL(`/proxy/${platform}${path}`, origin);

  if (url.origin !== origin || !url.pathname.startsWith(`/proxy/${platform}/`))
    throw new Error('Invalid proxy path');

  for (const [key, value] of Object.entries(query ?? {})) {
    if (typeof value !== 'string') throw new Error('Invalid proxy query');
    url.searchParams.set(key, value);
  }

  return url;
}

export class ProxyConnections {
  constructor(
    private storage: Storage,
    readonly origin: string,
    private http: typeof fetch = (...args) => fetch(...args),
    private locks: Locks | undefined = globalThis.navigator?.locks,
    private now: () => number = Date.now,
  ) {}

  private read(id: string): StoredConnection | undefined {
    const raw = this.storage.getItem(KEY + id);
    if (!raw) return undefined;

    try {
      return JSON.parse(raw) as StoredConnection;
    } catch {
      return undefined;
    }
  }

  private write(id: string, connection: StoredConnection) {
    this.storage.setItem(KEY + id, JSON.stringify(connection));
  }

  private owned(
    id: string,
    scope: ConnectionScope,
    platform: string,
  ): StoredConnection {
    const c = this.read(id);

    if (
      !c ||
      c.origin !== this.origin ||
      c.drive !== scope.drive ||
      c.actor !== scope.actor ||
      c.app !== scope.app ||
      c.platform !== platform
    )
      throw new Error(`No ${platform} connection for this app. Connect again.`);

    return c;
  }

  /**
   * Starts the PKCE handoff and returns the proxy URL to send the person to.
   * The proxy only returns to `/app/integrations`, so `returnTo` is where the
   * return handler goes afterwards.
   */
  async start(
    scope: ConnectionScope,
    platform: string,
    returnTo: string,
    pageOrigin = location.origin,
  ): Promise<string> {
    if (!isPlatformId(platform)) throw new Error('Invalid platform');
    const back = new URL(returnTo, pageOrigin);
    if (back.origin !== pageOrigin) throw new Error('Invalid return URL');

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
      user_id: scope.actor,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      credentials: 'connection',
    }))
      url.searchParams.set(k, v);

    this.write(state, {
      ...scope,
      origin: this.origin,
      platform,
      returnTo: back.href,
      expires: this.now() + 600_000,
      codeVerifier,
      ready: false,
    });

    return url.href;
  }

  /** Whether `params` is a return from a handoff this browser started. */
  isReturn(params: URLSearchParams): boolean {
    const state = params.get('integration_state');
    if (!state) return false;
    const c = this.read(state);

    return !!c && !c.ready && !!c.codeVerifier;
  }

  /**
   * Redeems the proxy's handoff code. Returns where to go next. A refusal at
   * the proxy (`error=access_denied`) drops the pending handoff and still
   * returns there, so the app can offer to connect again.
   *
   * The agent is not re-checked here: it is recorded at `start`, and every
   * relayed request checks it. The signed-in agent may not be loaded yet this
   * early in a page load.
   */
  async finish(
    params: URLSearchParams,
  ): Promise<{ returnTo: string; connected: boolean }> {
    const state = params.get('integration_state') ?? '';
    const c = this.read(state);

    if (!c || c.ready || !c.codeVerifier || c.origin !== this.origin)
      throw new Error(
        'This connection return is not one this browser started.',
      );

    if (params.get('platform') !== c.platform || c.expires < this.now()) {
      this.storage.removeItem(KEY + state);
      throw new Error('The connection return expired. Connect again.');
    }

    const code = params.get('connection_code');

    if (!code || code.length > 4096) {
      this.storage.removeItem(KEY + state);

      return { returnTo: c.returnTo, connected: false };
    }

    const verifier = c.codeVerifier;
    // Consumed before dispatch: a lost response may have spent the handoff.
    this.write(state, { ...c, codeVerifier: undefined });
    const response = await this.http(`${this.origin}/connect/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier }),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!response.ok)
      throw new Error(`The integration proxy returned HTTP ${response.status}`);
    const result = parseBody(await limitedText(response)) as {
      connection_code?: unknown;
      platform?: unknown;
    };
    if (result?.platform !== c.platform)
      throw new Error('The proxy connected a different platform than asked.');
    if (
      typeof result.connection_code !== 'string' ||
      !result.connection_code ||
      result.connection_code.length > 4096
    )
      throw new Error('The proxy returned an invalid connection code.');
    this.write(state, {
      ...c,
      codeVerifier: undefined,
      ready: true,
      code: result.connection_code,
    });

    return { returnTo: c.returnTo, connected: true };
  }

  /** Ready connections for this app and platform. References only. */
  list(scope: ConnectionScope, platform: string): ConnectionReference[] {
    const out: ConnectionReference[] = [];

    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(KEY)) continue;
      const id = key.slice(KEY.length);
      const c = this.read(id);

      if (
        c?.ready &&
        c.origin === this.origin &&
        c.drive === scope.drive &&
        c.actor === scope.actor &&
        c.app === scope.app &&
        c.platform === platform
      )
        out.push({ connectionId: id, platform });
    }

    return out;
  }

  /** One relayed call, serialised per connection because codes rotate. */
  async request(
    scope: ConnectionScope,
    request: ProxyRelayRequest,
  ): Promise<ProxyRelayResponse> {
    const method = (request.method ?? 'GET').toUpperCase() as ProxyMethod;
    if (!METHODS.includes(method)) throw new Error('Invalid proxy method');
    if (request.body !== undefined && typeof request.body !== 'string')
      throw new Error('A proxy request body is JSON text');
    if (request.body !== undefined && method === 'GET')
      throw new Error('A GET proxy request has no body');
    if (request.ifMatch !== undefined && typeof request.ifMatch !== 'string')
      throw new Error('Invalid If-Match');
    const url = proxyUrl(
      this.origin,
      request.platform,
      request.path,
      request.query,
    );
    const id = request.connectionId;
    if (typeof id !== 'string' || !id)
      throw new Error('connectionId is required');
    // Checked before taking the lock, so a foreign id fails fast.
    this.owned(id, scope, request.platform);
    if (!this.locks)
      throw new Error('This browser needs Web Locks for integrations');

    return this.locks.request(KEY + id, async () => {
      const c = this.owned(id, scope, request.platform);
      if (!c.ready || !c.code)
        throw new Error('Reconnect before retrying an uncertain request');
      const code = c.code;
      this.write(id, { ...c, code: undefined });
      const response = await this.http(url.href, {
        method,
        body: request.body,
        headers: {
          Authorization: `Bearer ${code}`,
          ...(request.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...(request.ifMatch ? { 'If-Match': request.ifMatch } : {}),
        },
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT),
      });
      const next = response.headers.get('x-connection-code');
      if (!next)
        throw new Error(
          'The proxy did not return a rotated code; reconnect and check its CORS headers',
        );
      this.write(id, { ...c, code: next });
      const headers: Record<string, string> = {};

      for (const name of EXPOSED_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }

      return {
        status: response.status,
        headers,
        body: parseBody(await limitedText(response)),
      };
    });
  }

  /** The relay `hostStore` answers one app's frame with. */
  relay(scope: ConnectionScope): ProxyRelay {
    return {
      request: request => this.request(scope, request),
      connections: platform => this.list(scope, platform),
    };
  }
}
