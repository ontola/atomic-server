import { createAuthentication } from './authentication.js';
import type { Resource } from './resource.js';
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
  debugFrame,
} from './ws-v2.js';

const REQUEST_TIMEOUT = 5000;
const WS_PROTOCOL = 'atomicdata-ws.v2';

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
    if (this.isAuthenticating) {
      await this.authPromise;

      return;
    }

    this.isAuthenticating = true;

    this.authPromise = (async () => {
      try {
        await this.openPromise;
        const json = await createAuthentication(
          this.serverOrigin,
          agent,
        );

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
    await this.authPromise;

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
          new Error(
            `GET "${subject}" timed out after ${REQUEST_TIMEOUT}ms.`,
          ),
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
      this.ws.send(
        new TextEncoder().encode('LORO_SYNC_UPDATE ' + message),
      );
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
      console.log(`%c${debugFrame(frame, '→')}`, 'color: #9bf');
    }

    this.ws.send(frame);
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
      console.log(`%c${debugFrame(data, '←')}`, 'color: #6b9');
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

        resource.source =
          msg.flags & Flags.PUSH ? 'ws-commit' : 'server-ws';
        resource.sourceTimestamp = Date.now();
        this.store.addResources(resource, { skipCommitCompare: true });
        this.persistToClientDb(msg.subject, resource);

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
              resource.loading = false;
            }

            resource.source = 'server-ws';
            resource.sourceTimestamp = Date.now();
            this.store.addResources(resource, {
              skipCommitCompare: true,
            });
            this.persistToClientDb(subject, resource);
          }

          this.store.finishDriveSync(
            msg.drive,
            msg.entries.length,
            Date.now(),
          );
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
        const subjects: string[] = [
          ...(update.added ?? []),
          ...(update.removed ?? []),
        ];

        for (const s of subjects) {
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
