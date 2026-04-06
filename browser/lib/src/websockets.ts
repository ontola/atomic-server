import { createAuthentication } from './authentication.js';
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
      ws.addEventListener('message', this.handleMessage);
      ws.addEventListener('error', e => {
        if (!this.retryingOldVersion) {
          this.retryingOldVersion = true;
          createSocket();

          return;
        }

        return console.error('websocket error:', e);
      });
      this.openPromise = new Promise(resolve => {
        ws.addEventListener('open', () => {
          resolve();
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
      recordServerVersionFromWsProtocol(this.version, this.serverOrigin);

      if (shouldSkipDidAuthForLegacyServer(this.ws.url, agent.subject)) {
        warnDidAuthCompatibility(this.ws.url);
        releaseGate();

        return;
      }

      await this.openPromise;

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

  public subscribeResource(subject: string): void {
    if (this.readyState !== WebSocket.OPEN) {
      return;
    }

    if (subject.startsWith('did:ad:commit:')) {
      return;
    }

    try {
      const url = new URL(subject);

      // For HTTP(S) URLs, check origin matches and it's not an immutable commit
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        if (
          url.origin !== this.serverOrigin ||
          url.pathname.startsWith('/commits/')
        ) {
          return;
        }
      }
    } catch {
      // DID subjects are not valid URLs but should still be subscribed to
      // (immutable did:ad:commit: subjects are already filtered above)
      if (!subject.startsWith('did:')) {
        return;
      }
    }

    this.authPromise
      .catch(() => {
        // We don't want to log the error here, as it's already handled in the authenticate() method
      })
      .finally(() => {
        this.ws.send('SUBSCRIBE ' + subject);
      });
  }

  public unsubscribeResource(subject: string): void {
    if (this.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket is not open, cannot unsubscribe from resource');

      return;
    }

    this.ws.send('UNSUBSCRIBE ' + subject);
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
      .then(() => {
        // Subscribe to all existing subjects (subscribeResource filters commits and external origins)
        for (const subject of this.store.subscribers.keys()) {
          this.subscribeResource(subject);
        }
      })
      .catch(e => {
        console.error('Error handling open:', e);
      });
  }

  private handleMessage(ev: MessageEvent) {
    if (ev.data.startsWith('COMMIT ')) {
      const commit = ev.data.slice(7);
      parseAndApplyCommit(commit, this.store);
    } else if (ev.data.startsWith('ERROR ')) {
      this.store.notifyError(ev.data.slice(6));
    } else if (ev.data.startsWith('RESOURCE ')) {
      const resources = parseResourceMessage(ev);
      this.store.addResources(resources);
    } else if (ev.data.startsWith('LORO_SYNC_UPDATE ')) {
      const update = ev.data.slice(17);
      this.store.__handleLoroSyncMessage(update);
    } else if (ev.data.startsWith('LORO_EPHEMERAL_UPDATE ')) {
      const update = ev.data.slice(21);
      this.store.__handleLoroEphemeralMessage(update);
    } else if (ev.data.startsWith('AUTHENTICATED')) {
      // Do nothing, handled by the authenticate() method
    } else {
      console.warn('Unknown websocket message:', ev);
    }
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
