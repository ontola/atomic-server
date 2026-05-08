import { createAuthentication } from './authentication.js';
import { Resource } from './resource.js';
import { recordServerVersionFromWsProtocol } from './serverCapabilities.js';
import type { Store } from './store.js';
import { AtomicError, ErrorType } from './error.js';
import {
  Tag,
  Flags,
  encodeAuth,
  encodeGet,
  encodeSub,
  encodeUnsub,
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

// 15s, not 5s — under network load (heavy commit traffic, search-index
// rebuilds, multi-tab sync) the server can take longer than 5s to ack a
// GET. Failing with `timed out after 5000ms` then sends the user to the
// error page even when the resource is on its way. 15s matches the e2e
// suite's heavy-action assertion budget and is still well under the
// 30s default test timeout.
const REQUEST_TIMEOUT = 15000;
const WS_PROTOCOL = 'atomicdata-ws.v2';

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
  private nextRequestId = 1;

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

        this.store.setServerConnected(false);
      });
      ws.addEventListener('close', () => {
        this.store.setServerConnected(false);

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
          this.store.setServerConnected(true);
          this.handleOpen();
        });
      });

      this.ws = ws;
    };

    createSocket();
  }

  public get readyState(): number {
    return this.ws.readyState;
  }

  public close(): void {
    this._closed = true;

    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
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

        // Wait for AUTH_OK
        await this.waitForTag(Tag.AUTH_OK, REQUEST_TIMEOUT);

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

  /** @deprecated Use drive-level subscriptions. */
  public subscribeResource(_subject: string): void {
    // No-op — v2 uses drive-level subscriptions only.
  }

  public unsubscribeResource(subject: string): void {
    this.sendBinary(encodeUnsub(subject));
  }

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
      const timer = setTimeout(() => {
        this.pendingGets.delete(requestId);
        reject(
          new Error(`GET "${subject}" timed out after ${REQUEST_TIMEOUT}ms.`),
        );
      }, REQUEST_TIMEOUT);

      this.pendingGets.set(requestId, { subject, resolve, reject, timer });
      this.sendBinary(encodeGet(requestId, subject));
    });
  }

  // ---- Loro sync (real-time collaboration) ----

  public subscribeLoroSync(subject: string): void {
    // Still uses text for now — low-frequency, will migrate later
    if (this.readyState === WebSocket.OPEN) {
      this.ws.send(
        new TextEncoder().encode(
          'LORO_SYNC_SUBSCRIBE ' + JSON.stringify({ subject }),
        ),
      );
    }
  }

  public unsubscribeLoroSync(subject: string): void {
    if (this.readyState === WebSocket.OPEN) {
      this.ws.send(
        new TextEncoder().encode(
          'LORO_SYNC_UNSUBSCRIBE ' + JSON.stringify({ subject }),
        ),
      );
    }
  }

  public sendLoroSyncUpdate(message: string): void {
    if (this.readyState === WebSocket.OPEN) {
      this.ws.send(new TextEncoder().encode('LORO_SYNC_UPDATE ' + message));
    }
  }

  public sendLoroEphemeralUpdate(message: string): void {
    if (this.readyState === WebSocket.OPEN) {
      this.ws.send(
        new TextEncoder().encode('LORO_EPHEMERAL_UPDATE ' + message),
      );
    }
  }

  /** Send a binary frame, logging it in debug mode. */
  private sendBinary(frame: Uint8Array) {
    if (this.debug) {
      logFrame(frame, '→', '#9bf');
    }

    this.ws.send(frame);
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

    switch (tag) {
      case Tag.AUTH_OK:
        // Resolved by waitForTag
        break;

      case Tag.ERROR: {
        const msg = decodeError(payload);

        if (msg && msg.requestId) {
          const pending = this.pendingGets.get(msg.requestId);

          if (pending) {
            clearTimeout(pending.timer);
            this.pendingGets.delete(msg.requestId);
            pending.reject(new AtomicError(msg.message, ErrorType.Server));
          }
        } else if (msg) {
          this.store.notifyError(msg.message);
        }

        break;
      }

      case Tag.UPDATE: {
        const msg = decodeUpdate(payload);

        if (!msg) break;

        // Is this a response to a pending GET?
        if (msg.requestId && this.pendingGets.has(msg.requestId)) {
          const pending = this.pendingGets.get(msg.requestId)!;
          clearTimeout(pending.timer);
          this.pendingGets.delete(msg.requestId);

          const resource = this.store.getResourceLoading(msg.subject);
          resource.importLoroUpdate(msg.loroBytes);

          if (msg.commitId) {
            resource.setLastCommitValue(msg.commitId);
          }

          resource.source = 'server-ws';
          resource.sourceTimestamp = Date.now();
          resource.loading = false;
          this.store.addResources(resource, { skipCommitCompare: true });
          pending.resolve(resource);

          break;
        }

        // Subscription push
        let resource = this.store.resources.get(msg.subject);

        if (resource) {
          resource.importLoroUpdate(msg.loroBytes);
        } else {
          resource = this.store.getResourceLoading(msg.subject);
          resource.importLoroUpdate(msg.loroBytes);
          resource.loading = false;
        }

        if (msg.commitId) {
          resource.setLastCommitValue(msg.commitId);
        }

        resource.source = msg.flags & Flags.PUSH ? 'ws-commit' : 'server-ws';
        resource.sourceTimestamp = Date.now();
        this.store.addResources(resource, { skipCommitCompare: true });
        this.persistToClientDb(msg.subject, resource);
        this.checkForMissingBlobs(resource);

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
          this.handleSyncDiff(msg);
        }

        break;
      }

      case Tag.SYNC_PUSH: {
        const msg = decodeSyncPush(payload);

        if (msg) {
          for (const { subject, loroBytes } of msg.entries) {
            let resource = this.store.resources.get(subject);

            if (resource) {
              resource.importLoroUpdate(loroBytes);
            } else {
              resource = this.store.getResourceLoading(subject);
              resource.importLoroUpdate(loroBytes);
              // Setting `loading = false` here is safe even when Loro
              // hasn't loaded yet: the `loading` getter checks for
              // buffered `_loroSnapshotBytes` and keeps reporting `true`
              // until `getLoroDoc()` hydrates the buffer. So consumers
              // (useTitle, etc.) keep seeing a loading state for the
              // brief window where bytes are buffered but unreadable.
              resource.loading = false;
            }

            resource.source = 'server-ws';
            resource.sourceTimestamp = Date.now();
            this.store.addResources(resource, {
              skipCommitCompare: true,
            });
            this.persistToClientDb(subject, resource);
            this.checkForMissingBlobs(resource);
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
          const clientDb = this.store.getClientDb();

          if (clientDb) {
            clientDb.putBlob(resp.hash, resp.bytes);
          }
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
    if (text.startsWith('LORO_SYNC_UPDATE ')) {
      this.store.__handleLoroSyncMessage(text.slice(17));
    } else if (text.startsWith('LORO_EPHEMERAL_UPDATE ')) {
      this.store.__handleLoroEphemeralMessage(text.slice(21));
    } else if (text.startsWith('QUERY_UPDATE ')) {
      try {
        const update = JSON.parse(text.slice(13));
        const added: string[] = update.added ?? [];
        const removed: string[] = update.removed ?? [];

        // Same shape as the binary handler: each fetched/removed subject
        // flows through `addResources`/`removeResource`, which fires
        // `ResourceUpdated`/`ResourceRemoved` for `useCollection` to react.
        for (const s of removed) {
          this.store.removeResource(s);
        }
        for (const s of added) {
          this.store.fetchResourceFromServer(s).catch(() => {});
        }
      } catch {
        // ignore
      }
    } else if (text === 'AUTHENTICATED') {
      // Legacy auth response — handled for backward compat
    }
  }

  // ---- Private: connection lifecycle ----

  private handleOpen() {
    const agent = this.store.getAgent();
    const drive = this.store.getDrive();

    const doSync = async () => {
      try {
        await this.store
          .syncDirtyResources()
          .then(() => this.startVVSync(drive))
          .catch(() => this.startVVSync(drive));
      } catch {
        // Non-fatal
      }
    };

    if (agent?.subject) {
      this.authenticate()
        .then(doSync)
        .catch(e => console.error('Auth error:', e));
    } else {
      doSync().catch(() => {});
    }
  }

  private async startVVSync(drive: string): Promise<void> {
    if (this.readyState !== WebSocket.OPEN) return;

    this.store.startDriveSync(drive);

    try {
      const syncState = await this.store.computeDriveSyncState(drive);
      // Still sending as text SYNC_VV — will migrate to binary SYNC later
      this.ws.send('SYNC_VV ' + JSON.stringify(syncState));
    } catch (e) {
      console.warn('[WS] VV sync failed:', e);
    }
  }

  /**
   * Handle SYNC_DIFF: server tells us which resources differ.
   * We send Loro deltas for resources the server needs (pull list).
   */
  private async handleSyncDiff(diff: {
    drive: string;
    pull: string[];
    push: string[];
  }) {
    const deltas: Record<string, string> = {};

    for (const subject of diff.pull) {
      const resource = this.store.resources.get(subject);
      const doc = resource?.getLoroDoc?.();

      if (doc) {
        try {
          const snapshot = doc.export({ mode: 'snapshot' });
          // Base64 encode for SYNC_DELTAS text message (will be binary later)
          deltas[subject] = btoa(
            String.fromCharCode(...new Uint8Array(snapshot)),
          );
        } catch {
          // skip
        }
      }
    }

    if (Object.keys(deltas).length > 0) {
      this.ws.send(
        'SYNC_DELTAS ' + JSON.stringify({ drive: diff.drive, deltas }),
      );
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

  private persistToClientDb(subject: string, resource: Resource) {
    const clientDb = this.store.getClientDb();

    if (clientDb) {
      const doc = resource.getLoroDoc?.();

      if (doc) {
        const snapshot = doc.export({ mode: 'snapshot' });
        clientDb.putLoroSnapshot(subject, snapshot).catch(() => {});
      }
    }
  }

  private tagListeners = new Map<number, () => void>();

  private waitForTag(tag: number, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.tagListeners.delete(tag);
        reject(new Error(`Timeout waiting for tag 0x${tag.toString(16)}`));
      }, timeout);

      this.tagListeners.set(tag, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** Check if a browser context supports WebSockets */
export function supportsWebSockets(): boolean {
  return typeof WebSocket !== 'undefined';
}
