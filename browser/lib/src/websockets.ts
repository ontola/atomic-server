import { createAuthentication } from './authentication.js';
import { Resource } from './resource.js';
import { recordServerVersionFromWsProtocol } from './serverCapabilities.js';
import type { Store } from './store.js';
import { AtomicError, ErrorType } from './error.js';
import {
  type Commit,
  parseCommitJSON,
  serializeDeterministically,
} from './commit.js';
import {
  Tag,
  Flags,
  encodeAuth,
  encodeCommit,
  encodeGet,
  encodeSub,
  decodeCommit,
  decodeUpdate,
  decodeError,
  decodeSyncOk,
  decodeSyncDiff,
  decodeSyncPush,
  decodeBlobRequest,
  decodeBlobResponse,
  decodeQueryUpdate,
  encodeBlobResponse,
  encodeBlobRequest,
  debugFrameInfo,
} from './ws-v2.js';
import { BLOB } from './urls.js';
import { hexToBytes, bytesToHex } from './value.js';
import { perfMark, perfSpan } from './perf-trace.js';

// 5s is too tight for a shared atomic-server under suite-wide e2e load
// (auth race + drive sub + several parallel GETs queue up). Above ~10s, the
// failure mode is a real server hang or stuck WS, not transient slowness.
const REQUEST_TIMEOUT = 10000;
const WS_PROTOCOL = 'atomicdata-ws.v2';

/**
 * Chunked base64 encoder. `btoa(String.fromCharCode(...arr))` blows up
 * on large arrays — argument-spread is bounded to ~65k items by every
 * engine. Loro snapshots are routinely larger (a chat room oplog can
 * be hundreds of KB). Process in 32k-byte slabs to stay well below the
 * spread limit while still amortising the `apply` overhead.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const slab = 0x8000;

  for (let i = 0; i < bytes.length; i += slab) {
    binary += String.fromCharCode.apply(
      null,
      // `subarray` is a view, no copy; `apply` accepts the typed array.
      bytes.subarray(i, i + slab) as unknown as number[],
    );
  }

  return btoa(binary);
}

const connectionFailedMessage = (url: URL): string =>
  `Could not connect to ${url.origin}. Check that the server is running and reachable.`;

/**
 * Decide whether a QUERY_UPDATE `added` subject needs a network fetch.
 *
 * Commits are immutable: once the local store has one, re-fetching is
 * pure waste. This is the self-echo case from posting a chat message —
 * the client signs and posts a commit, the server processes it and
 * broadcasts QUERY_UPDATE to all subscribers (including us), and the
 * stock handler then GETs the commit DID it literally just sent. The
 * server response carries identical bytes to the locally-signed copy.
 *
 * Non-commit subjects are kept on the fetch path: regular resources
 * can be mutated, so a QUERY_UPDATE `added` may signal a new version
 * the local copy doesn't have. Per-resource version dedup happens
 * deeper, inside `applyIncoming` (commit-id check), but the WS GET
 * round-trip is unavoidable for those — the QUERY_UPDATE frame
 * itself doesn't carry the payload.
 */
export function shouldFetchOnQueryUpdate(
  subject: string,
  store: Store,
): boolean {
  if (subject.startsWith('did:ad:commit:') && store.resources.has(subject)) {
    return false;
  }
  return true;
}

// Optional perf-profiler hook. The data-browser app installs an object
// at `window.__atomicProfiler` that aggregates render + event counts;
// when it's present we feed WS frame traffic through it. Reverse-lookup
// of the Tag enum is cached so the hot path is just two property reads.
const TAG_NAMES: Record<number, string> = (() => {
  const out: Record<number, string> = {};
  for (const [name, value] of Object.entries(Tag)) {
    out[value as number] = name;
  }
  return out;
})();
function tagName(tag: number): string {
  return TAG_NAMES[tag] ?? `0x${tag.toString(16)}`;
}
function profilerTick(name: string, payload?: unknown): void {
  const w = globalThis as {
    __atomicProfiler?: { tick: (n: string, p?: unknown) => void };
  };
  w.__atomicProfiler?.tick(name, payload);
}

/**
 * Render one WS frame to the console as a collapsible group:
 *
 *   ▸ → UPDATE did:ad:abc... [snapshot] (820B)        ← always visible
 *       └─ { subject, flags, commitId, properties: { name: "...", ...} }
 *                                                     ← console.debug,
 *                                                       hidden unless the
 *                                                       DevTools log level
 *                                                       includes "Verbose".
 *
 * Modern browsers gate `console.debug` behind the verbose level by default,
 * so users get the headline they want without their console drowning in
 * snapshot blobs unless they ask for it. The group itself collapses by
 * default so multiple frames stay one line each.
 */
function logFrame(data: Uint8Array, direction: '→' | '←', color: string): void {
  const info = debugFrameInfo(data, direction);

  if (info.details === undefined) {
    console.log(`%c${info.headline}`, `color: ${color}`);

    return;
  }

  console.groupCollapsed(`%c${info.headline}`, `color: ${color}`);
  try {
    const details = info.details() as Record<string, unknown>;
    // For UPDATE frames the raw `loroSnapshot` Uint8Array isn't useful at a
    // glance. Materialize it through a throwaway Resource and replace it
    // with a `properties` object containing the snapshot's propvals — same
    // shape the Sync page commit log uses, just inline in the console.
    const enriched = decodeUpdateProperties(details);
    console.debug(enriched);
  } catch (e) {
    console.debug('(failed to decode frame details)', e);
  }
  console.groupEnd();
}

/**
 * If the details payload looks like an UPDATE frame (has `loroSnapshot`),
 * decode the snapshot into propvals and swap it in. Falls back to the raw
 * details on any decode failure so a malformed snapshot can't break the
 * frame log.
 */
function decodeUpdateProperties(
  details: Record<string, unknown>,
): Record<string, unknown> {
  const snapshot = details.loroSnapshot;
  const subject = details.subject;

  if (!(snapshot instanceof Uint8Array) || typeof subject !== 'string') {
    return details;
  }

  try {
    const tmp = new Resource(subject);
    tmp.importLoroUpdate(snapshot);
    const properties: Record<string, unknown> = {};

    for (const [prop, value] of tmp.getEntries()) {
      // Skip the loro snapshot field itself — it's the bytes we just decoded.
      if (prop === 'https://atomicdata.dev/properties/loroUpdate') continue;
      properties[shortPropName(prop)] = value;
    }

    // Mutating-ish: keep the order so loroSnapshot stays at the bottom for
    // anyone who still wants to see the raw bytes.
    const { loroSnapshot, ...rest } = details;

    return { ...rest, properties, loroSnapshot };
  } catch {
    return details;
  }
}

function shortPropName(url: string): string {
  // `https://atomicdata.dev/properties/name` → `name`. For non-atomicdata.dev
  // properties (custom ontologies) the fragment after the last `/` is still
  // the most readable thing without a property cache.
  const lastSlash = url.lastIndexOf('/');

  return lastSlash >= 0 ? url.slice(lastSlash + 1) : url;
}

/**
 * A WebSocket client using the v2 binary protocol.
 * All messages are binary frames — no JSON-AD parsing on the hot path.
 */
export class WSClient {
  private ws: WebSocket;
  private store: Store;
  private authPromise: Promise<void>;
  private openPromise: Promise<void>;

  private authenticatedWith: string | undefined;
  private isAuthenticating = false;

  private _closed = false;
  private _retryDelay = 1000;
  private _retryTimer: ReturnType<typeof setTimeout> | undefined;
  private _onlineListener: (() => void) | undefined;

  /** When true, all WS frames are logged to the console in human-readable form. */
  public debug =
    typeof localStorage !== 'undefined' &&
    localStorage.getItem('ws-debug') === '1';

  /** Pending GET requests awaiting a response, keyed by request_id. */
  private pendingGets = new Map<
    number,
    {
      subject: string;
      resolve: (r: Resource) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Pending COMMIT requests awaiting a `COMMIT_OK` (or `ERROR`),
   *  keyed by request_id. */
  private pendingCommits = new Map<
    number,
    {
      resolve: (c: Commit) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextRequestId = 1;

  /** Take a pending GET out of the queue, cancel its timer. Caller
   *  invokes resolve/reject on the returned entry. */
  private takePending(requestId: number) {
    const pending = this.pendingGets.get(requestId);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pendingGets.delete(requestId);
    return pending;
  }

  /** Take a pending COMMIT out of the queue, cancel its timer. */
  private takePendingCommit(requestId: number) {
    const pending = this.pendingCommits.get(requestId);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pendingCommits.delete(requestId);
    return pending;
  }

  /** Fail every in-flight GET. Called on WS close so callers don't
   *  hang for REQUEST_TIMEOUT (10 s) when the socket dies mid-flight
   *  — the next reconnect will fetch fresh state anyway. */
  private rejectAllPending(reason: string): void {
    const err = new AtomicError(reason, ErrorType.Server);
    // Fail any in-flight `waitForTag` calls (e.g. an AUTH_OK that
    // will never arrive because the socket died mid-handshake).
    if (this.tagRejectors.size > 0) {
      const rejectors = [...this.tagRejectors];
      this.tagRejectors.clear();
      this.tagListeners.clear();
      for (const r of rejectors) r(err);
    }
    if (this.pendingGets.size > 0) {
      const entries = [...this.pendingGets.values()];
      this.pendingGets.clear();
      for (const p of entries) {
        clearTimeout(p.timer);
        p.reject(err);
      }
    }
    if (this.pendingCommits.size > 0) {
      const entries = [...this.pendingCommits.values()];
      this.pendingCommits.clear();
      for (const p of entries) {
        clearTimeout(p.timer);
        p.reject(err);
      }
    }
  }

  constructor(url: string, store: Store) {
    this.store = store;
    this.handleMessage = this.handleMessage.bind(this);
    this.handleOpen = this.handleOpen.bind(this);

    const wsURL = new URL(url);
    wsURL.protocol = wsURL.protocol === 'http:' ? 'ws' : 'wss';
    wsURL.pathname = '/ws';

    this.authPromise = Promise.resolve();

    const createSocket = () => {
      const ws = new WebSocket(wsURL.toString(), [WS_PROTOCOL]);
      ws.binaryType = 'arraybuffer';
      let opened = false;

      ws.addEventListener('message', this.handleMessage);
      ws.addEventListener('error', () => {
        if (!opened) {
          console.warn('[WS] Connection failed');
        }

        this.store.setServerConnected(false, connectionFailedMessage(wsURL));
        // Some environments fire error without an immediately-following
        // close. Reject anyway — if close does fire later, the second
        // rejectAllPending sees an empty Map and is a no-op.
        this.rejectAllPending('WebSocket error before response arrived');
      });
      ws.addEventListener('close', () => {
        const error = this._closed
          ? undefined
          : opened
            ? `Connection to ${wsURL.origin} closed.`
            : connectionFailedMessage(wsURL);

        this.store.setServerConnected(false, error);
        this.rejectAllPending('WebSocket closed before response arrived');

        if (!this._closed) {
          this._retryTimer = setTimeout(() => {
            this.authenticatedWith = undefined;
            createSocket();
          }, this._retryDelay);
          this._retryDelay = Math.min(this._retryDelay * 2, 30000);
        }
      });
      this.openPromise = new Promise(resolve => {
        ws.addEventListener('open', () => {
          opened = true;
          this._retryDelay = 1000;
          resolve();
          // setServerConnected(true) is deliberately NOT called here.
          // Firing it on WS open creates a race window between OPEN and
          // AUTH_OK: useResource(drive) can fire during that gap, see
          // `_serverConnected === true`, take the online fetch path, and
          // call ws.fetch — which itself awaits `authenticate()`. If the
          // auth handshake is slow (Rosetta-translated crypto, busy
          // server), the GET frame is never sent until auth completes,
          // and ws.fetch's REQUEST_TIMEOUT only starts AFTER auth, so a
          // stalled handshake hangs every fetch indefinitely. `handleOpen`
          // below flips the flag at the right moment: immediately when
          // there's no agent to authenticate, otherwise after AUTH_OK.
          this.handleOpen();
        });
      });

      this.ws = ws;
    };

    createSocket();

    // Wake the retry loop immediately when the OS reports network back
    // up — otherwise we wait out the current backoff (up to 30 s) before
    // even trying. Matches the dagger-flake pattern where `setOffline(false)`
    // doesn't reconnect within the test timeout. No-op outside the browser.
    if (
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function'
    ) {
      this._onlineListener = () => {
        // Skip if the WS is already trying or up. Without the CONNECTING
        // guard, a fast online-then-timer race can spawn two sockets:
        // the retry timer fires first → socket1 created → online event
        // fires next → my handler creates socket2 → socket1 leaks.
        if (this._closed) return;
        const rs = this.ws.readyState;
        if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) return;
        if (this._retryTimer) {
          clearTimeout(this._retryTimer);
          this._retryTimer = undefined;
        }
        this._retryDelay = 1000;
        this.authenticatedWith = undefined;
        createSocket();
      };
      window.addEventListener('online', this._onlineListener);
    }
  }

  public get readyState(): number {
    return this.ws.readyState;
  }

  public close(): void {
    this._closed = true;

    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
    }

    if (
      this._onlineListener &&
      typeof window !== 'undefined' &&
      typeof window.removeEventListener === 'function'
    ) {
      window.removeEventListener('online', this._onlineListener);
      this._onlineListener = undefined;
    }

    this.ws.close();
  }

  // ---- Authentication ----

  public async authenticate(fetchAll?: boolean): Promise<void> {
    const agent = this.store.getAgent();

    if (!agent?.subject) return;
    if (this.authenticatedWith === agent.subject && !fetchAll) return;
    // An in-flight auth might be for a DIFFERENT (e.g. now-stale) agent. Wait
    // for it to settle, then check whether we still need to authenticate as
    // the current agent. Without this re-check, calling `setAgent(newAgent)`
    // mid-flight (e.g. onboarding swapping the dev-drive agent for a freshly-
    // created one) silently keeps the WS bound to the old agent, and the next
    // `ws.fetch(newAgent.subject)` returns 401 because the old agent has no
    // read rights on the new agent's resource.
    if (this.isAuthenticating) {
      try {
        await this.authPromise;
      } catch {}
      if (this.authenticatedWith === agent.subject && !fetchAll) return;
    }

    this.isAuthenticating = true;

    this.authPromise = (async () => {
      try {
        await this.openPromise;
        const json = await createAuthentication(this.serverOrigin, agent);

        this.sendBinary(encodeAuth(JSON.stringify(json)));

        // Wait for AUTH_OK — rejected by the close handler if the socket
        // dies mid-handshake, otherwise waits as long as needed.
        await this.waitForTag(Tag.AUTH_OK);

        this.authenticatedWith = agent.subject;
        recordServerVersionFromWsProtocol(
          this.serverOrigin,
          this.ws.protocol || WS_PROTOCOL,
        );

        // Re-subscribe to drive queries
        const drive = this.store.getDrive();

        if (drive) {
          this.sendBinary(encodeSub(drive));
        }

        // Re-subscribe to active Loro sync and ephemeral channels
        this.reSubscribeAll();

        // Refetch resources that had 401 errors
        if (fetchAll) {
          for (const resource of this.store.resources.values()) {
            if (resource.isUnauthorized()) {
              this.fetch(resource.subject).catch(() => {});
            }
          }
        }
      } finally {
        this.isAuthenticating = false;
      }
    })();

    return this.authPromise;
  }

  // ---- Resource operations ----

  /** Fetch a resource over WebSocket. Returns a promise that resolves when the UPDATE arrives. */
  public async fetch(subject: string): Promise<Resource> {
    // Ensure auth has been kicked off before sending the GET. `authPromise`
    // starts as a resolved promise (not undefined), so `await this.authPromise`
    // alone is a no-op when nobody has called `authenticate()` yet — that
    // races with `handleOpen` and `setAgent`. The server then returns a
    // PublicAgent view of permissioned resources (typically just `description`,
    // `isA`, `lastCommit`, `loroUpdate` — `name`/`read`/`write` are filtered
    // out), the resource gets cached as `loading=false, name=undefined`, and
    // the UI never recovers because nothing flags it as unauthorized to
    // refetch on the next `setAgent`. `authenticate()` is idempotent: it
    // returns immediately if there's no agent or we've already authenticated
    // as the current one, and reuses the in-flight promise otherwise.
    await this.authenticate();

    if (this.readyState !== WebSocket.OPEN) {
      throw new AtomicError(
        `WebSocket not open, cannot fetch ${subject}`,
        ErrorType.Server,
      );
    }

    const requestId = this.nextRequestId++;

    if (this.nextRequestId > 0xffff) {
      this.nextRequestId = 1;
    }

    return new Promise((resolve, reject) => {
      const close = perfSpan('ws.GET', { subject: subject.slice(0, 200) });
      const timer = setTimeout(() => {
        this.pendingGets.delete(requestId);
        close({ err: 'timeout' });
        reject(
          new Error(`GET "${subject}" timed out after ${REQUEST_TIMEOUT}ms.`),
        );
      }, REQUEST_TIMEOUT);

      this.pendingGets.set(requestId, {
        subject,
        resolve: (r: Resource) => {
          close('ok');
          resolve(r);
        },
        reject: (e: unknown) => {
          close({ err: e instanceof Error ? e.message : String(e) });
          reject(e);
        },
        timer,
      });
      this.sendBinary(encodeGet(requestId, subject));
    });
  }

  /**
   * Send a signed commit over the WebSocket. Resolves with the
   * server's created commit resource (same shape as HTTP `/commit`
   * returns) once a `COMMIT_OK` with a matching request id arrives.
   *
   * Throws `AtomicError` on `ERROR` with the same request id, on
   * socket close mid-flight (`rejectAllPending`), or on timeout.
   *
   * The server stores the commit's `connection_id` as the event
   * source and suppresses broadcasts back to this connection — the
   * client never receives its own commit as a subscription push.
   * HTTP `/commit` remains the fallback when the WS isn't usable.
   */
  public async postCommit(commit: Commit): Promise<Commit> {
    await this.authenticate();

    if (this.readyState !== WebSocket.OPEN) {
      throw new AtomicError(
        'WebSocket not open, cannot post commit',
        ErrorType.Server,
      );
    }

    const serialized = serializeDeterministically({ ...commit });
    const requestId = this.nextRequestId++;
    if (this.nextRequestId > 0xffff) {
      this.nextRequestId = 1;
    }

    return new Promise((resolve, reject) => {
      const close = perfSpan('ws.COMMIT');
      const timer = setTimeout(() => {
        this.pendingCommits.delete(requestId);
        close({ err: 'timeout' });
        reject(
          new AtomicError(
            `COMMIT timed out after ${REQUEST_TIMEOUT}ms.`,
            ErrorType.Server,
          ),
        );
      }, REQUEST_TIMEOUT);

      this.pendingCommits.set(requestId, {
        resolve: (c: Commit) => {
          close('ok');
          resolve(c);
        },
        reject: (e: Error) => {
          close({ err: e.message });
          reject(e);
        },
        timer,
      });
      this.sendBinary(encodeCommit(requestId, serialized));
    });
  }

  // ---- Loro sync (real-time collaboration) ----

  /** Send a text frame `<prefix> <payload>` if the WS is open.
   *  Loro sync still uses text frames (low-frequency, will migrate
   *  to binary later). No-op on non-open sockets. */
  private sendText(prefix: string, payload: string): void {
    if (this.readyState !== WebSocket.OPEN) return;
    if (this.debug) {
      console.log(`[WS] sendText: ${prefix} ${payload.slice(0, 100)}...`);
    }
    // Must send a string: `ws.send(Uint8Array)` emits a *binary* frame, which
    // the server routes by tag byte and drops as an unknown tag.
    this.ws.send(`${prefix} ${payload}`);
  }

  public subscribeLoroSync(subject: string): void {
    this.sendText('LORO_SYNC_SUBSCRIBE', JSON.stringify({ subject }));
  }

  public unsubscribeLoroSync(subject: string): void {
    this.sendText('LORO_SYNC_UNSUBSCRIBE', JSON.stringify({ subject }));
  }

  public sendLoroSyncUpdate(message: string): void {
    this.sendText('LORO_SYNC_UPDATE', message);
  }

  public sendLoroEphemeralUpdate(message: string): void {
    this.sendText('LORO_EPHEMERAL_UPDATE', message);
  }

  /** Send a binary frame, logging it in debug mode. */
  private sendBinary(frame: Uint8Array) {
    if (this.debug) {
      logFrame(frame, '→', '#9bf');
    }

    if (frame.length > 0)
      profilerTick(`ws.out.${tagName(frame[0])}`, frame.length);

    this.ws.send(new Uint8Array(frame));
  }

  /**
   * Push a blob to the server proactively. The server's BLOB_RESPONSE handler
   * stores it in `Tree::Blobs` and serves it from `/download/files/<hash>`.
   *
   * Used by {@link Store.uploadFiles} after committing a File resource so the
   * server has the bytes without waiting for a sync round to fire BLOB_REQUEST.
   * No-op if the WS isn't open.
   */
  public sendBlob(hash: Uint8Array, bytes: Uint8Array): void {
    if (this.readyState !== WebSocket.OPEN) {
      return;
    }
    this.sendBinary(encodeBlobResponse(hash, bytes));
  }

  // ---- Private: message handling ----

  private get serverOrigin(): string {
    const url = new URL(this.ws.url);
    url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';

    return url.origin;
  }

  private handleMessage(ev: MessageEvent) {
    if (ev.data instanceof ArrayBuffer) {
      this.handleBinary(new Uint8Array(ev.data));
    } else if (typeof ev.data === 'string') {
      // Legacy text messages (Loro sync, query updates) — handle minimally
      this.handleText(ev.data);
    }
  }

  private handleBinary(data: Uint8Array) {
    if (data.length === 0) return;

    if (this.debug) {
      logFrame(data, '←', '#6b9');
    }

    const tag = data[0];
    const payload = data.subarray(1);

    profilerTick(`ws.in.${tagName(tag)}`, data.length);

    switch (tag) {
      case Tag.AUTH_OK:
        // Resolved by waitForTag
        break;

      case Tag.ERROR: {
        const msg = decodeError(payload);
        if (!msg) break;
        if (msg.requestId) {
          const err = new AtomicError(msg.message, ErrorType.Server);
          const pendingGet = this.takePending(msg.requestId);
          if (pendingGet) {
            pendingGet.reject(err);
          } else {
            this.takePendingCommit(msg.requestId)?.reject(err);
          }
        } else {
          this.store.notifyError(msg.message);
        }
        break;
      }

      case Tag.COMMIT_OK: {
        const msg = decodeCommit(payload);
        if (!msg) break;
        const pending = this.takePendingCommit(msg.requestId);
        if (!pending) break;
        try {
          const created = parseCommitJSON(msg.commitJson);
          pending.resolve(created);
        } catch (e) {
          pending.reject(
            e instanceof Error
              ? e
              : new AtomicError(String(e), ErrorType.Server),
          );
        }
        break;
      }

      case Tag.UPDATE: {
        const msg = decodeUpdate(payload);

        if (!msg) break;

        // Pending-GET response: route through `applyIncoming` and
        // resolve the awaiting fetch promise. The previous
        // `getResourceLoading` + `importLoroUpdate` + `setLastCommit`
        // + `setSource` + `setLoading` + `addResources` chain is now
        // one call.
        const pending = msg.requestId
          ? this.takePending(msg.requestId)
          : undefined;
        if (pending) {
          this.store.applyIncoming({
            subject: msg.subject,
            loroBytes: msg.loroBytes,
            commitId: msg.commitId,
            source: 'ws-pending-get',
          });
          // The resource we just hydrated is what the GET caller is
          // waiting for — read it back from the store map.
          const resource = this.store.resources.get(msg.subject);
          if (resource) pending.resolve(resource);
          break;
        }

        // Subscription push: same call, different `source`. The
        // commit-id dedup inside `applyIncoming` replaces the
        // hand-rolled `isExisting + prevCommit` echo check that
        // used to live here. `addResource`'s `skipCommitCompare`
        // flag is still honoured for the rare case where the
        // pre-import lastCommit equals the post-import (e.g. a
        // properties-only push) — applyIncoming sets it
        // unconditionally, so the gate runs once at the top.
        this.store.applyIncoming({
          subject: msg.subject,
          loroBytes: msg.loroBytes,
          commitId: msg.commitId,
          source: msg.flags & Flags.PUSH ? 'ws-sub-push' : 'ws-pending-get',
        });

        const resource = this.store.resources.get(msg.subject);
        if (resource) this.checkForMissingBlobs(resource);

        break;
      }

      case Tag.DESTROY: {
        const subject = new TextDecoder().decode(payload.subarray(2));

        if (subject) {
          this.store.removeResource(subject);
        }

        break;
      }

      case Tag.SYNC_OK: {
        const msg = decodeSyncOk(payload);

        if (msg) {
          this.store.finishDriveSync(msg.drive, 0, Date.now());
        }

        break;
      }

      case Tag.SYNC_DIFF: {
        const msg = decodeSyncDiff(payload);

        if (msg) {
          // handleSyncDiff is async but unawaited here — catch any
          // unhandled rejection so it can't propagate to the WS pump.
          this.handleSyncDiff(msg).catch(e =>
            console.warn('[WS] handleSyncDiff failed:', e),
          );
        }

        break;
      }

      case Tag.SYNC_PUSH: {
        const msg = decodeSyncPush(payload);

        if (msg) {
          // Per-entry `getResourceLoading + importLoroUpdate +
          // setSource + addResources({skipCommitCompare:true})`
          // collapsed into one `applyIncoming` call per entry.
          // The chunked-final-chunk drive-sync signal stays here.
          for (const { subject, loroBytes } of msg.entries) {
            this.store.applyIncoming({
              subject,
              loroBytes,
              source: 'ws-sync-push',
            });
            const resource = this.store.resources.get(subject);
            if (resource) this.checkForMissingBlobs(resource);
          }

          // Only mark the drive sync as finished on the final chunk —
          // SYNC_PUSH is chunked and intermediate chunks shouldn't trigger
          // the "done" UI state.
          if (msg.last) {
            this.store.finishDriveSync(
              msg.drive,
              msg.entries.length,
              Date.now(),
            );
          }
        }

        break;
      }

      case Tag.QUERY_UPDATE: {
        const msg = decodeQueryUpdate(payload);

        if (!msg) break;

        // Drive-wide subscription channel: server tells us a subject was
        // added or removed somewhere on the drive. Translate that into
        // store-level changes; `addResources` (called inside
        // `fetchResourceFromServer`) will fire `StoreEvents.ResourceUpdated`,
        // and each `useCollection` surgically applies the change against
        // its filter — no `/query` refetch storm.
        for (const s of msg.removed) {
          this.store.removeResource(s);
        }
        for (const s of msg.added) {
          if (!shouldFetchOnQueryUpdate(s, this.store)) continue;
          this.store.fetchResourceFromServer(s).catch(() => undefined);
        }
        break;
      }

      case Tag.BLOB_REQUEST: {
        const hash = decodeBlobRequest(payload);

        if (hash) {
          const clientDb = this.store.getClientDb();

          if (clientDb) {
            clientDb.getBlob(hash).then(bytes => {
              if (bytes) {
                this.sendBinary(encodeBlobResponse(hash, bytes));
              }
            });
          }
        }

        break;
      }

      case Tag.BLOB_RESPONSE: {
        const resp = decodeBlobResponse(payload);
        if (resp) {
          this.store.getClientDb()?.putBlob(resp.hash, resp.bytes);
        }
        break;
      }

      default:
        break;
    }

    // Emit raw tag for waitForTag listeners
    this.tagListeners.forEach((cb, t) => {
      if (t === tag) {
        cb();
        this.tagListeners.delete(t);
      }
    });
  }

  /** Handle legacy text messages that haven't been migrated to binary yet. */
  private handleText(text: string) {
    if (this.debug) {
      console.log(`[WS] handleText: ${text.slice(0, 100)}...`);
    }
    // Prefix lengths include the trailing space delimiter. Match the
    // exact length sent by `sendText(prefix, payload)` which writes
    // `${prefix} ${payload}`.
    if (text.startsWith('LORO_SYNC_UPDATE ')) {
      this.store.__handleLoroSyncMessage(
        text.slice('LORO_SYNC_UPDATE '.length),
      );
    } else if (text.startsWith('LORO_EPHEMERAL_UPDATE ')) {
      this.store.__handleLoroEphemeralMessage(
        text.slice('LORO_EPHEMERAL_UPDATE '.length),
      );
    } else if (text.startsWith('QUERY_UPDATE ')) {
      try {
        const update = JSON.parse(text.slice('QUERY_UPDATE '.length));
        const added: string[] = update.added ?? [];
        const removed: string[] = update.removed ?? [];

        // Same shape as the binary handler: each fetched/removed subject
        // flows through `addResources`/`removeResource`, which fires
        // `ResourceUpdated`/`ResourceRemoved` for `useCollection` to react.
        for (const s of removed) {
          this.store.removeResource(s);
        }
        for (const s of added) {
          if (!shouldFetchOnQueryUpdate(s, this.store)) continue;
          this.store.fetchResourceFromServer(s).catch(() => {});
        }
      } catch {
        // ignore
      }
    } else if (text === 'AUTHENTICATED') {
      // Legacy auth response — handled for backward compat
    }
  }

  private reSubscribeAll(): void {
    for (const subject of this.store.getLoroSyncSubjects()) {
      this.subscribeLoroSync(subject);
    }
  }

  // ---- Private: connection lifecycle ----

  private handleOpen() {
    perfMark('ws.open');
    const drive = this.store.getDrive();

    const doSync = async () => {
      const dirtyClose = perfSpan('ws.syncDirtyResources');
      // Drain the outbox; failures are recorded per-entry inside
      // the outbox itself, so a thrown drain doesn't prevent VV
      // sync from running.
      await this.store.syncDirtyResources().catch(() => undefined);
      dirtyClose();
      // Refetch resources whose offline state needs a server check
      // (errored-offline, stuck-loading). Runs AFTER drain so any
      // queued commits land before we ask the server for the
      // current state of those subjects — otherwise the refetch
      // pulls the pre-drain snapshot and the UI flickers back to
      // the offline-stale view.
      this.store.refetchOfflineErroredResources();
      // No drive selected (e.g. anon share-link cold open, fresh
      // /app/welcome before the user picks a drive): there's
      // nothing to VV-sync. The server's `collect_drive_subjects`
      // on a bare host URL used to walk every resource in the
      // store and starved the per-conn actor for seconds (see the
      // `anon_ws_get_during_sync_vv_is_fast` bench in
      // `server/tests/ws_get_unauthorized_latency.rs`).
      if (drive) {
        await this.startVVSync(drive);
      }
    };

    if (this.store.getAgent()?.subject) {
      const authClose = perfSpan('ws.authenticate');
      this.authenticate()
        .then(() => {
          authClose('ok');
          // Only flip `_serverConnected` AFTER AUTH_OK arrives. See the
          // comment in the `open` handler above for the race this closes.
          this.store.setServerConnected(true);
        })
        .then(doSync)
        .catch(e => {
          authClose({ err: String(e) });
          console.error('Auth error:', e);
          // Auth failed (timeout, server rejection, socket closed mid-
          // handshake). The socket itself may still be open — surface
          // the connected state anyway so the UI can present a real
          // error instead of staying stuck in a "connecting" limbo. The
          // pending GETs already rejected via `rejectAllPending` if the
          // socket died; if it's still up, subsequent fetches will fail
          // unauthenticated and surface a 401 error to the user.
          this.store.setServerConnected(true);
        });
    } else {
      // No agent to authenticate — the socket is open and we're ready
      // to serve anonymous fetches. Flip immediately.
      this.store.setServerConnected(true);
      this.reSubscribeAll();
      doSync().catch(() => undefined);
    }
  }

  private async startVVSync(drive: string): Promise<void> {
    if (this.readyState !== WebSocket.OPEN) return;

    this.store.startDriveSync();
    const close = perfSpan('ws.computeDriveSyncState');

    try {
      const syncState = await this.store.computeDriveSyncState(drive);
      close({ resourceCount: Object.keys(syncState.resources).length });
      // Still sending as text SYNC_VV — will migrate to binary SYNC later
      this.ws.send('SYNC_VV ' + JSON.stringify(syncState));
      perfMark('ws.SYNC_VV.sent');
    } catch (e) {
      close({ err: String(e) });
      console.warn('[WS] VV sync failed:', e);
    }
  }

  /**
   * Handle SYNC_DIFF: server tells us which resources differ.
   * We send Loro deltas for resources the server needs (pull list).
   *
   * For each `pull` subject we try the in-memory `Resource` first, then
   * fall back to the on-disk ClientDb snapshot. The fallback breaks the
   * "stale VV" stalemate where server thinks the client is ahead but
   * the client has only just opened the WS — none of those resources
   * are in `store.resources` yet, so the old in-memory-only loop sent
   * an empty SYNC_DELTAS, the server stayed behind, and the next
   * reconnect re-issued the same diff forever.
   */
  private async handleSyncDiff(diff: {
    drive: string;
    pull: string[];
    push: string[];
    remove?: string[];
  }) {
    for (const subject of diff.remove ?? []) {
      this.store.removeResource(subject);
    }

    const deltas: Record<string, string> = {};
    const clientDb = this.store.getClientDb();

    for (const subject of diff.pull) {
      let snapshot: Uint8Array | undefined;

      const memDoc = this.store.resources.get(subject)?.getLoroDoc?.();

      if (memDoc) {
        try {
          snapshot = memDoc.export({ mode: 'snapshot' });
        } catch {
          // Fall through to ClientDb.
        }
      }

      if ((!snapshot || snapshot.length === 0) && clientDb) {
        try {
          const stored = await clientDb.getLoroSnapshot(subject);
          if (stored && stored.length > 0) snapshot = stored;
        } catch {
          // skip — leave snapshot undefined
        }
      }

      if (snapshot && snapshot.length > 0) {
        try {
          deltas[subject] = bytesToBase64(snapshot);
        } catch {
          // skip
        }
      }
    }

    if (Object.keys(deltas).length > 0) {
      // The WS can transition to CLOSING after we receive the SYNC_DIFF
      // and before we get a chance to reply (server-initiated close,
      // network blip). `send` on a non-OPEN socket throws — swallow it,
      // the next reconnect's handleOpen will redo the VV sync.
      if (this.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(
          'SYNC_DELTAS ' + JSON.stringify({ drive: diff.drive, deltas }),
        );
      } catch (e) {
        console.warn('[WS] SYNC_DELTAS send failed:', e);
        return;
      }
    }

    // If server has nothing to push, sync is done
    if (diff.push.length === 0) {
      this.store.finishDriveSync(
        diff.drive,
        Object.keys(deltas).length,
        Date.now(),
      );
    }
  }

  // ---- Private: helpers ----

  private async checkForMissingBlobs(resource: Resource) {
    const blobDid = resource.get(BLOB) as string | undefined;

    if (!blobDid) return;

    // Extract the hash from did:ad:blob:{hash}
    const hashStr = blobDid.startsWith('did:ad:blob:')
      ? blobDid.substring(12)
      : blobDid;

    const clientDb = this.store.getClientDb();

    if (clientDb) {
      const hash = hexToBytes(hashStr);
      const exists = await clientDb.getBlob(hash);

      if (!exists) {
        this.sendBinary(encodeBlobRequest(hash));
      }
    }
  }

  private tagListeners = new Map<number, () => void>();
  private tagRejectors = new Set<(reason: Error) => void>();

  /** Wait for a specific WS tag (e.g. AUTH_OK) to arrive. Rejects when
   *  the underlying WebSocket closes/errors, or after `timeoutMs` if no
   *  matching frame arrives. A stressed atomic-server (8 workers, slow
   *  CI container, Rosetta-translated crypto) can legitimately take
   *  several seconds to respond to AUTH; the default 30s budget waits
   *  that out without leaving downstream callers hung forever. Without
   *  this, `ws.fetch` (which `await`s `authenticate()` before sending
   *  the GET frame) would hang indefinitely on a stalled handshake,
   *  ignoring its own REQUEST_TIMEOUT.
   *
   *  Pass `0` to disable the timeout. */
  private waitForTag(tag: number, timeoutMs = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.tagListeners.delete(tag);
              this.tagRejectors.delete(rejector);
              reject(
                new AtomicError(
                  `Timed out waiting ${timeoutMs}ms for WS tag ${tag}`,
                  ErrorType.Server,
                ),
              );
            }, timeoutMs)
          : undefined;
      const rejector = (err: Error) => {
        if (timer) clearTimeout(timer);
        this.tagListeners.delete(tag);
        this.tagRejectors.delete(rejector);
        reject(err);
      };
      this.tagRejectors.add(rejector);
      this.tagListeners.set(tag, () => {
        if (timer) clearTimeout(timer);
        this.tagRejectors.delete(rejector);
        resolve();
      });
    });
  }
}

/** Check if a browser context supports WebSockets */
export function supportsWebSockets(): boolean {
  return typeof WebSocket !== 'undefined';
}
