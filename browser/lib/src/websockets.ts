import { createAuthentication } from './authentication.js';
import { parseCommitJSON } from './commit.js';
import { parseAndApplyCommit } from './index.js';
import { JSONADParser } from './parse.js';
import type { Resource } from './resource.js';
import {
  recordServerVersionFromWsProtocol,
  shouldSkipDidAuthForLegacyServer,
  warnDidAuthCompatibility,
} from './serverCapabilities.js';
import type { Store } from './store.js';
import { AtomicError, ErrorType } from './error.js';
import { classes } from './urls.js';

const REQUEST_TIMEOUT = 5000;

enum WS_Version {
  LEGACY = 'legacy',
  V1 = 'atomicdata-ws.v0.1',
}

function parseResourceMessage(ev: MessageEvent): Resource[] {
  const resourceJSON: string = ev.data.slice(9);
  const parsed = JSON.parse(resourceJSON);
  const parser = new JSONADParser();
  const resources = parser.parse(parsed);

  return resources;
}

/** Sends a GET message for some resource over websockets. */
export async function fetchWebSocket(
  client: WebSocket,
  subject: string,
): Promise<Resource> {
  return new Promise((resolve, reject) => {
    const listener = (ev: MessageEvent) => {
      if (ev.data.startsWith('RESOURCE ')) {
        parseResourceMessage(ev).forEach(resource => {
          // if it is the requested subject, return the resource
          if (resource.subject === subject) {
            clearTimeout(timeoutId);
            client.removeEventListener('message', listener);
            resolve(resource);
          }
        });
      }
    };

    const timeoutId = setTimeout(() => {
      client.removeEventListener('message', listener);
      reject(
        new Error(
          `Request for subject "${subject}" timed out after ${REQUEST_TIMEOUT}ms.`,
        ),
      );
    }, REQUEST_TIMEOUT);

    client.addEventListener('message', listener);
    client.send('GET ' + subject);
  });
}

/**
 * A client that does authentication and message handling for a single WebSocket connection.
 */
export class WSClient {
  // private url: string;
  private ws: WebSocket;
  private store: Store;
  private authPromise: Promise<void>;
  private openPromise: Promise<void>;

  private authenticatedWith: string | undefined;
  private isAuthenticating = false;

  private retryingOldVersion = false;

  constructor(url: string, store: Store) {
    this.store = store;
    this.handleMessage = this.handleMessage.bind(this);
    this.handleOpen = this.handleOpen.bind(this);

    const wsURL = new URL(url);

    // Default to a secure WSS connection, but allow WS for unsecured server connections
    if (wsURL.protocol === 'http:') {
      wsURL.protocol = 'ws';
    } else {
      wsURL.protocol = 'wss';
    }

    wsURL.pathname = '/ws';

    this.authPromise = Promise.resolve();

    const createSocket = (protocols?: string[]) => {
      const ws = new WebSocket(wsURL.toString(), protocols);
      let opened = false;
      ws.addEventListener('message', this.handleMessage);
      ws.addEventListener('error', e => {
        const triedV1 = protocols?.includes(WS_Version.V1) ?? false;

        // Only fall back to the legacy websocket protocol if the initial
        // V1 handshake itself fails before the socket ever opens.
        if (!opened && triedV1 && !this.retryingOldVersion) {
          this.retryingOldVersion = true;
          createSocket();

          return;
        }

        this.store.setServerConnected(false);

        return console.error('websocket error:', e);
      });
      ws.addEventListener('close', () => {
        this.store.setServerConnected(false);
      });
      this.openPromise = new Promise(resolve => {
        ws.addEventListener('open', () => {
          opened = true;
          resolve();
          this.store.setServerConnected(true);
          this.handleOpen();
        });
      });

      this.ws = ws;
    };

    createSocket([WS_Version.V1]);
  }

  public get readyState(): number {
    return this.ws.readyState;
  }

  public get protocolVersion(): string {
    return this.version;
  }

  private get version(): string {
    return this.ws.protocol || WS_Version.LEGACY;
  }

  private get serverOrigin(): string {
    const wsUrl = new URL(this.ws.url);
    const protocol = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';

    return `${protocol}//${wsUrl.host}`;
  }

  /**
   * Authenticates current Agent over current WebSocket. Doesn't do anything if
   * there is no agent
   */
  public async authenticate(fetchAll = false): Promise<void> {
    const agent = this.store.getAgent();

    if (!agent || !agent.subject) {
      return;
    }

    if (
      !this.ws.url.startsWith('ws://localhost') &&
      agent?.subject?.startsWith('http://localhost')
    ) {
      console.warn(
        `Can't authenticate localhost Agent over websocket with remote server ${this.ws.url} because the server will not be able to retrieve your Agent and verify your public key.`,
      );

      return;
    }

    // If already authenticating, wait for the in-progress attempt.
    if (this.isAuthenticating) {
      try {
        await this.authPromise;
      } catch (e) {
        // Authentication failed, continue as public agent.
      }

      return;
    }

    if (this.authenticatedWith === agent.subject) {
      return;
    }

    this.isAuthenticating = true;

    // Gate authPromise immediately so that any ws.fetch() calls issued during
    // the async setup (recordServerVersionFromWsProtocol, createAuthentication, etc.)
    // block until the server has actually confirmed authentication.
    let releaseGate!: () => void;
    let rejectGate!: (e: unknown) => void;
    this.authPromise = new Promise<void>((resolve, reject) => {
      releaseGate = resolve;
      rejectGate = reject;
    });

    try {
      await this.openPromise;

      recordServerVersionFromWsProtocol(this.version, this.serverOrigin);

      if (shouldSkipDidAuthForLegacyServer(this.ws.url, agent.subject)) {
        warnDidAuthCompatibility(this.ws.url);
        releaseGate();

        return;
      }

      const json = await createAuthentication(this.ws.url, agent);
      this.ws.send('AUTHENTICATE ' + JSON.stringify(json));

      if (this.version === WS_Version.LEGACY) {
        // Legacy servers don't send AUTHENTICATED back; release immediately.
        releaseGate();
      } else {
        // Wait for AUTHENTICATED confirmation, then release the gate.
        await this.waitForMessage('AUTHENTICATED');
        releaseGate();
      }

      this.authenticatedWith = agent?.subject;

      if (fetchAll) {
        this.store.resources.forEach(r => {
          if (r.isUnauthorized() || r.loading) {
            this.store.fetchResourceFromServer(r.subject);
          }
        });
      }
    } catch (e) {
      rejectGate(e);
      throw e;
    } finally {
      this.isAuthenticating = false;
    }

    return;
  }

  /**
   * @deprecated Individual resource subscriptions are replaced by drive-wide SUBSCRIBE_QUERY.
   * Kept as a no-op for backward compatibility with callers.
   */
  public subscribeResource(_subject: string): void {
    // No-op: we use drive-wide SUBSCRIBE_QUERY instead of per-resource SUBSCRIBE.
    // The drive subscription is set up in handleOpen().
  }

  public unsubscribeResource(subject: string): void {
    if (this.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket is not open, cannot unsubscribe from resource');

      return;
    }

    this.ws.send('UNSUBSCRIBE ' + subject);
  }

  /**
   * Subscribe to a drive and trigger a sync. Called when the drive changes
   * after the initial connection.
   */
  public subscribeDrive(drive: string): void {
    if (this.readyState !== WebSocket.OPEN) {
      return;
    }

    // Ensure we're authenticated before subscribing
    this.authenticate()
      .then(() => {
        const query = JSON.stringify({ drive });
        this.ws.send('SUBSCRIBE_QUERY ' + query);

        const clientDb = this.store.getClientDb();

        if (clientDb) {
          const syncKey = `sync_timestamp_${drive}`;
          const since =
            typeof localStorage !== 'undefined'
              ? localStorage.getItem(syncKey)
              : null;
          this.store.startDriveSync(drive);
          const syncRequest = since
            ? JSON.stringify({ drive, since: Number(since) })
            : JSON.stringify({ drive });
          this.ws.send('SYNC_DRIVE ' + syncRequest);
        }
      })
      .catch(e => {
        console.warn('[WS] Failed to subscribe to drive:', e);
      });
  }

  /** Start a VV-based sync for a drive. Falls back to legacy SYNC_DRIVE on error. */
  private async startVVSync(drive: string): Promise<void> {
    if (this.readyState !== WebSocket.OPEN) return;

    this.store.startDriveSync(drive);

    try {
      const syncState = await this.store.computeDriveSyncState(drive);
      this.ws.send('SYNC_VV ' + JSON.stringify(syncState));
    } catch (e) {
      console.warn('[WS] VV sync failed, falling back to legacy:', e);
      const syncKey = `sync_timestamp_${drive}`;
      const since =
        typeof localStorage !== 'undefined'
          ? localStorage.getItem(syncKey)
          : null;
      const syncRequest = since
        ? JSON.stringify({ drive, since: Number(since) })
        : JSON.stringify({ drive });
      this.ws.send('SYNC_DRIVE ' + syncRequest);
    }
  }

  public subscribeLoroSync(subject: string): void {
    if (this.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket is not open, cannot subscribe to LoroSync');

      return;
    }

    this.ws.send('LORO_SYNC_SUBSCRIBE ' + JSON.stringify({ subject }));
  }

  public unsubscribeLoroSync(subject: string): void {
    if (this.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket is not open, cannot unsubscribe from LoroSync');

      return;
    }

    this.ws.send('LORO_SYNC_UNSUBSCRIBE ' + JSON.stringify({ subject }));
  }

  public sendLoroSyncUpdate(message: string): void {
    if (this.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket is not open, cannot send LoroSync update');

      return;
    }

    this.ws.send('LORO_SYNC_UPDATE ' + message);
  }

  public sendLoroEphemeralUpdate(message: string): void {
    if (this.readyState !== WebSocket.OPEN) {
      console.warn(
        'WebSocket is not open, cannot send Loro ephemeral update',
      );

      return;
    }

    this.ws.send('LORO_EPHEMERAL_UPDATE ' + message);
  }

  /** Sends a GET message for some resource over websockets. */
  public async fetch(subject: string): Promise<Resource> {
    // If we are authenticating we do not want to fetch any resources yet.
    try {
      await this.authPromise;
    } catch (e) {
      // Authentication failed, continue as public agent.
    }

    const promise = this.waitForMessage('RESOURCE ', (ev: MessageEvent) => {
      for (const resource of parseResourceMessage(ev)) {
        if (resource.subject === subject) {
          return resource;
        }

        // Server sends error resources with the requested subject's URL as the
        // resource subject when a GET fails (e.g. resource not found / deleted).
        // Detect these and reject immediately rather than waiting for timeout.
        const isA: string[] = resource.get(
          'https://atomicdata.dev/properties/isA',
        ) as string[];

        if (
          Array.isArray(isA) &&
          isA.includes(classes.error) &&
          resource.subject === subject
        ) {
          const description =
            (resource.get(
              'https://atomicdata.dev/properties/description',
            ) as string) ?? 'Resource not found';
          throw new AtomicError(description, ErrorType.NotFound);
        }
      }

      return false;
    }).catch(e => {
      if (e instanceof AtomicError) {
        throw e;
      }

      throw new Error(
        `WS GET timed out for subject "${subject}" on ${this.ws.url}`,
        { cause: e },
      );
    });

    this.ws.send('GET ' + subject);

    return await promise;
  }

  private handleOpen() {
    // Make sure user is authenticated before sending any messages
    this.authenticate()
      .then(async () => {
        // Subscribe to all changes in the current drive
        const drive = this.store.getDrive();

        if (drive) {
          const query = JSON.stringify({ drive });
          this.ws.send('SUBSCRIBE_QUERY ' + query);

          // Defer VV sync slightly to allow initial resource fetches
          // to complete (WS GETs populate Loro state via merge).
          setTimeout(() => {
            this.startVVSync(drive);
          }, 500);
        }
      })
      .catch(e => {
        console.error('Error handling open:', e);
      });
  }

  private handleMessage(ev: MessageEvent) {
    if (ev.data.startsWith('COMMIT ')) {
      const commit = ev.data.slice(7);
      try {
        this.store.logIncomingCommit(parseCommitJSON(commit));
      } catch {
        // Keep runtime commit application resilient even if logging fails.
      }
      parseAndApplyCommit(commit, this.store);

      // Forward to WASM DB for efficient incremental index update (Loro diff path)
      const clientDb = this.store.getClientDb();

      if (clientDb) {
        clientDb.applyCommit(commit).catch(() => {
          // Non-critical — in-memory store is the source of truth
        });
      }
    } else if (ev.data.startsWith('ERROR ')) {
      this.store.notifyError(ev.data.slice(6));
    } else if (ev.data.startsWith('RESOURCE ')) {
      const resources = parseResourceMessage(ev);

      for (const r of Array.isArray(resources) ? resources : [resources]) {
        r.source = 'server-ws';
        r.sourceTimestamp = Date.now();
      }

      this.store.addResources(resources);
    } else if (ev.data.startsWith('LORO_SYNC_UPDATE ')) {
      const update = ev.data.slice(17);
      this.store.__handleLoroSyncMessage(update);
    } else if (ev.data.startsWith('LORO_EPHEMERAL_UPDATE ')) {
      const update = ev.data.slice(21);
      this.store.__handleLoroEphemeralMessage(update);
    } else if (ev.data.startsWith('QUERY_UPDATE ')) {
      const json = ev.data.slice(13);

      try {
        const update = JSON.parse(json);
        const subjects: string[] = [
          ...(update.added ?? []),
          ...(update.removed ?? []),
        ];

        // Refetch affected resources so the store/UI updates
        for (const subject of subjects) {
          this.store.fetchResourceFromServer(subject).catch(() => {
            // Resource might have been deleted, that's fine
          });
        }
      } catch (e) {
        console.warn('Invalid QUERY_UPDATE:', e);
      }
    } else if (ev.data.startsWith('SYNC_DONE ')) {
      const json = ev.data.slice(10);

      try {
        const done = JSON.parse(json);

        if (done.drive && done.timestamp && typeof localStorage !== 'undefined') {
          localStorage.setItem(
            `sync_timestamp_${done.drive}`,
            String(done.timestamp),
          );
        }

        this.store.finishDriveSync(
          done.drive,
          done.count ?? 0,
          done.timestamp ?? Date.now(),
        );

        console.info(
          `[Sync] Drive sync complete: ${done.count} resources for ${done.drive}`,
        );
      } catch (e) {
        console.warn('Invalid SYNC_DONE:', e);
      }
    } else if (ev.data.startsWith('SYNC_OK ')) {
      // Fast path: drive hashes match, nothing to sync
      const json = ev.data.slice(8);

      try {
        const msg = JSON.parse(json);
        console.info(`[Sync] Drive in sync: ${msg.drive}`);
        this.store.finishDriveSync(msg.drive, 0, Date.now());
      } catch (e) {
        console.warn('Invalid SYNC_OK:', e);
      }
    } else if (ev.data.startsWith('SYNC_DIFF ')) {
      // Slow path: server tells us what differs
      const json = ev.data.slice(10);

      try {
        const diff = JSON.parse(json);
        this.handleSyncDiff(diff);
      } catch (e) {
        console.warn('Invalid SYNC_DIFF:', e);
      }
    } else if (ev.data.startsWith('SYNC_DELTAS ')) {
      // Server pushing Loro deltas for server-ahead resources
      const json = ev.data.slice(12);

      try {
        const msg = JSON.parse(json);
        this.handleSyncDeltas(msg);
      } catch (e) {
        console.warn('Invalid SYNC_DELTAS:', e);
      }
    } else if (ev.data.startsWith('AUTHENTICATED')) {
      // Do nothing, handled by the authenticate() method
    } else {
      console.warn('Unknown websocket message:', ev);
    }
  }

  /**
   * Handle SYNC_DIFF: server tells us which resources need syncing.
   * - `pull`: subjects the server needs from us (client-ahead or unknown)
   * - `push`: subjects the server will send deltas for (server-ahead)
   */
  private async handleSyncDiff(diff: {
    drive: string;
    pull: string[];
    push: string[];
  }): Promise<void> {
    console.info(
      `[Sync] Diff for ${diff.drive}: pull ${diff.pull.length}, push ${diff.push.length}`,
    );

    // Send Loro snapshots/deltas for resources the server needs
    if (diff.pull.length > 0) {
      const deltas: Record<string, string> = {};
      const clientDb = this.store.getClientDb();

      for (const subject of diff.pull) {
        let snapshot: Uint8Array | null = null;

        // Try WASM DB first (persisted snapshots)
        if (clientDb) {
          snapshot = await clientDb.getLoroSnapshot(subject);
        }

        // Fall back to in-memory LoroDoc
        if (!snapshot) {
          const resource = this.store.resources.get(subject);
          const doc = resource?.getLoroDoc?.();

          if (doc) {
            snapshot = doc.export({ mode: 'snapshot' });
          }
        }

        if (snapshot && snapshot.length > 0) {
          const binary = Array.from(snapshot)
            .map(b => String.fromCharCode(b))
            .join('');
          deltas[subject] = btoa(binary);
        }
      }

      if (Object.keys(deltas).length > 0) {
        this.ws.send(
          'SYNC_DELTAS ' + JSON.stringify({ drive: diff.drive, deltas }),
        );
      }
    }

    // If there's nothing to push from server, finish the sync now.
    // Otherwise, finishDriveSync is called when SYNC_DELTAS arrives.
    if (diff.push.length === 0) {
      this.store.finishDriveSync(diff.drive, diff.pull.length, Date.now());
    }
  }

  /**
   * Handle SYNC_DELTAS: import Loro deltas from the server into local resources.
   */
  private async handleSyncDeltas(msg: {
    drive: string;
    deltas: Record<string, string>;
  }): Promise<void> {
    const clientDb = this.store.getClientDb();
    let count = 0;

    for (const [subject, deltaB64] of Object.entries(msg.deltas)) {
      try {
        // Decode base64 to Uint8Array
        const binary = atob(deltaB64);
        const bytes = new Uint8Array(binary.length);

        for (let i = 0; i < binary.length; i++)
          bytes[i] = binary.charCodeAt(i);

        // Get or create the resource
        let resource = this.store.resources.get(subject);

        if (resource) {
          // Import delta into existing Loro doc
          resource.importLoroUpdate(bytes);
        } else {
          // New resource from server - create and import
          const { Resource } = await import('./resource.js');
          resource = new Resource(subject);
          resource.importLoroUpdate(bytes);
          resource.loading = false;
          resource.source = 'server-ws';
          resource.sourceTimestamp = Date.now();
        }

        this.store.addResources(resource, { skipCommitCompare: true });

        // Persist updated snapshot to WASM DB
        if (clientDb) {
          const doc = resource.getLoroDoc?.();

          if (doc) {
            const snapshot = doc.export({ mode: 'snapshot' });
            clientDb
              .putLoroSnapshot(subject, snapshot)
              .catch(() => {});
          }
        }

        count++;
      } catch (e) {
        console.warn(`[Sync] Failed to import delta for ${subject}:`, e);
      }
    }

    console.info(
      `[Sync] Imported ${count} deltas for ${msg.drive}`,
    );
    this.store.finishDriveSync(msg.drive, count, Date.now());
  }

  private waitForMessage(message: string): Promise<void>;
  private waitForMessage<T>(
    message: string,
    condition: (ev: MessageEvent) => T | false,
  ): Promise<T>;
  private waitForMessage<T>(
    message: string,
    condition?: (ev: MessageEvent) => T | false,
  ): Promise<T | void> {
    return new Promise((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;

      const listener = (ev: MessageEvent) => {
        if (!ev.data.startsWith(message)) {
          return;
        }

        if (!condition) {
          clearTimeout(timeoutId);
          this.ws.removeEventListener('message', listener);

          return resolve();
        }

        let result = condition(ev);

        if (result !== false) {
          clearTimeout(timeoutId);
          this.ws.removeEventListener('message', listener);
          resolve(result);
        }
      };

      timeoutId = setTimeout(() => {
        this.ws.removeEventListener('message', listener);
        reject(
          new Error(
            `WS Request with message '${message}' timed out after ${REQUEST_TIMEOUT}ms. on ${this.ws.url}, message: ${message}`,
          ),
        );
      }, REQUEST_TIMEOUT);

      this.ws.addEventListener('message', listener);
    });
  }
}
