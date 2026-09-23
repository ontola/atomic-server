// @wc-ignore-file
/** Browser-owned credentials. Never store these in Atomic graph resources. */
import type { CatalogDocument } from './reflector-read.js';

export const DEFAULT_PROXY = 'https://localthought.io';
const key = 'localthought-browser-v1:';

export interface Connection {
  drive: string;
  actor: string;
  platform: string;
  origin: string;
  expires: number;
  code?: string;
  codeVerifier?: string;
  ready: boolean;
}
// RFC 6761 gives the whole `.localhost` TLD to loopback, and browsers treat
// those names as secure origins for exactly that reason. The e2e bundle can be
// served from `http://atomic.localhost:<port>` when the browser runs in its
// own container, where `127.0.0.1` is the wrong machine. atomic-server's
// data-browser also uses this for its plugin-catalog URL check.
export const isLoopbackHost = (host: string) =>
  host === 'localhost' ||
  host.endsWith('.localhost') ||
  host === '127.0.0.1' ||
  host === '[::1]';
export function proxyOrigin(value = DEFAULT_PROXY): string {
  const u = new URL(value);
  if (
    u.origin !== value ||
    (u.protocol !== 'https:' &&
      !(u.protocol === 'http:' && isLoopbackHost(u.hostname)))
  )
    throw new Error('Proxy must be an HTTPS origin or localhost');

  return value;
}

const catalogName = (platform: string) => {
  if (!/^[a-z0-9-]{1,80}$/.test(platform)) throw new Error('Invalid platform');

  return platform;
};

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

async function limitedText(response: Response): Promise<string> {
  if (!response.body) throw new Error('Empty proxy response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0,
    text = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 10 * 1024 * 1024)
        throw new Error('Proxy response exceeds 10 MB');
      text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
  } finally {
    await reader.cancel();
  }
}

export class BrowserIntegrations {
  constructor(
    private storage: Storage,
    readonly origin = DEFAULT_PROXY,
    private http: typeof fetch = (...args) => fetch(...args),
  ) {
    proxyOrigin(origin);
  }
  private async get(path: string, signal?: AbortSignal) {
    const response = await this.http(`${this.origin}${path}`, {
      credentials: 'omit',
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`LocalThought returned HTTP ${response.status}`);

    return limitedText(response);
  }
  async catalog(signal?: AbortSignal): Promise<string[]> {
    const names = JSON.parse(await this.get('/catalog', signal));
    if (
      !Array.isArray(names) ||
      names.length > 200 ||
      names.some(s => typeof s !== 'string' || !/^[a-z0-9-]{1,80}$/.test(s))
    )
      throw new Error('Invalid platform catalog');

    return names;
  }
  /**
   * The platform's catalog document: its OpenAPI description with the
   * proxy's overlays already applied. JSON, so the browser needs no YAML
   * parser; a proxy without the `.json` route (before ontola/atomic-plugins#52)
   * still works when its `.yaml` body happens to be JSON, as the mock's is.
   */
  async catalogDocument(
    platform: string,
    signal?: AbortSignal,
  ): Promise<CatalogDocument> {
    const name = catalogName(platform);
    let text: string;

    try {
      text = await this.get(`/catalog/${name}.json`, signal);
    } catch (error) {
      if (!/HTTP 404$/.test(String(error))) throw error;
      text = await this.get(`/catalog/${name}.yaml`, signal);
    }

    let document: unknown;

    try {
      document = JSON.parse(text);
    } catch {
      throw new Error(
        'LocalThought served a YAML catalog document; update the proxy',
      );
    }

    if (typeof document !== 'object' || document === null)
      throw new Error('Invalid catalog document');

    return document as CatalogDocument;
  }
  /** The catalog's default query selection for the platform. */
  async catalogSelection(
    platform: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return JSON.parse(
      await this.get(
        `/catalog/${catalogName(platform)}.selection.json`,
        signal,
      ),
    );
  }
  async start(
    drive: string,
    actor: string,
    platform: string,
    returnUrl: string,
  ) {
    if (!(await this.catalog()).includes(platform))
      throw new Error('Unknown platform');
    const callback = new URL(returnUrl);
    if (
      callback.origin !== location.origin ||
      !['/app/integrations', '/app/devonian-demo'].includes(
        callback.pathname,
      ) ||
      callback.search ||
      callback.hash
    )
      throw new Error('Invalid integration return URL');
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
    callback.searchParams.set('integration_state', state);
    callback.searchParams.set('platform', platform);
    const url = new URL(`${this.origin}/connect`);
    for (const [k, v] of Object.entries({
      platform,
      redirect_uri: callback.href,
      user_id: actor,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      credentials: 'connection',
    }))
      url.searchParams.set(k, v as string);
    // Only the short-lived PKCE handoff survives navigation.
    this.storage.setItem(
      key + state,
      JSON.stringify({
        drive,
        actor,
        platform,
        origin: this.origin,
        expires: Date.now() + 600000,
        codeVerifier,
        ready: false,
      } satisfies Connection),
    );

    return { state, url: url.href };
  }
  private connection(id: string, drive: string, actor: string) {
    const raw = this.storage.getItem(key + id);
    if (!raw) throw new Error('Reconnect your account');
    const c: Connection = JSON.parse(raw);
    if (c.drive !== drive || c.actor !== actor || c.origin !== this.origin)
      throw new Error('Connection belongs to another drive, agent or proxy');

    return c;
  }
  cancel(drive: string, actor: string, state: string) {
    this.connection(state, drive, actor);
    this.storage.removeItem(key + state);
  }
  async finish(drive: string, actor: string, state: string, code: string) {
    const c = this.connection(state, drive, actor);

    if (c.expires < Date.now()) {
      this.storage.removeItem(key + state);
      throw new Error('Reconnect your account');
    }

    if (c.ready || !c.codeVerifier || !code || code.length > 4096)
      throw new Error('Reconnect your account');
    const verifier = c.codeVerifier;
    delete c.codeVerifier;
    // Consume before dispatch: a lost response may have spent the handoff code.
    this.storage.setItem(key + state, JSON.stringify(c));
    const response = await this.http(`${this.origin}/connect/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier }),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`LocalThought returned HTTP ${response.status}`);
    const result = JSON.parse(await limitedText(response)) as {
      connection_code?: unknown;
      platform?: unknown;
    };
    if (result.platform !== c.platform)
      throw new Error('Returned platform did not match the requested platform');
    if (
      typeof result.connection_code !== 'string' ||
      !result.connection_code ||
      result.connection_code.length > 4096
    )
      throw new Error('LocalThought returned an invalid connection code');
    this.storage.setItem(
      key + state,
      JSON.stringify({ ...c, ready: true, code: result.connection_code }),
    );

    return { connection: state, platform: c.platform };
  }
  /** Shared rotating-code transport for browser-owned writes as well as reads. */
  async request(
    drive: string,
    actor: string,
    id: string,
    platform: string,
    path: string,
    init: { method?: string; body?: string; ifMatch?: string } = {},
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }> {
    if (!navigator.locks)
      throw new Error('This browser needs Web Locks for integrations');
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\\#]/.test(path))
      throw new Error('Invalid proxy path');
    const destination = new URL(`/proxy/${platform}${path}`, this.origin);
    if (!destination.pathname.startsWith(`/proxy/${platform}/`))
      throw new Error('Invalid proxy path');

    return navigator.locks.request(key + id, async () => {
      const c = this.connection(id, drive, actor);
      if (c.platform !== platform)
        throw new Error('Connection belongs to another platform');
      const response = await this.send(
        id,
        drive,
        actor,
        path,
        init,
        AbortSignal.timeout(30000),
      );

      // Pagination reads e.g. `Link`; the rotated code stays in here.
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (name !== 'x-connection-code') headers[name] = value;
      });

      return {
        status: response.status,
        headers,
        body: await limitedText(response),
      };
    });
  }
  private async send(
    id: string,
    drive: string,
    actor: string,
    path: string,
    init: { method?: string; body?: string; ifMatch?: string },
    signal: AbortSignal,
  ) {
    const current = this.connection(id, drive, actor);
    if (!current.ready || !current.code)
      throw new Error('Reconnect before retrying an uncertain request');
    const code = current.code;
    delete current.code;
    this.storage.setItem(key + id, JSON.stringify(current));
    const response = await this.http(
      `${this.origin}/proxy/${current.platform}${path}`,
      {
        method: init.method,
        body: init.body,
        headers: {
          Authorization: `Bearer ${code}`,
          'Content-Type': 'application/json',
          ...(init.ifMatch ? { 'If-Match': init.ifMatch } : {}),
        },
        credentials: 'omit',
        redirect: 'error',
        signal,
      },
    );
    const next = response.headers.get('x-connection-code');
    if (!next)
      throw new Error(
        'Proxy did not expose a rotated code; reconnect and check CORS',
      );
    this.storage.setItem(key + id, JSON.stringify({ ...current, code: next }));

    return response;
  }
}
