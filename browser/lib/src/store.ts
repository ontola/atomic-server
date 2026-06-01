import { ulid } from 'ulidx';
import type { Agent } from './agent.js';
import {
  removeCookieAuthentication,
  setCookieAuthentication,
} from './authentication.js';
import { Client, type FileOrFileLike } from './client.js';
import {
  CommitBuilder,
  commitIdOf,
  commitToJsonADObject,
  type Commit,
} from './commit.js';
import { datatypeFromUrl, type Datatype } from './datatypes.js';
import { EventManager } from './EventManager.js';
import { hasBrowserAPI } from './hasBrowserAPI.js';
import { collections } from './ontologies/collections.js';
import { commits } from './ontologies/commits.js';
import { core } from './ontologies/core.js';
import { server, type Server } from './ontologies/server.js';
import type { OptionalClass, UnknownClass } from './ontology.js';
import { JSONADParser } from './parse.js';
import { Resource, unknownSubject } from './resource.js';
import { type SearchOpts, buildSearchSubject } from './search.js';
import { stringToSlug } from './stringToSlug.js';
import { bytesToHex, hexToBytes, type JSONValue } from './value.js';
import { WSClient } from './websockets.js';
import { BLOB, endpoints, INTERNAL_ID } from './urls.js';
import { initOntologies } from './ontologies/index.js';
import { decodeB64, encodeB64 } from './base64.js';
import type {
  ClientDbWorker,
  ClientDbQueryOpts,
  ClientDbQueryResult,
} from './client-db.js';
import { LocalSearch } from './local-search.js';
import { perfMark, perfSpan } from './perf-trace.js';
import {
  LocalOutbox,
  isTerminalCommitErrorMessage,
  type OutboxEntry,
} from './local-outbox.js';

/** Function called when a resource is updated or removed */
type ResourceCallback<C extends OptionalClass = UnknownClass> = (
  resource: Resource<C>,
) => void;
/** Callback for Loro CRDT document sync updates */
type LoroSyncCallback = (update: Uint8Array) => void;
/** Callback for Loro ephemeral updates (cursors, presence) */
type LoroEphemeralCallback = (update: Uint8Array) => void;
type SubjectCallback = (subject: string) => void;
/** Callback called when the stores agent changes */
type AgentCallback = (agent: Agent | undefined) => void;
type ErrorCallback = (e: Error) => void;
type ConnectionStateCallback = (connected: boolean) => void;
type SyncStatusCallback = (status: StoreSyncStatus) => void;
type CommitLogCallback = (entries: CommitLogEntry[]) => void;

type ServerURLCallback = (serverURL: string) => void;
type DriveCallback = (drive: string) => void;
type Fetch = typeof fetch;

type CreateResourceOptions = {
  /** Optional subject of the new resource, if not given the store will generate a random subject */
  subject?: string;
  /** Parent the subject belongs to, defaults to the serverUrl */
  parent?: string;
  /** Set to true if the resource should not have a parent. (For example Drives don't have parents) */
  noParent?: boolean;
  /** Subject(s) of the resources class */
  isA?: string | string[];
  /** Any additional properties the resource should have */
  propVals?: Record<string, JSONValue>;
  /** Set to true if the resource should have a DID as subject. Defaults to `true` for `did:ad` agents, otherwise `false`. */
  did?: boolean;
};

export interface StoreOpts {
  /** The default store URL, where to send commits and where to create new instances */
  serverUrl?: string;
  /** Default Agent, used for signing commits. Is required for posting things. */
  agent?: Agent;
}

export interface StoreSyncStatus {
  serverConnected: boolean;
  /** Last WebSocket/server connection error, if the server is currently offline. */
  serverConnectionError?: string;
  /** True iff EITHER the WS-driven drive sync is mid-handshake OR
   * the outbox is currently draining. */
  syncInProgress: boolean;
  pendingDirtyCount: number;
  serverUrl: string;
  /** `undefined` when no drive has been selected (cold open before
   *  `setDrive`). Callers must handle the absent case rather than
   *  treat the server URL as a stand-in drive — a bare host URL is
   *  not a real drive subject. */
  drive: string | undefined;
  clientDbReady: boolean;
  /** True if a ClientDb was attached to the store (regardless of readiness). */
  clientDbAttached: boolean;
  /** Message of the error that prevented ClientDb init, if init has failed. */
  clientDbError?: string;
  lastDriveSync?: {
    drive: string;
    count: number;
    timestamp: number;
  };
}

/** Compact representation of all Loro version vectors in a drive, for sync comparison. */
export interface DriveSyncState {
  drive: string;
  driveHash: string;
  /** Unique peer IDs across all resources, sorted. Counter arrays are indexed by this. */
  peers: string[];
  /** subject → counter array (indexed by `peers`). */
  resources: Record<string, number[]>;
}

export interface CommitLogPropertySummary {
  property: string;
  value: JSONValue;
  /**
   * `changed` — value differs from the prior commit (or this is the first
   * commit we've logged for the subject).
   * `removed` — present in the prior commit but absent now.
   */
  changeType: 'changed' | 'removed';
}

export interface CommitLogEntry {
  id: string;
  timestamp: number;
  direction: 'outgoing' | 'incoming';
  /**
   * - `pending`  — locally signed, queued, not yet posted to the server.
   * - `sent`     — server accepted the commit.
   * - `failed`   — server rejected, or the network call threw.
   * - `received` — incoming commit pushed to us by the server.
   */
  status: 'pending' | 'sent' | 'failed' | 'received';
  subject: string;
  signer?: string;
  previousCommit?: string;
  commitId?: string;
  hasLoroUpdate: boolean;
  destroy: boolean;
  summary: string;
  propertySummaries?: CommitLogPropertySummary[];
  error?: string;
}

/** These Events trigger certain Handlers */
export enum StoreEvents {
  /**
   * Whenever `Resource.save()` is called, so only when the user of this library
   * performs a save action.
   */
  ResourceSaved = 'resource-saved',
  /** User perform a Remove action */
  ResourceRemoved = 'resource-removed',
  /**
   * User explicitly created a Resource through a conscious action, e.g. through
   * the SideBar.
   */
  ResourceManuallyCreated = 'resource-manually-created',
  /** Event that gets called whenever the stores agent changes */
  AgentChanged = 'agent-changed',
  /** Event that gets called whenever the server url changes */
  ServerURLChanged = 'server-url-changed',
  /** Event that gets called whenever the drive changes */
  DriveChanged = 'drive-changed',
  /** Event that gets called whenever the websocket/server connection changes */
  ConnectionChanged = 'connection-changed',
  /** Event that gets called whenever sync/debug status changes */
  SyncStatusChanged = 'sync-status-changed',
  CommitLogChanged = 'commit-log-changed',
  /**
   * Fires every time a resource is added, merged, or replaced in the store —
   * for both local commits and remote `UPDATE` pushes. This is the single
   * signal that drives live collection membership: a `useCollection` listener
   * checks if the changed resource matches its filter and updates the cached
   * page in place, so a remote chat message no longer triggers a `/query`
   * refetch storm across every visible collection.
   */
  ResourceUpdated = 'resource-updated',
  /** Event that gets called whenever the store encounters an error */
  Error = 'error',
}

export interface ImportJsonADOptions {
  /** Where the resources will be imported to  */
  parent: string;
  /** Danger: Replaces Resources with matching subjects, even if they are not Children of the specified Parent. */
  overwriteOutside?: boolean;
}

export interface AddResourcesOpts {
  /** If true, the resource will not be compared to the existing resource in the store. This is useful when you want to force an update. */
  skipCommitCompare?: boolean;
  /** If the resource was fetched via an alias, we should record that alias. */
  alias?: string;
}

/**
 * Handlers are functions that are called when a certain event occurs.
 */
type StoreEventHandlers = {
  [StoreEvents.ResourceSaved]: ResourceCallback;
  [StoreEvents.ResourceRemoved]: SubjectCallback;
  [StoreEvents.ResourceManuallyCreated]: ResourceCallback;
  [StoreEvents.AgentChanged]: AgentCallback;
  [StoreEvents.ServerURLChanged]: ServerURLCallback;
  [StoreEvents.DriveChanged]: DriveCallback;
  [StoreEvents.ConnectionChanged]: ConnectionStateCallback;
  [StoreEvents.SyncStatusChanged]: SyncStatusCallback;
  [StoreEvents.CommitLogChanged]: CommitLogCallback;
  [StoreEvents.ResourceUpdated]: ResourceCallback;
  [StoreEvents.Error]: ErrorCallback;
};

export interface ResourceTreeTemplate {
  [property: string]: true | ResourceTreeTemplate;
}

/** Ingress source for {@link IncomingChange}. One enum for every
 * code path that produces resource state. */
export type ChangeSource =
  | 'ws-pending-get'
  | 'ws-sub-push'
  | 'ws-sync-push'
  | 'ws-query-update'
  | 'http-fetch'
  | 'local-pre-push'
  | 'local-acked'
  | 'local-post'
  | 'offline-replay';

/** One authoritative-or-local resource update. Either `loroBytes`
 * (WS paths) or `resource` (HTTP/local/offline) must be set. */
export interface IncomingChange {
  subject: string;
  loroBytes?: Uint8Array;
  resource?: Resource;
  /** `did:ad:commit:<sig>` — used for echo dedup on the loroBytes path. */
  commitId?: string;
  source: ChangeSource;
  receivedAt?: number;
  forceNotify?: boolean;
}

/** Returns True if the client has WebSocket support */
const supportsWebSockets = () => typeof WebSocket !== 'undefined';

/** Yield control back to the event loop so pending render/input tasks can run.
 *  Uses a MessageChannel (macrotask without the ~4ms `setTimeout` clamp). */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => {
    if (typeof MessageChannel !== 'undefined') {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => resolve();
      port2.postMessage(undefined);
    } else {
      setTimeout(resolve, 0);
    }
  });
}


/**
 * Cheap equality for commit-log property values. Strict `===` would always
 * report arrays/objects as different even when their contents match, so the
 * commit log would treat untouched array properties (e.g. `isA`) as
 * "changed" on every commit. JSON-stringifying for the few rich values is a
 * bounded cost — propvals are tiny and we only do this on log entry build.
 */
function commitLogValuesEqual(
  a: unknown | undefined,
  b: unknown | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * An in memory store that has a bunch of usefful methods for retrieving Atomic
 * Data Resources. It is also resposible for keeping the Resources in sync with
 * Subscribers (components that use the Resource), and for managing the current
 * Agent (User).
 */
export class Store {
  /** A list of all functions that need to be called when a certain resource is updated */
  public subscribers: Map<string, ResourceCallback[]>;
  private loroSyncSubscribers: Map<string, LoroSyncCallback[]> = new Map();
  private loroEphemeralSubscribers: Map<string, LoroEphemeralCallback[]> =
    new Map();
  private injectedFetch: Fetch;
  /** The base URL of an Atomic Server. Where commits, search, and
   *  new-instance requests are sent. */
  private serverUrl: string;
  /** The current Drive subject (DID or HTTP URL). `undefined` until
   *  `setDrive` is called — there is no implicit fallback to the
   *  server URL: a host URL is not a real drive subject and treating
   *  it as one made drive-scoped paths (SYNC_VV, `encodeSub`,
   *  collection filters) walk or subscribe to nothing. */
  private drive: string | undefined;
  /** All the resources of the store */
  private _resources: Map<string, Resource>;
  /** Mapping from HTTP aliases to primary subjects (e.g. DIDs) */
  private aliases: Map<string, string> = new Map();

  /** List of resources that have parents that are not saved to the server, when a parent is saved it should also save its children */
  private batchedResources: Map<string, Set<string>> = new Map();

  /** Subject → in-flight `fetchResourceFromServer` promise. Two parallel
   *  `useResource(X)` calls that both miss the cache share one network
   *  round-trip instead of each firing their own. Cleared in `finally`
   *  so subsequent calls (e.g. a forced refresh after a known change)
   *  can re-fetch. Keyed by normalized subject. */
  private _inFlightFetches: Map<string, Promise<Resource>> = new Map();

  /** Current Agent, used for signing commits. Is required for posting things. */
  private agent?: Agent;
  /** Mapped from origin to websocket */
  private webSockets: Map<string, WSClient>;

  /** Optional WASM-backed client-side database running in a Web Worker. */
  private clientDb?: ClientDbWorker;
  /** Client-side full-text search index (MiniSearch). */
  private localSearch = new LocalSearch();
  /**
   * Single durable queue replacing the old `dirtyForSync` Set +
   * `atomic.dirtyForSync` + `atomic.offline.<subject>` quartet.
   * Constructor callback re-emits `SyncStatusChanged` so subscribers
   * see queue-size changes without a manual `markDirtyForSync` call.
   */
  public readonly outbox: LocalOutbox = new LocalOutbox(() => {
    this.emitSyncStatus();
    this.scheduleOutboxDrain();
  });
  private outboxDrainTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Macrotask-debounced auto-drain. Every local Loro op (`set`,
   * `loroSetProperty`, etc.) marks the subject dirty via
   * `outbox.markDirty`; we schedule a drain on the NEXT macrotask
   * so a burst of `set()` calls in one logical save boundary
   * coalesces into one drain pass.
   *
   * Why setTimeout and not queueMicrotask: microtasks run between
   * every `await` point, which means `await resource.set('a'); await
   * resource.set('b')` would drain after `a` (splitting the save
   * into two commits). setTimeout(0) defers past all current sync
   * + microtask work to the next macrotask cycle.
   *
   * Post-drain re-check: if entries remain after the drain completes
   * (typing during the `await postCommit` round-trip leaves the
   * subject dirty — see `hasOpsPastSaveCursor` in
   * `drainOutboxSubject`), schedule another drain so the new ops
   * land instead of stranding until the next user keystroke.
   */
  private scheduleOutboxDrain(): void {
    if (this.outboxDrainTimer) return;
    if (!this._serverConnected) return;
    if (this.outbox.size === 0) return;
    if (!this.getAgent()) return;
    this.outboxDrainTimer = setTimeout(() => {
      this.outboxDrainTimer = undefined;
      if (!this._serverConnected) return;
      void this.syncDirtyResources().catch(() => undefined);
    }, 0);
  }
  /**
   * Whether the Store has an active connection to the server.
   * Driven by WebSocket open/close events. When false, commits are stored
   * locally and synced when the connection is restored.
   */
  private _serverConnected = false;
  private _serverConnectionError: string | undefined;
  private _driveSyncInProgress = false;
  private _lastDriveSync?: {
    drive: string;
    count: number;
    timestamp: number;
  };
  private _commitLog: CommitLogEntry[] = [];
  /**
   * Per-subject prior Loro snapshot bytes, used by `summarizeCommitProperties`
   * to diff against the new commit so the Sync page's commit log shows ONLY
   * the properties this commit changed (rather than every property that
   * happens to be present in the snapshot — `loroUpdate` is full state, not a
   * delta, so without this tracking every entry looks identical regardless of
   * what the user actually changed).
   */
  private _commitLogPriorSnapshots = new Map<string, Uint8Array>();

  private eventManager = new EventManager<StoreEvents, StoreEventHandlers>();

  /**
   * Subjects that were just manually created via {@link notifyResourceManuallyCreated},
   * keyed to the timestamp of the notification. Late `useEffect` subscribers
   * miss the fire-and-forget event when navigation completes faster than the
   * new component mounts; they read this map via {@link consumeRecentlyCreated}
   * to learn the resource is fresh.
   */
  private recentlyCreatedSubjects: Map<string, number> = new Map();

  private client: Client;

  public constructor(opts: StoreOpts = {}) {
    initOntologies();
    this._resources = new Map();
    this.webSockets = new Map();
    this.subscribers = new Map();

    if (opts.serverUrl) this.setServerUrl(opts.serverUrl);
    if (opts.agent) this.setAgent(opts.agent);

    // Initialize drive from localStorage if available.
    // No fallback to `serverUrl`: a bare host URL is not a real drive
    // subject — it carries no resources of its own, and the server's
    // `SYNC_VV` handler used to walk every `Tree::Resources` row
    // trying to enumerate "what's in" that pseudo-drive (the non-DID
    // branch in `lib/src/sync/engine.rs::collect_drive_subjects`).
    // `undefined` = no drive selected; the WS `handleOpen` skips
    // `startVVSync` when this is `undefined`, leaving the per-conn
    // actor free for the GET that almost always follows on share-
    // link / welcome-page cold opens.
    //
    // A stored value that happens to be an HTTP URL (legacy data from
    // pre-DID drives) is also ignored here for drive purposes —
    // `setServerUrl` above already absorbed the origin, and an
    // accidental URL-as-drive is exactly what we're avoiding.
    let storedDrive: string | undefined = undefined;

    if (typeof window !== 'undefined') {
      const raw = localStorage.getItem('drive');

      if (raw) {
        try {
          storedDrive = JSON.parse(raw);
        } catch {
          // ignore corrupt value
        }
      }
    }

    if (
      storedDrive &&
      !storedDrive.startsWith('http://') &&
      !storedDrive.startsWith('https://')
    ) {
      this.drive = storedDrive;
    } else {
      this.drive = undefined;
    }

    this.client = new Client(this.injectedFetch);

    // Rehydrate the commit log from the outbox so the Sync page
    // shows what's queued instead of "No activity recorded" after
    // a reload. The outbox itself is already populated by its
    // constructor — that handles both the new `atomic.outbox` key
    // and the one-shot migration from the legacy
    // `atomic.dirtyForSync` + `atomic.offline.<subject>` shape.
    for (const entry of this.outbox.pending()) {
      this.hydrateCommitLogFromOutbox(entry);
    }

    // We need to bind this method because it is passed down by other functions
    this.getAgent = this.getAgent.bind(this);
    this.setAgent = this.setAgent.bind(this);
  }

  /** All the resources of the store */
  public get resources(): Map<string, Resource> {
    return this._resources;
  }

  /** Inject a custom fetch implementation to use when fetching resources over http */
  public injectFetch(fetchOverride: Fetch) {
    this.injectedFetch = fetchOverride;
    this.client.setFetch(fetchOverride);
  }

  /**
   * Set a ClientDbWorker for local indexed queries and resource caching.
   * The worker runs the WASM ClientDb in a background thread.
   * Call this after constructing the Store — the worker initializes lazily.
   */
  public setClientDb(clientDb: ClientDbWorker): void {
    // `initClientDb` calls this three times per page load (eager,
    // post-init, post-init-error) to refresh sync status. Only the
    // first call introduces a new worker; the others just want
    // `emitSyncStatus`. Rehydrate is expensive (walks the whole
    // OPFS-backed corpus and indexes each entry into MiniSearch),
    // so gate it on the worker actually changing.
    const isNew = this.clientDb !== clientDb;
    this.clientDb = clientDb;
    this.emitSyncStatus();

    if (!isNew) return;

    // NB: the in-memory `LocalSearch` (MiniSearch) index is NOT eagerly rebuilt
    // here. The local index is only ever consulted OFFLINE — online searches go
    // to the server's Tantivy index — so rebuilding it on every load was ~2s of
    // wasted work (export all of OPFS + index every drive) for a path the
    // common online session never uses. Instead the per-drive index is built
    // lazily, scoped to the current drive, the first time an offline search
    // needs it: see `ensureDriveIndexed`, called from `search()`.
  }

  /**
   * The drive a resource belongs to — the root of its `parent` chain,
   * resolved against the in-memory store. Used to partition the local
   * search index per drive.
   */
  private driveOf(subject: string): string {
    let current = subject;
    const seen = new Set<string>();

    for (let i = 0; i < 64; i++) {
      if (seen.has(current)) break;

      seen.add(current);
      const parent = this.resources.get(current)?.get(core.properties.parent);

      if (typeof parent !== 'string' || !parent || parent === current) {
        return current;
      }

      current = parent;
    }

    return current;
  }

  /** Drives whose full local search index has been built (or is being built)
   *  from OPFS — keyed to dedupe concurrent/repeat builds. */
  private driveIndexBuilds = new Map<string, Promise<void>>();

  /**
   * Lazily build the in-memory `LocalSearch` (MiniSearch) index for ONE drive
   * from the persistent ClientDb.
   *
   * The local index is only ever consulted offline (online searches hit the
   * server's Tantivy index), so rather than rebuilding every drive's index on
   * every page load, we build a drive's index on demand — the first time an
   * offline search needs it (see `search()`). Deduped per drive; safe to call
   * repeatedly.
   */
  public ensureDriveIndexed(drive: string): Promise<void> {
    if (!drive) {
      return Promise.resolve();
    }

    const existing = this.driveIndexBuilds.get(drive);

    if (existing) {
      return existing;
    }

    const build = this.buildDriveIndex(drive);
    this.driveIndexBuilds.set(drive, build);

    return build;
  }

  private async buildDriveInstilldex(drive: string): Promise<void> {
    const clientDb = this.clientDb;

    if (!clientDb) {
      this.driveIndexBuilds.delete(drive);

      return;
    }

    try {
      const ready = await clientDb.waitForReady();

      if (!ready) {
        // Let a later call retry.
        this.driveIndexBuilds.delete(drive);

        return;
      }

      // TODO: a drive-scoped worker query would avoid pulling other drives'
      // bytes across the boundary. For now export all and filter by drive —
      // this runs at most once per drive per session (on first offline search),
      // not on every load.
      const endExport = perfSpan('clientdb.exportAllResources', { drive });
      const exported = await clientDb.exportAllResources();
      endExport({ bytes: exported.length });
      const parsed = JSON.parse(exported);

      if (!Array.isArray(parsed)) {
        return;
      }

      // subject→parent map over the whole export so `driveOf` resolves even
      // for ancestors not in the in-memory store yet.
      const parentOf = new Map<string, string>();

      for (const obj of parsed) {
        const subject = obj?.['@id'];
        const parent = obj?.[core.properties.parent];

        if (typeof subject === 'string' && typeof parent === 'string') {
          parentOf.set(subject, parent);
        }
      }

      const driveOf = (subject: string): string => {
        let current = subject;
        const seen = new Set<string>();

        for (let i = 0; i < 64; i++) {
          if (seen.has(current)) break;

          seen.add(current);
          const parent = parentOf.get(current);

          if (!parent || parent === current) {
            return current;
          }

          current = parent;
        }

        return current;
      };

      const endIndex = perfSpan('clientdb.buildDriveIndex', { drive });
      let indexed = 0;
      let sinceYield = 0;

      for (const obj of parsed) {
        const subject = obj?.['@id'];

        if (typeof subject !== 'string') {
          continue;
        }

        // Scope to the requested drive — don't index other cached drives.
        if (driveOf(subject) !== drive) {
          continue;
        }

        // Don't clobber a fresher entry already added via the live ingest
        // path: the OPFS copy can lag a very recent edit (e.g. a rename whose
        // commit hasn't persisted yet), and `addResource` replaces by id.
        if (this.localSearch.hasResource(subject, drive)) {
          continue;
        }

        const resource = new Resource(subject);
        resource.applyHydratedValues(
          Object.entries(obj).filter(([key]) => key !== '@id') as [
            string,
            JSONValue,
          ][],
        );
        resource.loading = false;
        // `addResource` is dedup-safe, so overlap with resources already
        // indexed via the normal ingest path is harmless.
        this.localSearch.addResource(resource, drive);
        indexed++;

        // Yield periodically so a large drive's index build doesn't freeze the
        // main thread / block input.
        if (++sinceYield >= 1000) {
          sinceYield = 0;
          await yieldToEventLoop();
        }
      }

      endIndex({ indexed });
      console.debug(
        `[search] drive index built — drive=${drive} indexed=${indexed}`,
      );
    } catch (e) {
      console.warn('[search] drive index build FAILED:', e);
      // Allow a retry on the next search.
      this.driveIndexBuilds.delete(drive);
    }
  }

  /** Returns the ClientDbWorker if one has been set (may still be initializing). */
  public getClientDb(): ClientDbWorker | undefined {
    return this.clientDb;
  }

  public getCommitLog(): CommitLogEntry[] {
    return [...this._commitLog];
  }

  /**
   * Surface a hydrated outbox entry in `_commitLog` as a `pending` row
   * so the Sync page shows what's queued after a reload, not
   * "No activity recorded". Under sign-at-drain the outbox doesn't
   * hold a signed envelope (except for `signedGenesis`); the pending
   * row just records "this subject has unsynced edits."
   */
  private hydrateCommitLogFromOutbox(entry: OutboxEntry): void {
    if (entry.signedGenesis) {
      const commit = entry.signedGenesis;
      this.pushCommitLog({
        timestamp: Date.now(),
        direction: 'outgoing',
        status: 'pending',
        subject: commit.subject,
        signer: commit.signer,
        previousCommit: commit.previousCommit,
        commitId: commit.signature
          ? `did:ad:commit:${commit.signature}`
          : undefined,
        hasLoroUpdate: !!commit.loroUpdate,
        destroy: !!commit.destroy,
        summary: this.summarizeCommit(commit),
        propertySummaries: this.summarizeCommitProperties(commit),
      });
    } else {
      this.pushCommitLog({
        timestamp: entry.enqueuedAt,
        direction: 'outgoing',
        status: 'pending',
        subject: entry.subject,
        destroy: false,
        hasLoroUpdate: true,
        summary: '(unsynced Loro edits)',
      });
    }
  }

  /**
   * Sync all queued writes to the server. Delegates to
   * {@link LocalOutbox.drain} which owns idempotency (concurrent
   * calls share the in-flight promise — the structural version of
   * the `5c168355` re-entrance fix).
   *
   * For each entry the outbox calls back here via
   * {@link postOutboxEntry} which uses the Resource's existing
   * `pushCommits` / `save` flow.
   */
  public async syncDirtyResources(): Promise<void> {
    if (this.outbox.size === 0 || !this.getAgent()) return;
    perfMark('store.syncDirtyResources.subjects', { count: this.outbox.size });
    this.emitSyncStatus();

    try {
      await this.outbox.drain({
        sort: this.sortOutboxEntries,
        drainSubject: this.drainOutboxSubject,
        isTerminalError: (_entry, e) => {
          const msg = e instanceof Error ? e.message : String(e);

          return isTerminalCommitErrorMessage(msg);
        },
        onTerminalDrop: (entry, e) => {
          const msg = e instanceof Error ? e.message : String(e);
          // Surface the recovery to the user — silent discards are
          // worse than visible recoveries when a write got lost.
          this.notifyError(
            new Error(
              `Dropped stuck commit for ${entry.subject.slice(0, 60)}…: ${msg}`,
            ),
          );
          // Best-effort: refetch the resource so the local copy
          // aligns with whatever the server already has.
          this.fetchResourceFromServer(entry.subject).catch(() => undefined);
        },
      });
    } finally {
      this.emitSyncStatus();
    }
  }

  /**
   * Outbox sort order: agents → current drive → everything else,
   * with shallow-parent before deep within the last tier. Agents
   * must exist on the server before their commits validate; the
   * drive must exist before its children's `parent` references
   * resolve.
   */
  private sortOutboxEntries = (
    entries: readonly OutboxEntry[],
  ): OutboxEntry[] => {
    const priority = (subject: string): number => {
      if (subject.startsWith('did:ad:agent:')) return 0;
      if (subject === this.drive) return 1;

      return 2;
    };

    const depth = (subject: string): number => {
      let d = 0;
      let current = subject;

      while (d < 20) {
        const r = this.resources.get(current);
        if (!r) break;
        const parent = r.get(core.properties.parent) as string | undefined;
        if (!parent || parent === current) break;
        d++;
        current = parent;
      }

      return d;
    };

    return [...entries].sort((a, b) => {
      const pa = priority(a.subject);
      const pb = priority(b.subject);
      if (pa !== pb) return pa - pb;

      return depth(a.subject) - depth(b.subject);
    });
  };

  /**
   * Drain one subject's outbox entry under sign-at-drain. Steps:
   *
   *  1. If a `signedGenesis` envelope is queued (DID-derived subject
   *     whose POST hadn't acked yet), POST it. Server idempotently
   *     applies. On success: clear genesis, run the wasNew pipeline
   *     (subscribeWebSocket + saveBatchForParent), advance the Loro
   *     save cursor on the resource so subsequent delta exports start
   *     from this version.
   *  2. If the subject has accumulated local Loro ops (`markDirty` was
   *     called since the last successful drain), export the delta,
   *     sign ONE commit chained on `resource.lastCommit`, POST. On
   *     success: clear dirty, `setLastCommitValue`, advance cursor.
   *
   *  Resource must be loaded in the store; cold drains for unloaded
   *  subjects fall through to a `fetchResourceFromServer` that
   *  rehydrates the Loro state before signing. (If both fail, the
   *  entry stays dirty and the next drain trigger retries.)
   *
   *  Re-posting a server-applied commit is safe thanks to idempotent
   *  replay accept (`commit-retention-and-state-certificates.md`
   *  Phase 1).
   */
  private drainOutboxSubject = async (subject: string): Promise<void> => {
    let entry = this.outbox.getEntry(subject);
    if (!entry) return;

    // A `_new:` subject has no derived DID yet — it must be sign-genesis'd
    // (which renames it to `did:ad:<sig>`) before it can be POSTed.
    // Reaching the drain with one is a bug in the save path: the server
    // rejects `subject: "_new:…"` with a 500 ("Unable to parse string as
    // URL") and the failed POST reschedules the drain, storming the server
    // forever. Drop the stray dirty bit rather than retry an un-POSTable
    // commit. The genesis derivation happens in `_saveInner`/`newResource`.
    if (subject.startsWith('_new:')) {
      this.outbox.clearGenesis(subject);
      this.outbox.clearDirty(subject);
      this.emitSyncStatus();

      return;
    }

    const endpoint = new URL('/commit', this.serverUrl).toString();

    // Step 1: POST the pre-signed genesis if present. The genesis
    // commit's `loroUpdate` was captured in `signChanges` at sign
    // time; `_loroVersionAtLastSave` was advanced THERE to the same
    // version. So we do NOT advance the cursor again here — doing so
    // would silently drop any ops the user typed between
    // `setGenesisCommit` and this drain pass (they're past the
    // genesis's captured version but would be marked "saved" by an
    // overzealous `markLoroSaved()`). Step 2 below picks those up.
    if (entry.signedGenesis) {
      const genesis = entry.signedGenesis;
      const created = await this.postCommit(genesis, endpoint);
      const commitId = commitIdOf(created);
      const resource = this.resources.get(subject);

      if (resource && commitId) {
        resource.setLastCommitValue(commitId);
        resource.applyToStore('local-acked', { commitId });
        resource.markSynced();
        await this.maybePushBlobForResource(resource).catch(() => undefined);
        // wasNew pipeline — first-time subscribe + save batched children
        this.subscribeWebSocket(subject);
        await this.saveBatchForParent(subject);
        // The genesis POST IS a save — fire `ResourceSaved` so listeners
        // waiting on first persistence run. The FilePicker, for example,
        // can't upload a file until its parent resource exists on the
        // server, so it sets `https://placeholder` and schedules the real
        // upload on `ResourceSaved`. When a resource is created via genesis
        // alone (no follow-up Loro delta), step 2 below short-circuits and
        // never notifies — so without this the scheduled upload never runs
        // and the placeholder is left dangling.
        this.notifyResourceSaved(resource);
      }

      this.outbox.clearGenesis(subject);
      entry = this.outbox.getEntry(subject);

      if (!entry) {
        this.emitSyncStatus();

        return;
      }
    }

    // Step 2: sign and POST the accumulated Loro delta, if any.
    const resource = this.resources.get(subject);

    if (!resource) {
      // Cold drain: resource not in memory. Without the Loro doc we
      // can't sign the delta. Critical: do NOT clear the dirty bit
      // here — on page reload, the outbox is restored from
      // localStorage BEFORE clientDb hydration finishes, so the
      // drain races ahead of resource hydration. Clearing here would
      // permanently drop offline edits that haven't been replayed
      // into the in-memory store yet. Leave the entry dirty; the
      // hydration path will re-trigger the drain once the resource
      // is in place (via `markDirty` from the post-hydrate Loro
      // subscriber, or via the next user action).
      this.emitSyncStatus();

      return;
    }

    // Cold-drain extension: even if there's a Resource object in
    // `this.resources` for the subject, treat it as "not hydrated"
    // when it's still loading and has no Loro doc state. A fresh
    // placeholder (`getResourceLoading` cold-call before clientDb
    // hydrate completes) shows up here as `loading=true` with an
    // empty Loro doc — draining it would `exportLoroDeltaForDrain →
    // undefined → clearDirty`, permanently dropping the
    // localStorage-restored offline edit before its real state has
    // a chance to land.
    const hasLoroState =
      resource.hasLoroDoc() && !!resource.getLoroDoc()?.oplogVersion();

    if (resource.loading && !hasLoroState) {
      this.emitSyncStatus();

      return;
    }

    const agent = this.getAgent();
    if (!agent) return;

    // Offline-edit recovery: if this subject went dirty while offline, the
    // outbox holds the last-synced version. On reload the doc rehydrates
    // with the offline ops already applied and its save cursor resets to
    // the current version — exporting from there yields an empty delta and
    // the edit is lost. Rewind the cursor to the synced baseline so the
    // export below emits the offline delta. No-op during normal online
    // operation (`baseVersion` is only set on the offline path).
    if (entry.baseVersion) {
      resource.restoreSaveCursor(entry.baseVersion);
    }

    const previousCommit = resource.getLastCommitForChain();
    const isFirstCommit = !previousCommit;
    // Tag this commit's Loro change with a unique token so the oplog keeps
    // a distinct Change per Atomic commit — `getLoroHistory` buckets by it
    // to reconstruct one version per commit. The token only needs to be
    // unique within the doc's oplog (including across reloads, since a
    // rehydrated doc carries its old tokens), so combine wall-clock time
    // with a monotonic counter.
    const commitToken = `c-${this.randomPart()}`;
    // Capture {bytes, version} atomically so the cursor advances to
    // the version that's in this commit — not to a later one that
    // arrived during the await on `postCommit`.
    const exported = resource.exportLoroDeltaForDrain(
      isFirstCommit,
      commitToken,
    );

    if (!exported) {
      this.outbox.clearBaseVersion(subject);
      this.outbox.clearDirty(subject);
      this.emitSyncStatus();

      return;
    }

    const { bytes: delta, versionAfterExport } = exported;
    const builder = new CommitBuilder(subject);
    if (previousCommit) builder.setPreviousCommit(previousCommit);
    builder.setLoroUpdate(delta);
    const commit = await builder.sign(agent);

    const created = await this.postCommit(commit, endpoint);
    const commitId = commitIdOf(created);

    if (commit.signature) {
      resource.appliedCommitSignatures.add(commit.signature);
    }

    if (commitId) {
      resource.setLastCommitValue(commitId);
      resource.applyToStore('local-acked', { commitId });
    }

    // Advance the cursor to the version that was IN this commit, not
    // to current oplog version — any local ops added during the
    // `await postCommit` round-trip are post-commit and must remain
    // dirty until the next drain pass.
    resource.markLoroSavedAt(versionAfterExport);

    // The offline baseline (if any) has now been exported and acked — the
    // cursor sits at or past it, so drop it. Any still-dirty ops past the
    // cursor are online edits with the live cursor as their baseline.
    this.outbox.clearBaseVersion(subject);

    // Did this commit capture everything, or did the user type more
    // during the `await postCommit` round-trip? Compute BEFORE firing
    // `notifyResourceSaved` so the `_dirty` flag is already cleared
    // when `UnsavedIndicator`'s ResourceSaved handler re-reads
    // `hasUnsavedChanges()` — otherwise it reads a stale `true` and the
    // editable-title `*` never clears (rename-regression e2e).
    const caughtUp = !resource.hasOpsPastSaveCursor();

    if (caughtUp) {
      resource.markSynced();
    }

    this.notifyResourceSaved(resource);
    await this.maybePushBlobForResource(resource).catch(() => undefined);

    // Only clear the outbox dirty bit if we caught up. If the user
    // typed more characters mid-round-trip, the Loro subscriber already
    // called `markDirty` (synchronously) and our `clearDirty` would
    // erase that entry — so leave it dirty and nudge another drain.
    if (caughtUp) {
      this.outbox.clearDirty(subject);
    } else {
      this.outbox.markDirty(subject);
    }

    this.emitSyncStatus();
  };

  /**
   * Compute the drive sync state: a hash summarizing all resources' Loro
   * version vectors, plus the individual VV data for diff computation.
   * Used by the sync protocol to determine what needs syncing.
   */
  public async computeDriveSyncState(drive: string): Promise<DriveSyncState> {
    // Collect VVs from WASM DB (persisted snapshots)
    let allVVs: Record<string, Record<string, number>> = {};

    if (this.clientDb) {
      try {
        // NB: this pulls the version vector of EVERY resource in OPFS (all
        // drives), and the worker is single-threaded — so a large DB makes this
        // hog the worker and delays the sidebar's own OPFS queries. Scope-to-
        // drive is the fix; see the `drive` arg we already have.
        const endVV = perfSpan('clientdb.getAllVersionVectors');
        allVVs = await this.clientDb.getAllVersionVectors();
        endVV({ count: Object.keys(allVVs).length });
      } catch {
        // WASM DB may not be ready yet
      }
    }

    // Also collect from in-memory resources that belong to this drive.
    // Covers freshly created resources not yet persisted to the WASM DB.
    for (const [subject, resource] of this.resources) {
      if (allVVs[subject]) continue;

      // Only include resources belonging to this drive
      const parent = resource.get(core.properties.parent) as string | undefined;

      if (subject !== drive && parent !== drive) continue;

      const doc = resource.getLoroDoc?.();

      if (!doc) continue;

      // Debug: inspect the VV
      try {
        const vv = doc.oplogVersion?.();

        // VersionVector from loro-crdt has toJSON() → Map<PeerID, number>
        if (vv && typeof vv.toJSON === 'function') {
          const vvMap: Record<string, number> = {};
          const jsonMap = vv.toJSON() as Map<string, number>;

          for (const [peerId, counter] of jsonMap) {
            vvMap[String(peerId)] = Number(counter);
          }

          if (Object.keys(vvMap).length > 0) {
            allVVs[subject] = vvMap;
          }
        }
      } catch {
        // Loro doc may not be fully initialized
      }

      // If VV is empty but resource exists and isn't new, include it with
      // an empty VV so the server knows we have it (even if we can't diff).
      // This happens when Loro state was clobbered by a merge from server
      // JSON-AD that doesn't include the snapshot.
      if (!allVVs[subject] && !resource.new) {
        allVVs[subject] = {};
      }
    }

    // Collect unique peer IDs across all resources
    const peerSet = new Set<string>();

    for (const vv of Object.values(allVVs)) {
      for (const peerId of Object.keys(vv)) {
        peerSet.add(peerId);
      }
    }

    const peers = [...peerSet].sort();
    const peerIndex = new Map(peers.map((p, i) => [p, i]));

    // Build compact resource VV list (counters indexed by peers array)
    const resources: Record<string, number[]> = {};

    for (const [subject, vv] of Object.entries(allVVs)) {
      const counters = new Array(peers.length).fill(0);

      for (const [peerId, counter] of Object.entries(vv)) {
        const idx = peerIndex.get(peerId);

        if (idx !== undefined) {
          counters[idx] = counter;
        }
      }

      resources[subject] = counters;
    }

    // Compute drive hash: SHA-256 of sorted (subject + VV bytes)
    const sortedEntries = Object.entries(resources).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const hashInput = sortedEntries
      .map(([s, c]) => `${s}:${c.join(',')}`)
      .join('|');
    const hashBuffer = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(hashInput),
    );
    const driveHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return { drive, driveHash, peers, resources };
  }

  /**
   * Query the local WASM database. Returns null if no ClientDb is available.
   * This runs in a Web Worker and does not block the main thread.
   */
  public async queryLocalDb(
    opts: ClientDbQueryOpts,
  ): Promise<ClientDbQueryResult | null> {
    if (!this.clientDb) return null;

    // Wait for the DB to be ready
    if (!this.clientDb.isReady) {
      const ready = await this.clientDb.waitForReady();

      if (!ready) return null;
    }

    try {
      return await this.clientDb.query(opts);
    } catch (e) {
      console.warn('[ClientDb] query failed:', e);

      return null;
    }
  }

  /**
   * Try to load a resource from the WASM DB (OPFS).
   * Returns the Resource if found, or null if not available.
   */
  private async fetchResourceFromClientDb(
    subject: string,
  ): Promise<Resource | null> {
    if (!this.clientDb) return null;

    if (!this.clientDb.isReady) {
      const ready = await this.clientDb.waitForReady();

      if (!ready) return null;
    }

    try {
      const jsonAd = await this.clientDb.getResource(subject);
      if (!jsonAd) return null;

      return this.hydrateOfflineReplay(subject, JSON.parse(jsonAd));
    } catch {
      return null;
    }
  }

  /** Build a Resource from a parsed JSON-AD object, hydrate Loro,
   *  and route through the unified ingress with `offline-replay`
   *  source. Used by both the OPFS-cold-load path and the
   *  per-page-reload outbox restore path. */
  private hydrateOfflineReplay(
    subject: string,
    parsed: Record<string, unknown>,
  ): Resource {
    const resource = new Resource(subject);
    resource.applyHydratedValues(
      Object.entries(parsed).filter(([key]) => key !== '@id') as [
        string,
        JSONValue,
      ][],
    );
    resource.getLoroDoc();
    resource.loading = false;
    this.applyIncoming({
      subject: resource.subject,
      resource,
      source: 'offline-replay',
    });

    return resource;
  }

  /**
   * Normalizes a subject: if it is a relative path, it becomes a full URL using the server's base URL.
   * DIDs and full HTTP URLs are returned as-is.
   */
  /** Normalize then alias-resolve a user-supplied subject to its
   *  canonical key (the one used in the resources Map). */
  private resolveSubject(subject: string): string {
    const normalized = this.normalizeSubject(subject);

    return this.aliases.get(normalized) ?? normalized;
  }

  /** Resolve a (possibly aliased) subject to its cached Resource. */
  private getResolved(subject: string): Resource | undefined {
    return this.resources.get(this.resolveSubject(subject));
  }

  /** Mark a resource as errored + not-loading + notify. No-op if
   *  the subject isn't in the store. */
  private failResource(subject: string, error: Error): void {
    const resource = this.getResolved(subject);
    if (!resource) return;
    resource.loading = false;
    resource.setError(error);
    this.notify(resource);
  }

  /**
   * Returns true if this store owns the given subject — i.e. local
   * Loro edits to it should be POSTed to our server. Used by the
   * sign-at-drain dirty filter: external-domain HTTP subjects and
   * derived commit-detail resources accept Loro hydration locally
   * but must not reach our `/commit` endpoint.
   */
  public isOwnedSubject(subject: string): boolean {
    if (subject.startsWith('did:ad:commit:')) return false;
    if (subject.startsWith('did:')) return true;
    // `_new:` is the client-only transient subject between
    // `getResourceLoading` and the DID derive in `signChanges`.
    // `_local:` is Rust-side and shouldn't appear here.
    if (subject.startsWith('_new:')) return true;

    if (subject.startsWith('http://') || subject.startsWith('https://')) {
      try {
        const url = new URL(subject);

        // Query/endpoint URLs (`/query?page_size=…`, search, etc.) carry
        // query params. They're transient server-computed projections
        // that happen to be Loro-backed locally for client-side sorting
        // — NOT committable resources. A real resource subject never has
        // query params (commits strip them via `removeQueryParamsFromURL`).
        // Without this guard the Loro subscriber marks these dirty, they
        // enter the outbox, and the drain can never POST a commit for a
        // `/query?…` endpoint → `pendingDirtyCount` never reaches 0 and
        // every `waitForSynced` / offline-sync flow strands. (sync:219.)
        if (url.search) return false;

        return url.origin === new URL(this.serverUrl).origin;
      } catch {
        return false;
      }
    }

    return false;
  }

  public normalizeSubject(subject: string): string {
    const stripLeadingSlash = (value: string) =>
      value.startsWith('/') ? value.slice(1) : value;
    const maybeTempSubject = stripLeadingSlash(subject);

    // Internal temporary subjects (used during newResource before DID
    // derivation) are returned verbatim — they must not be resolved as URLs.
    if (
      maybeTempSubject.startsWith('_new:') ||
      maybeTempSubject.startsWith('_local:')
    ) {
      return maybeTempSubject;
    }

    // DIDs are returned as-is — new URL() would mangle base64 characters (+, /, =)
    if (subject.startsWith('did:')) {
      return subject;
    }

    // HTTP URLs are normalized
    if (subject.startsWith('http://') || subject.startsWith('https://')) {
      try {
        const url = new URL(subject);

        // Remove trailing slash if it's not the root
        if (url.pathname.length > 1 && url.href.endsWith('/')) {
          return url.href.slice(0, -1);
        }

        return url.href;
      } catch (e) {
        return subject;
      }
    }

    // Relative path - resolve to full URL
    // This also handles trailing slashes consistently
    try {
      const url = new URL(subject, this.serverUrl);

      if (url.pathname.length > 1 && url.href.endsWith('/')) {
        return url.href.slice(0, -1);
      }

      return url.href;
    } catch (e) {
      return subject;
    }
  }

  /**
   * Single ingress for resource state from any source: subject
   * normalisation, commit-id dedup, Loro hydration, atomic OPFS
   * persist, one `notify` — in that order.
   */
  public applyIncoming(
    change: IncomingChange,
  ): 'applied' | 'deduped' | 'invalid' {
    // Resource-direct path: caller is the authoritative producer.
    if (change.resource) {
      const alias =
        change.subject !== change.resource.subject ? change.subject : undefined;
      this.addResource(change.resource, { skipCommitCompare: true, alias });

      return 'applied';
    }

    if (!change.loroBytes) return 'invalid';

    const subject = this.normalizeSubject(change.subject);
    const existing = this.resources.get(this.aliases.get(subject) ?? subject);

    // Echo dedup: same commitId as cached lastCommit ⇒ no-op.
    if (
      !change.forceNotify &&
      change.commitId &&
      existing &&
      !existing.loading &&
      !existing.new &&
      existing.get(commits.properties.lastCommit) === change.commitId
    ) {
      return 'deduped';
    }

    const resource =
      existing ?? this.getResourceLoading(subject, { newResource: false });
    const { complete } = resource.importLoroUpdate(change.loroBytes);

    // Commit-detail resources (`did:ad:commit:<sig>`) carry a single
    // commit's `loroUpdate`, which is a DELTA by design — importing it
    // into a fresh doc legitimately leaves "pending" ops (the base it
    // builds on lives in the committed-to resource, not here). They are
    // exempt from the incomplete-import guard below; otherwise every
    // commit fetched on refresh (e.g. <CommitDetail> in a chatroom)
    // would be failed and vanish.
    const isCommitDetail = subject.startsWith('did:ad:commit:');

    // Incomplete import: the bytes couldn't fully apply (missing base
    // ops left pending). The resource has whatever it had before plus
    // `lastCommit` — but NOT the real Loro-backed props. Without this
    // guard it would flip to `loading=false` and render as an empty
    // "loaded" resource (only `subject` + `lastCommit` showing), with
    // no error anywhere. Surface it instead. Skip the failure if the
    // resource already had usable content from a prior good import
    // (a late/partial live push shouldn't blow away a good state).
    if (!complete && !isCommitDetail && !resource.get(core.properties.isA)) {
      console.warn(
        `[Store] applyIncoming: incomplete Loro import for ${subject.slice(0, 60)} ` +
          `(source: ${change.source}) — server sent a delta this client can't apply ` +
          `(missing base state). Surfacing as error.`,
      );
      if (change.commitId) resource.setLastCommitValue(change.commitId);
      this.failResource(
        subject,
        new Error(
          'Sync error: received an incomplete update for this resource ' +
            '(missing base state). Try reloading; if it persists, the ' +
            "local cache may be out of sync with the server's history.",
        ),
      );

      return 'invalid';
    }

    if (change.commitId) resource.setLastCommitValue(change.commitId);
    resource.loading = false;
    this.addResource(resource, { skipCommitCompare: true });

    return 'applied';
  }

  /**
   * Persist + notify a Resource into the store. Most callers
   * should prefer {@link applyIncoming}, which adds an explicit
   * `source` tag and a commit-id dedup. This direct entry is kept
   * for tests/benches and for paths that already own a Resource
   * but don't care about source attribution.
   */
  public addResource(
    resource: Resource,
    { skipCommitCompare, alias }: AddResourcesOpts = {},
  ): void {
    // The resource might be new and not have a store yet. We set it here.
    resource.setStore(this);

    const subject = this.normalizeSubject(resource.subject);

    if (alias) {
      const normalizedAlias = this.normalizeSubject(alias);

      if (normalizedAlias !== subject) {
        this.aliases.set(normalizedAlias, subject);
      }
    }

    if (resource.subject !== subject) {
      resource.setSubject(subject);
    }

    // Incomplete resources may miss some properties
    if (resource.get(core.properties.incomplete)) {
      // If there is a resource with the same subject, we won't overwrite it with an incomplete one
      const existing = this.resources.get(subject);

      if (existing && !existing.loading) {
        return;
      }
    }

    const storeResource = this.resources.get(subject);

    // Check if the resource has the same last commit as the one already in the store, if so, we don't want to notify so we don't trigger rerenders.
    if (!skipCommitCompare) {
      if (
        storeResource &&
        !storeResource.hasClasses(collections.classes.collection) &&
        !storeResource.loading &&
        !storeResource.new &&
        storeResource.get(commits.properties.lastCommit) ===
          resource.get(commits.properties.lastCommit)
      ) {
        return;
      }
    }

    // If the resource is already in the store, we merge it so code that
    // depends on the resource will get the new values.
    // EXCEPT: if the existing resource has unsaved local changes (dirty),
    // don't overwrite it with the server's version. The local changes
    // need to be synced first.
    if (storeResource) {
      storeResource.merge(resource.__internalObject);
    } else {
      this.resources.set(subject, resource.__internalObject);
    }

    const emitResource = storeResource ?? resource.__internalObject;

    // Update local full-text search index, partitioned by the resource's
    // drive (root of its parent chain).
    if (!resource.loading && !resource.new) {
      this.localSearch.addResource(resource, this.driveOf(resource.subject));
    }

    // Atomic put queued BEFORE notify. The worker's serialised
    // queue means a follow-up `queryLocalDb` (e.g. from
    // Collection.refresh in a notify listener) sees the new
    // resource. Skip for new/loading/incomplete/unsynced — those
    // persist themselves via `applyPendingCommitsLocally` or are
    // placeholders.
    if (
      this.clientDb &&
      // Skip persisting when the worker has a known init failure (e.g.
      // OPFS leader-election couldn't steal the lock — Firefox doesn't
      // support `navigator.locks.request({ steal: true })`). Without this
      // gate every single `addResource` would queue a `putResourceWithSnapshot`
      // that fails with the same error, flooding the console with one
      // stack trace per resource. The worker itself has already warned
      // once when init failed — that single line is the actionable signal.
      !this.clientDb.initError &&
      !resource.loading &&
      !resource.new &&
      !resource.hasPendingCommits &&
      !resource.get(core.properties.incomplete)
    ) {
      try {
        const jsonAd = resourceToJsonAd(resource);

        if (jsonAd) {
          const doc = resource.getLoroDoc?.();
          const snapshot = doc?.export({ mode: 'snapshot' });
          this.clientDb
            .putResourceWithSnapshot(resource.subject, jsonAd, snapshot)
            .catch(e =>
              console.error(
                `[ClientDb] put failed for ${resource.subject.slice(0, 60)}:`,
                e,
              ),
            );
        }
      } catch (e) {
        console.error(
          `[ClientDb] put serialization threw for ${resource.subject.slice(0, 60)}:`,
          e,
        );
      }
    }

    this.notify(emitResource);
  }

  /**
   * Create a new resource.
   *
   * When `did` is `true` (the default) the genesis commit is signed locally so
   * the resource's real DID (`did:ad:<signature>`) is known immediately — no
   * server round-trip required.  An agent must be set on the store for DID
   * resources.
   *
   * The resource is **not** pushed to the server yet; call `resource.save()` or
   * `resource.pushCommits()` to persist it.
   */
  public async newResource<C extends OptionalClass = UnknownClass>({
    subject,
    parent,
    isA,
    propVals,
    noParent,
    did,
  }: CreateResourceOptions = {}): Promise<Resource<C>> {
    const shouldUseDid =
      did ?? this.getAgent()?.subject?.startsWith('did:ad:agent:') ?? false;
    const normalizedParent = parent
      ? this.normalizeSubject(parent)
      : this.normalizeSubject(this.serverUrl);

    const normalizedIsA = Array.isArray(isA) ? isA : [isA];

    // When the caller supplies an explicit subject, use it as-is.
    // For HTTP subjects use the parent-based path.
    // For DID subjects a temporary internal key is used; the real DID is
    // derived below after signing.
    const newSubject =
      subject ??
      (shouldUseDid
        ? `_new:${this.randomPart()}`
        : this.createHTTPSubject(normalizedParent));

    const resource = this.getResourceLoading(newSubject, { newResource: true });

    if (normalizedIsA[0]) {
      await resource.addClasses(...(normalizedIsA as string[]));
    }

    if (!noParent) {
      await resource.set(core.properties.parent, normalizedParent);
    }

    if (propVals) {
      for (const [key, value] of Object.entries(propVals)) {
        await resource.set(key, value);
      }
    }

    // For DID resources: sign the genesis commit locally to derive the
    // real DID from the signature, then STASH it ON THE RESOURCE (not
    // the outbox). Creating a resource must not persist it — only
    // `save()` does. Holding the genesis off the outbox means a
    // created-but-never-saved resource (e.g. a `TableNewRow` placeholder
    // mounted but never filled) is never POSTed; it's discarded with the
    // component. `save()` moves the stashed genesis into the outbox to
    // drain. This is the ONLY remaining call site for `signChanges` —
    // every other path signs from the Loro delta at drain time.
    if (shouldUseDid && !subject) {
      const agent = this.getAgent();

      if (!agent) {
        throw new Error(
          'Cannot create a DID resource without an agent. Set an agent on the store first.',
        );
      }

      // `signChanges` auto-detects genesis for a `_new:` subject with no
      // previousCommit, deriving the real `did:ad:<sig>` subject from the
      // signature — no explicit "mark genesis" step needed.
      const genesisCommit = await resource.signChanges(agent);
      // resource.subject is now did:ad:<signature>
      resource.stashGenesis(genesisCommit);
    }

    return resource;
  }

  /**
   * Creates a new personal Drive for the current Agent, saves it, and links
   * it to the Agent resource. Returns the Drive's Resource (already saved).
   *
   * This is the canonical way to create a drive — use it instead of
   * duplicating the create-drive-save-link-agent pattern.
   */
  public async createDrive(
    name: string,
    description?: string,
    /** Optional name to persist on the Agent resource as part of the same
     *  commit that links `personalDrive` + `drives`. Avoids needing a
     *  separate save call for callers (e.g. `useDevDrive`) that want the
     *  agent to be renderable as a named resource right away. */
    agentName?: string,
  ): Promise<Resource> {
    const agent = this.getAgent();

    if (!agent?.subject) {
      throw new Error('Cannot create a drive without an Agent');
    }

    const drive = await this.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: {
        [core.properties.name]: name,
        [core.properties.description]: description ?? 'Your personal drive.',
        [core.properties.write]: [agent.subject],
        [core.properties.read]: [agent.subject],
      },
    });

    await drive.save();

    // Link the drive to the Agent resource. We MUST force a fresh fetch
    // from the server here. The agent may already be in the store (from a
    // stale clientDb cache or a previous partial load) with `loading=false`,
    // in which case `getResource()` short-circuits and returns the cached
    // stub. Then `set/push/save` would commit a Loro snapshot that only
    // carries the locally-set properties (personalDrive, drives) — the
    // server-side state (isA, publicKey, read, etc.) was never merged into
    // the local Loro doc, so it isn't part of the outgoing snapshot, and
    // isn't written to clientDb. On reload the SPA reads the partial cache
    // and the agent's edit form errors with "<class> is not a Class"
    // because `isA` is missing. Forcing a fetch seeds the local resource
    // with the full server state before we layer the new properties on top.
    //
    // Use HTTP (not WS): the WS may still be authenticated as a previous
    // agent (e.g. onboarding switches from a dev-drive agent to a freshly-
    // created one — the WS auth is fire-and-forget and races the GET).
    // HTTP signs each request with the current agent and never has stale
    // session state.
    const agentResource = await this.fetchResourceFromServer(agent.subject, {
      noWebSocket: true,
    });
    await agentResource.set(
      core.properties.personalDrive,
      drive.subject,
      false,
    );
    agentResource.push(server.properties.drives, [drive.subject], true);

    if (agentName) {
      await agentResource.set(core.properties.name, agentName, false);
      const currentIsA = (agentResource.get(core.properties.isA) ??
        []) as string[];

      if (!currentIsA.includes(core.classes.agent)) {
        await agentResource.set(
          core.properties.isA,
          [...currentIsA, core.classes.agent],
          false,
        );
      }
    }

    await agentResource.save();

    return drive;
  }

  public async search(query: string, opts: SearchOpts = {}): Promise<string[]> {
    // The local search index is partitioned per drive. The `parents` scope
    // the overlay passes is either the drive itself or a folder inside it;
    // resolve it up to the drive so the right partition is searched.
    const parentScope = Array.isArray(opts.parents)
      ? opts.parents[0]
      : opts.parents;
    const searchDrive = this.driveOf(parentScope ?? this.getDrive() ?? '');
    console.debug('[search] search()', {
      query,
      hasFilters: !!opts.filters,
      parents: opts.parents,
      searchDrive,
      driveIndexSize: this.localSearch.sizeForDrive(searchDrive),
      serverConnected: this._serverConnected,
    });

    // Try local search first if the index has content and no filters are set.
    // Filters (property-value constraints) require server-side Tantivy for now.
    if (
      this.localSearch.sizeForDrive(searchDrive) > 0 &&
      !opts.filters &&
      !opts.parents
    ) {
      const local = this.localSearch.search(
        query,
        searchDrive,
        opts.limit ?? 30,
      );
      console.debug('[search] local (unscoped) →', local.subjects.length);

      if (local.subjects.length > 0) {
        return local.subjects;
      }
    }

    // When offline, the server's filtered Tantivy search is unreachable.
    // Fall back to the drive's local index — `filters` (property-value
    // constraints) can't be honoured client-side, but the per-drive
    // partition still scopes results to the drive being browsed. The
    // search overlay always passes `parents: <drive>`, so without this
    // fallback offline search would never consult the local index at all.
    if (!this._serverConnected) {
      // Build this drive's local index on demand (first offline search only).
      // The index isn't maintained eagerly on load — see `ensureDriveIndexed`.
      await this.ensureDriveIndexed(searchDrive);

      const offline = this.localSearch.search(
        query,
        searchDrive,
        opts.limit ?? 30,
      );
      console.debug(
        '[search] OFFLINE local fallback →',
        offline.subjects.length,
        offline.subjects,
      );

      return offline.subjects;
    }

    // Fall back to server search (Tantivy)
    const searchSubject = buildSearchSubject(this.serverUrl, query, opts);
    console.debug('[search] server search →', searchSubject);
    const searchResource = await this.fetchResourceFromServer(searchSubject, {
      noWebSocket: true,
    });
    const results = searchResource.get(server.properties.results) ?? [];
    console.debug('[search] server search returned', results.length);

    return results;
  }

  /** Checks if a subject is free to use */
  public async checkSubjectTaken(subject: string): Promise<boolean> {
    const r = this.resources.get(subject);

    if (r?.isReady() && !r?.new) {
      return true;
    }

    try {
      const signInfo = this.agent
        ? { agent: this.agent, serverURL: this.getServerUrl() }
        : undefined;

      const { createdResources } = await this.client.fetchResourceHTTP(
        subject,
        {
          method: 'GET',
          signInfo,
        },
      );

      if (createdResources.find(res => res.subject === subject)?.isReady()) {
        return true;
      }
    } catch (_) {
      // If the resource doesn't exist, we can use it
    }

    return false;
  }

  /**
   * Checks is a set of URL parts can be combined into an available subject.
   * Will retry until it works.
   */
  public async buildUniqueSubjectFromParts(
    parts: string[],
    parent?: string,
  ): Promise<string> {
    const path = parts.map(part => stringToSlug(part)).join('/');
    const parentUrl = parent ?? this.getServerUrl();

    return this.findAvailableSubject(path, parentUrl);
  }

  /**
   * Creates a placeholder subject for a brand-new resource. When the current
   * agent is DID-based, returns a temporary `_new:{random}` key that gets
   * replaced with the real `did:ad:...` on first commit (matching
   * `newResource()`'s shouldUseDid path). Otherwise builds a random HTTP
   * subject under `parent` or the server root.
   *
   * Without this branch, callers like `useNewForm` would mint an HTTP
   * subject such as `http://localhost:9883/01k…` that a DID-agent has no
   * edit rights on — saves fail with "Agent does not have edit rights".
   */
  public createSubject(parent?: string): string {
    const agentSubject = this.getAgent()?.subject;

    if (agentSubject?.startsWith('did:ad:agent:')) {
      return `_new:${this.randomPart()}`;
    }

    return this.createHTTPSubject(parent ?? this.serverUrl);
  }

  /**
   * Try the local WASM DB first, then fall back to server.
   * If the WASM DB has the resource, it's used immediately (and a background
   * server fetch can refresh it later). This keeps the UI fast while the
   * network catches up.
   *
   * If both the WASM DB and the server fail (offline + cold cache),
   * the resource stays in `loading` state rather than throwing.
   */
  private async fetchResourceWithLocalFallback(
    subject: string,
    opts: FetchOpts = {},
  ): Promise<void> {
    let hasLocalData = false;

    // Wait for the WASM DB to initialize (if one is set).
    // This is important on page reload: the DB may still be loading
    // but it has data from a previous session that we need.
    //
    // We deliberately wait only for `init` here, not the bootstrap
    // `seed`. The seed pushes in-memory default-property resources
    // into OPFS — useful for offline reload — but lookups in this
    // function are for user-data subjects that aren't part of the
    // bootstrap, so they don't depend on it. Gating useResource
    // cold-loads on the seed adds 200–500 ms of dead time on a
    // populated drive (70 sequential property puts + reseed loop).
    if (this.clientDb) {
      await this.clientDb.waitForInit();
    }

    // Try the WASM DB (OPFS) for persisted resources. One combined
    // round-trip instead of `getResource` + `getLoroSnapshot`: every
    // mounted useResource takes this path on cold-load, and each
    // worker postMessage costs ~ms; halving the round-trips visibly
    // reduces time-to-first-paint on a populated drive.
    if (this.clientDb?.isInitialized) {
      try {
        const { jsonAd, snapshot } =
          await this.clientDb.getResourceWithSnapshot(subject);

        if (jsonAd) {
          hasLocalData = this.hydrateResourceFromJson(
            subject,
            JSON.parse(jsonAd),
          );
        }

        if (hasLocalData && snapshot && snapshot.length > 0) {
          const resource = this.resources.get(subject);

          if (resource) {
            resource.importLoroUpdate(snapshot);
          }
        }
      } catch (e) {
        console.warn(`[ClientDb] OPFS lookup failed for "${subject}":`, e);
      }
    }

    // Try the server if connected. Skip if we have local data and are offline
    // to avoid overwriting good data with error responses.
    try {
      if (!this._serverConnected) {
        // Offline — use whatever local data we found. If there IS no local
        // data, surface the offline state to the caller rather than leaving
        // the resource stuck in `loading`.
        if (!hasLocalData) {
          this.failResource(
            subject,
            new Error(
              'Offline: resource not available locally. Reconnect to fetch.',
            ),
          );
        }
      } else if (hasLocalData) {
        // Online with local data: trust OPFS + live WS updates. SUB
        // on each drive produces SYNC_DIFF / SYNC_PUSH frames that
        // tell us about deltas, and DESTROY frames evict gone
        // subjects from the local cache. A background-verify GET per
        // cached resource used to live here as a belt-and-braces
        // catch for "deleted-while-disconnected" — but it fires for
        // every `useResource(...)` on every reload, producing the
        // user-observed N×{GET sub} storm on a populated drive. The
        // narrow case it covered (a destroy commit that landed while
        // we were disconnected AND not covered by SUB on reconnect)
        // is rare and recovers on the next live update.
      } else {
        // Online, no local data — server is our only source.
        await this.fetchResourceFromServer(subject, opts);
      }
    } catch (e) {
      // Server fetch failed with no local data. Surface the actual server
      // error (e.g. 401 Unauthorized) so callers (ErrorPage, GettingStartedFlow)
      // can react correctly. Only fall back to a generic offline message when
      // we have no other signal.
      if (!hasLocalData) {
        this.failResource(
          subject,
          e instanceof Error ? e : new Error('Resource fetch failed'),
        );
      }
    }
  }

  /** Hydrate a Resource from a parsed JSON-AD object and add it to the store. Returns true if successful. */
  /**
   * Parse a JSON-AD string from the local DB and hydrate it into the store.
   * Used by collection page loads so members have their propvals available
   * for client-side sorting before the consumer's individual fetches happen.
   */
  public hydrateResourceFromJsonAd(subject: string, jsonAd: string): boolean {
    try {
      const parsed = JSON.parse(jsonAd) as Record<string, unknown>;

      return this.hydrateResourceFromJson(subject, parsed);
    } catch {
      return false;
    }
  }

  private hydrateResourceFromJson(
    subject: string,
    parsed: Record<string, unknown>,
  ): boolean {
    const existing = this.getResolved(subject);

    // Don't overwrite a resource that has a Loro snapshot with one that doesn't.
    if (
      existing &&
      existing.get(commits.properties.loroUpdate) &&
      !parsed[commits.properties.loroUpdate]
    ) {
      return true;
    }

    // Don't clobber an in-memory resource that has unsaved local edits
    // — `hydrateOfflineReplay` would overwrite the in-flight Loro state
    // with the (older) clientDb snapshot. The signal is in-memory only:
    // `hasUnsavedChanges()` (commitBuilder / `_dirty` between a `set()`
    // and the next drain).
    //
    // We deliberately do NOT gate on `hasPendingCommits` (the outbox
    // genesis/dirty bit): that survives reload via localStorage, so on
    // a cold load a freshly-created placeholder for an offline-saved
    // resource has `hasPendingCommits === true` but NO in-memory state
    // to protect. Gating on it skipped `hydrateOfflineReplay`, leaving
    // the placeholder stuck `loading: true` forever (offline file
    // upload never rendered; the snapshot import populated the doc but
    // `loading` never cleared). clientDb already holds the offline
    // state, so hydrating from it RESTORES the edit — it doesn't clobber
    // it.
    if (existing?.hasUnsavedChanges()) {
      return true;
    }

    this.hydrateOfflineReplay(subject, parsed);

    // If the outbox holds a dirty bit for this subject (offline edit
    // restored from localStorage), kick a drain now that the resource
    // is finally in the store. Without this nudge the drain would
    // either: (a) never fire — `hydrateOfflineReplay` doesn't go
    // through `set()`, so the Loro subscriber that normally schedules
    // drains stays silent; (b) have fired earlier (in
    // `setClientDb`'s auto-trigger) when the resource wasn't loaded
    // yet, hit the "no resource" cold-drain branch, and bailed.
    if (this.outbox.hasPending(subject)) {
      this.scheduleOutboxDrain();
    }

    return true;
  }

  /**
   * Always fetches the resource from the server then adds it to the store.
   */
  public async fetchResourceFromServer<C extends OptionalClass = UnknownClass>(
    /** The resource URL to be fetched */
    subject: string,
    opts: {
      /**
       * Fetch it from the `/path` endpoint of your server URL. This effectively
       * is a proxy / cache.
       */
      fromProxy?: boolean;
      /** Overwrites the existing resource and sets it to loading. */
      setLoading?: boolean;
      /** Do not use WebSockets, use HTTP(S) */
      noWebSocket?: boolean;
      /** HTTP Method, defaults to GET */
      method?: 'GET' | 'POST';
      /** HTTP Body for POSTing */
      body?: ArrayBuffer | string;
    } = {},
  ): Promise<Resource<C>> {
    const normalizedSubject = this.normalizeSubject(subject);

    // In-flight dedup. SideBarDrive and DrivePage both call
    // `useResource(drive)` on the same render → two parallel
    // `fetchResourceFromServer(drive)`. Without sharing, both fire
    // their own WS `GET` (visible as `did:ad:<drive> (×2)` in the
    // network log). Reuse the in-flight promise; the second caller
    // gets the same Resource handle the first eventually resolves to.
    //
    // Skip dedup for POST (different semantics — each is a write).
    // Skip dedup when `setLoading` is requested (caller explicitly
    // wants a fresh roundtrip + loading state). Skip for temporary
    // subjects (`_new:`/`_local:`) which never go to the network.
    const canDedup =
      opts.method !== 'POST' &&
      !opts.setLoading &&
      !normalizedSubject.startsWith('_new:') &&
      !normalizedSubject.startsWith('_local:');

    if (canDedup) {
      const inflight = this._inFlightFetches.get(normalizedSubject);
      if (inflight) return inflight as Promise<Resource<C>>;
    }

    const work = this._fetchResourceFromServerImpl<C>(subject, opts);

    if (canDedup) {
      const tracked = work.finally(() => {
        // Only clear if we're still the owner of the slot — a
        // re-entrant fetch that took the slot after us shouldn't be
        // wiped by our completion.
        if (this._inFlightFetches.get(normalizedSubject) === tracked) {
          this._inFlightFetches.delete(normalizedSubject);
        }
      });
      this._inFlightFetches.set(normalizedSubject, tracked);

      return tracked as Promise<Resource<C>>;
    }

    return work;
  }

  private async _fetchResourceFromServerImpl<
    C extends OptionalClass = UnknownClass,
  >(
    subject: string,
    opts: {
      fromProxy?: boolean;
      setLoading?: boolean;
      noWebSocket?: boolean;
      method?: 'GET' | 'POST';
      body?: ArrayBuffer | string;
    },
  ): Promise<Resource<C>> {
    const normalizedSubject = this.normalizeSubject(subject);
    const isTemporarySubject =
      normalizedSubject.startsWith('_new:') ||
      normalizedSubject.startsWith('_local:');

    // Temporary local subjects are never fetchable from the server.
    // Return a local resource immediately and skip network traffic.
    if (isTemporarySubject) {
      const existing = this.resources.get(normalizedSubject);

      if (existing) {
        existing.loading = false;

        return existing as Resource<C>;
      }

      const local = new Resource<C>(normalizedSubject, true);
      local.loading = false;
      this.addResource(local, { skipCommitCompare: true });

      return local;
    }

    if (opts.setLoading) {
      const newR = new Resource<C>(subject);
      newR.loading = true;
      this.addResource(newR, { skipCommitCompare: true });
    }

    const fetchSubject =
      subject.startsWith('http') || subject.startsWith('did:ad:')
        ? subject
        : new URL(subject, this.serverUrl).toString();

    const ws = this.getWebSocketForSubject(fetchSubject);

    if (
      !opts.fromProxy &&
      !opts.noWebSocket &&
      supportsWebSockets() &&
      ws?.readyState === WebSocket.OPEN
    ) {
      await ws.fetch(fetchSubject);
    } else {
      const signInfo = this.agent
        ? { agent: this.agent, serverURL: this.getServerUrl() }
        : undefined;

      const { resource, createdResources } =
        await this.client.fetchResourceHTTP(fetchSubject, {
          from: opts.fromProxy ? this.getServerUrl() : undefined,
          method: opts.method,
          body: opts.body,
          signInfo,
          serverURL: this.getServerUrl(),
        });

      // Single chokepoint: the JSONADParser already hydrated each
      // resource, so we use the `resource:` ingress on
      // `applyIncoming` instead of calling `addResources` directly.
      // The `subject` arg becomes the alias if it differs from the
      // resolved subject (e.g. POST endpoint that returns the
      // canonical resource).
      this.applyIncoming({
        subject,
        resource,
        source: 'http-fetch',
      });

      const primarySubject = this.normalizeSubject(resource.subject);
      createdResources.forEach(r => {
        if (this.normalizeSubject(r.subject) !== primarySubject) {
          this.applyIncoming({
            subject: r.subject,
            resource: r,
            source: 'http-fetch',
          });
        }
      });
    }

    return this.resources.get(normalizedSubject)!;
  }

  public getAllSubjects(): string[] {
    return Array.from(this.resources.keys());
  }

  /** Returns the WebSocket for the current Server URL */
  public getDefaultWebSocket(): WSClient | undefined {
    return this.webSockets.get(this.getServerUrl());
  }

  /** Toggle WebSocket debug logging. Persisted in localStorage. */
  public setWebSocketDebug(enabled: boolean): void {
    for (const ws of this.webSockets.values()) {
      ws.debug = enabled;
    }

    if (typeof localStorage !== 'undefined') {
      if (enabled) {
        localStorage.setItem('ws-debug', '1');
      } else {
        localStorage.removeItem('ws-debug');
      }
    }
  }

  /** Opens a Websocket for some subject URL, or returns the existing one. */
  public getWebSocketForSubject(subject: string): WSClient | undefined {
    try {
      // DIDs are hosted on the current server, so use server URL for WebSocket
      let origin: string;

      if (subject.startsWith('did:')) {
        origin = new URL(this.serverUrl).origin;
      } else if (subject.startsWith('http')) {
        origin = new URL(subject).origin;
      } else {
        // Relative path - use server URL
        origin = new URL(this.serverUrl).origin;
      }

      return this.webSockets.get(origin);
    } catch (e) {
      throw new Error(
        `Could not open websocket for subject ${subject}: ${e.message}`,
      );
    }
  }

  /** Returns the base URL of the companion server */
  public getServerUrl(): string {
    return this.serverUrl;
  }

  /**
   * Returns the Currently set Agent, returns null if there is none. Make sure
   * to first run `store.setAgent()`.
   */
  public getAgent(): Agent | undefined {
    return this.agent ?? undefined;
  }

  /**
   * Gets a resource by URL. Fetches and parses it if it's not available in the
   * store. Instantly returns an empty loading resource, while the fetching is
   * done in the background . If the subject is undefined, an empty non-saved
   * resource will be returned.
   */
  public getResourceLoading<C extends OptionalClass = UnknownClass>(
    subjectRaw: string = unknownSubject,
    opts: FetchOpts = {},
  ): Resource<C> {
    // Guard before normalization: 'unknown-subject' would otherwise be
    // resolved to `{serverUrl}/unknown-subject` and trigger a real fetch.
    //
    // The instance MUST be cached in `this.resources` — `useResource`
    // wraps `getResourceSnapshot`, whose identity check is
    // `snap.resource !== r.__internalObject`. Allocating a fresh
    // Resource on every call flips that identity each tick, the
    // snapshot tuple turns over, `useSyncExternalStore` reports a new
    // value, React re-renders, we loop. That's the "Too many
    // re-renders / getSnapshot should be cached" infinite render hang
    // any caller that passes `undefined` (e.g. `useResource(drive)`
    // before the drive setting hydrates) used to trigger.
    if (subjectRaw === unknownSubject || subjectRaw === null) {
      let resource = this.resources.get(unknownSubject) as
        | Resource<C>
        | undefined;

      if (!resource) {
        resource = new Resource<C>(unknownSubject, opts.newResource);
        resource.setStore(this);
        this.resources.set(unknownSubject, resource);
      }

      return resource;
    }

    const normalized = this.normalizeSubject(subjectRaw);
    // Commit DIDs identify the commit resource directly — they must never
    // resolve through the alias map. Without this guard, an alias added by
    // a prior fetch (e.g. `did:ad:commit:<sig>` accidentally aliased to the
    // committed-to subject during signing/hydration) sends the user to the
    // resource the commit edits instead of the commit itself.
    const resolved = normalized.startsWith('did:ad:commit:')
      ? normalized
      : (this.aliases.get(normalized) ?? normalized);
    const isNew =
      !!opts.newResource ||
      normalized.startsWith('_new:') ||
      normalized.startsWith('_local:');

    let resource = this.resources.get(resolved);

    if (!resource) {
      resource = new Resource<C>(normalized, isNew);
      if (!isNew) resource.loading = true;
      this.addResource(resource, { alias: normalized });
      if (!isNew) this.fetchResourceWithLocalFallback(normalized, opts);

      return resource;
    }

    if (!opts.allowIncomplete && resource.loading === false) {
      // In many cases, a user will always need a complete resource.
      // This checks if the resource is incomplete and fetches it if it is.
      if (resource.get(core.properties.incomplete)) {
        resource.loading = true;
        this.addResource(resource);
        this.fetchResourceFromServer(resolved, opts);
      }
    }

    return resource;
  }

  /**
   * Gets a resource by URL. Fetches and parses it if it's not available in the
   * store. Not recommended to use this for rendering, because it might cause
   * resources to be fetched multiple times.
   */
  public async getResource<C extends OptionalClass = UnknownClass>(
    subjectRaw: string,
  ): Promise<Resource<C>> {
    const resolved = this.resolveSubject(subjectRaw);
    const found = this.resources.get(resolved);

    if (found && found.isReady()) {
      return found;
    }

    /** Fix the case where a resource was previously requested but still not ready */
    if (found && !found.isReady()) {
      return new Promise((resolve, reject) => {
        const defaultTimeout = 10000;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const cb: ResourceCallback<C> = res => {
          if (timer) clearTimeout(timer);
          this.unsubscribe(subjectRaw, cb);
          resolve(res);
        };

        this.subscribe(subjectRaw, cb);

        timer = setTimeout(() => {
          timer = undefined;
          this.unsubscribe(subjectRaw, cb);
          reject(
            new Error(
              `Async Request for subject "${subjectRaw}" timed out after ${defaultTimeout}ms.`,
            ),
          );
        }, defaultTimeout);
      });
    }

    // If offline and the resource can't be fetched via HTTP (DID subjects),
    // check in-memory store first, then try the WASM DB (OPFS).
    if (!this._serverConnected && resolved.startsWith('did:')) {
      const local = this.resources.get(resolved);

      if (local) {
        return local;
      }

      // Try the WASM DB — the resource may have been persisted to OPFS.
      const fromDb = await this.fetchResourceFromClientDb(resolved);

      if (fromDb) {
        return fromDb;
      }

      throw new Error(
        `Resource ${subjectRaw} not found locally and server is offline`,
      );
    }

    const result = await this.fetchResourceFromServer(resolved);

    // If the resource was not in the store yet, subscribe to changes so we don't return stale results when the resource is updated.
    // Commits are immutable — no need to subscribe for push updates.
    if (!result.hasClasses(commits.classes.commit)) {
      this.subscribeWebSocket(resolved);
    }

    return result;
  }

  /** Gets a property by URL. */
  public async getProperty(subject: string): Promise<Property> {
    // This leads to multiple fetches!
    const resource = await this.getResource(subject);

    if (resource === undefined) {
      throw Error(`Property ${subject} is not found`);
    }

    if (resource.error) {
      throw Error(`Property ${subject} cannot be loaded: ${resource.error}`);
    }

    const datatypeUrl = resource.get(core.properties.datatype);

    if (datatypeUrl === undefined) {
      throw Error(
        `Property ${subject} has no datatype: ${resource.debugValueSummary()}`,
      );
    }

    const shortname = resource.get(core.properties.shortname);

    if (shortname === undefined) {
      throw Error(
        `Property ${subject} has no shortname: ${resource.debugValueSummary()}`,
      );
    }

    const description = resource.get(core.properties.description);

    if (description === undefined) {
      throw Error(
        `Property ${subject} has no description: ${resource.debugValueSummary()}`,
      );
    }

    const classTypeURL = resource.get(core.properties.classtype)?.toString();

    const propery: Property = {
      subject,
      classType: classTypeURL,
      shortname: shortname.toString(),
      description: description.toString(),
      datatype: datatypeFromUrl(datatypeUrl.toString()),
      allowsOnly: resource.get(core.properties.allowsOnly),
    };

    return propery;
  }

  /**
   * This is called when Errors occur in some of the library functions.
   */
  public notifyError(e: Error | string): void {
    const error = e instanceof Error ? e : new Error(e);

    if (this.eventManager.hasSubscriptions(StoreEvents.Error)) {
      this.eventManager.emit(StoreEvents.Error, error);
    } else {
      throw error;
    }
  }

  /**
   * Whether the Store has an active WebSocket connection to the server.
   * Use this to decide whether to attempt server operations or store locally.
   */
  public get serverConnected(): boolean {
    return this._serverConnected;
  }

  /** Called by WebSocket client when connection state changes. */
  public setServerConnected(connected: boolean, error?: string): void {
    const nextError = connected ? undefined : error;

    if (
      this._serverConnected === connected &&
      this._serverConnectionError === nextError
    ) {
      return;
    }

    this._serverConnected = connected;
    this._serverConnectionError = nextError;

    if (!connected) {
      this._driveSyncInProgress = false;
    }

    console.info(`[Store] Server ${connected ? 'connected' : 'disconnected'}`);
    this.eventManager.emit(StoreEvents.ConnectionChanged, connected);
    this.emitSyncStatus();

    // Reconnect orchestration (auth → drain → VVSync → refetch) lives in
    // `WSClient.handleOpen`. Firing `syncDirtyResources` and
    // `refetchOfflineErroredResources` here would re-do the drain (the
    // outbox guard absorbs it) and race the refetch with the WS handshake.
    // Letting handleOpen own the sequence keeps one chain to reason about.
  }

  /**
   * When coming back online, re-fetch resources whose state was affected by
   * being offline:
   *   - errored with our `Offline:` marker (surfaced by the fallback path), or
   *   - still stuck in `loading=true` (fetch started but never completed,
   *     e.g. because the server went down mid-flight).
   *
   * Skips resources with pending commits — those are still in the outbox or
   * mid-drain; pulling a fresh server copy while a push is in flight races
   * the SYNC_PUSH echo and shows the user the pre-edit state until the echo
   * lands.
   *
   * Called from `WSClient.handleOpen` AFTER the outbox drain completes.
   */
  public refetchOfflineErroredResources(): void {
    for (const [subject, resource] of this.resources.entries()) {
      if (resource.hasPendingCommits) continue;
      const erroredOffline =
        resource.error && resource.error.message.startsWith('Offline:');
      const stuckLoading = resource.loading && !resource.new;
      if (!erroredOffline && !stuckLoading) continue;

      resource.error = undefined;
      resource.loading = true;
      this.notify(resource);
      // On error, flip loading back so the resource isn't permanently
      // stuck in the loading state — `fetchResourceFromServer`'s own
      // applyIncoming path handles success.
      this.fetchResourceFromServer(subject).catch(e => {
        const r = this.resources.get(subject);

        if (r) {
          r.loading = false;
          r.setError(e instanceof Error ? e : new Error(String(e)));
          this.notify(r);
        }
      });
    }
  }

  public startDriveSync(): void {
    this._driveSyncInProgress = true;
    this.emitSyncStatus();
  }

  public finishDriveSync(
    drive: string,
    count: number,
    timestamp: number,
  ): void {
    this._driveSyncInProgress = false;
    this._lastDriveSync = { drive, count, timestamp };
    this.emitSyncStatus();
  }

  /** True once any drive sync has finished in this session. Used by
   * collection queries to decide whether an empty local-DB result is
   * authoritative ("the table has no children") or ambiguous ("the index
   * may not be populated yet"). */
  public hasCompletedDriveSync(): boolean {
    return this._lastDriveSync !== undefined;
  }

  public getSyncStatus(): StoreSyncStatus {
    // Saves that succeed first-try go straight to the server — they
    // never touch the outbox, so `outbox.size` alone misses them.
    // Without this, an editor that debounces its save and then exits
    // (Escape/blur) can return to a caller before the in-flight POST
    // completes; the next interaction races the previous commit.
    // Repro: rename-regression "two sequential renames".
    let inFlightSaves = 0;

    for (const r of this.resources.values()) {
      if (r.isSaving) inFlightSaves++;
    }

    return {
      serverConnected: this._serverConnected,
      serverConnectionError: this._serverConnectionError,
      syncInProgress:
        this._driveSyncInProgress ||
        this.outbox.isDraining ||
        inFlightSaves > 0,
      pendingDirtyCount: this.outbox.size + inFlightSaves,
      serverUrl: this.serverUrl,
      drive: this.drive,
      clientDbReady: this.clientDb?.isReady ?? false,
      clientDbAttached: !!this.clientDb,
      clientDbError: this.clientDb?.initError?.message,
      lastDriveSync: this._lastDriveSync,
    };
  }

  public async notifyResourceSaved(resource: Resource): Promise<void> {
    await this.eventManager.emit(StoreEvents.ResourceSaved, resource);
  }

  public async notifyResourceManuallyCreated(
    resource: Resource,
  ): Promise<void> {
    const now = Date.now();
    // Prune stale entries: anything older than the longest plausible
    // consume window (5× the default 2s). Otherwise unsubscribed
    // creations accumulate forever — small leak in practice but
    // visible under fuzzing/bulk-creation tests.
    const cutoff = now - 10_000;

    for (const [subject, ts] of this.recentlyCreatedSubjects) {
      if (ts < cutoff) this.recentlyCreatedSubjects.delete(subject);
    }

    this.recentlyCreatedSubjects.set(resource.subject, now);
    await this.eventManager.emit(StoreEvents.ResourceManuallyCreated, resource);
  }

  /**
   * Returns true and clears the flag if {@link notifyResourceManuallyCreated}
   * fired for this subject within `windowMs`. Call from `useEffect` on mount
   * (not `useState`) — this mutates store state and is not safe to run during
   * render. The clear means only the first caller wins, which is fine for the
   * one-of-many-mounts race this is meant to plug.
   */
  public consumeRecentlyCreated(subject: string, windowMs = 2000): boolean {
    const ts = this.recentlyCreatedSubjects.get(subject);
    if (ts === undefined) return false;
    this.recentlyCreatedSubjects.delete(subject);

    return Date.now() - ts <= windowMs;
  }

  /** Parses the HTML document for `JSON-AD` data in <meta> tags, adds it to the store */
  public parseMetaTags(): void {
    const metaTags = document.querySelectorAll(
      'meta[property="json-ad-initial"]',
    );
    const parser = new JSONADParser();

    metaTags.forEach(tag => {
      const content = tag.getAttribute('content');

      if (content === null) {
        return;
      }

      // Decode base64 content safely as UTF-8
      const jsonString = new TextDecoder().decode(
        Uint8Array.from(atob(content), c => c.charCodeAt(0)),
      );
      const json = JSON.parse(jsonString);
      for (const r of parser.parse(json)) this.addResource(r);
    });
  }

  /**
   * Fetches all Classes and Properties from your current server, including external resources.
   * This helps to speed up time to interactive, but may not be necessary for all applications.
   */
  public async preloadPropsAndClasses(): Promise<void> {
    // TODO: use some sort of CollectionBuilder for this.
    await Promise.all([
      this.fetchResourceFromServer(this.buildPreloadUrl('/classes')),
      this.fetchResourceFromServer(this.buildPreloadUrl('/properties')),
    ]);
  }

  /** Sends an HTTP POST request to the server to the Subject. Parses the returned Resource and adds it to the store. */
  public async postToServer<R extends OptionalClass = Server.EndpointResponse>(
    url: string,
    data?: ArrayBuffer | string,
  ): Promise<Resource<R>> {
    return this.fetchResourceFromServer(url, {
      body: data,
      noWebSocket: true,
      method: 'POST',
    });
  }

  /** Build a `/classes` or `/properties` preload URL with the
   *  `include_external + include_nested + page_size=999` triple
   *  every preload uses. */
  private buildPreloadUrl(path: string): string {
    const url = new URL(path, this.serverUrl);
    url.searchParams.set('include_external', 'true');
    url.searchParams.set('include_nested', 'true');
    url.searchParams.set('page_size', '999');

    return url.toString();
  }

  /** Removes resource from this store, does not delete it from the server, use `resource.destroy()` to delete it from the server. */
  public removeResource(subjectRaw: string, shouldNotify = true): void {
    const resolved = this.resolveSubject(subjectRaw);

    // Tombstone in ClientDb (OPFS) so the resource doesn't reappear after a
    // page reload. The in-memory `resources` map is wiped on reload, but the
    // WASM DB persists; without this, cascade-deleted children survive
    // restart and re-render. Fire-and-forget — the worker queues writes.
    if (this.clientDb) {
      void this.clientDb.removeResource(resolved).catch(() => undefined);
    }

    if (this.resources.delete(resolved)) {
      this.localSearch.removeResource(resolved);

      if (shouldNotify) {
        this.eventManager.emit(StoreEvents.ResourceRemoved, subjectRaw);
      }
    }
  }

  /**
   * Changes the Subject of a Resource. Checks if the new name is already taken,
   * errors if so.
   */
  public async renameSubject(
    resource: Resource,
    newSubjectRaw: string,
  ): Promise<void> {
    const newSubject = this.normalizeSubject(newSubjectRaw);
    Client.tryValidSubject(newSubject);
    const oldSubject = this.normalizeSubject(resource.subject);

    if (await this.checkSubjectTaken(newSubject)) {
      throw Error(`New subject name is already taken: ${newSubject}`);
    }

    resource.setSubject(newSubject);

    const subs = this.subscribers.get(oldSubject) ?? [];
    this.subscribers.set(newSubject, subs);
    this.removeResource(oldSubject);

    this.addResource(resource);
  }

  /**
   * Sets the current Agent, used for signing commits. Authenticates all open
   * websockets, and retries previously failed fetches.
   *
   * Warning: doing this stores the Private Key of the Agent in memory. This
   * might have security implications for your application.
   */
  public setAgent(agent: Agent | undefined): void {
    this.agent = agent;

    if (agent && agent.subject) {
      if (hasBrowserAPI()) {
        // Fire-and-forget here: this is a side effect on agent change,
        // not a precondition of a specific request. The HTTP request
        // path (`Client.fetchResourceHTTP`) re-installs the cookie if
        // it's missing, and awaits it there.
        setCookieAuthentication(this.serverUrl, agent).catch(() => undefined);
      }

      this.webSockets.forEach(ws => {
        ws.authenticate(true).catch(e => {
          this.notifyError(e);
        });
      });
    } else {
      if (hasBrowserAPI()) {
        removeCookieAuthentication();
      }
    }

    this.eventManager.emit(StoreEvents.AgentChanged, agent);
  }

  /** Sets the Server base URL, without the trailing slash. */
  public setServerUrl(url: string): void {
    Client.tryValidSubject(url);

    if (url.substring(-1) === '/') {
      throw Error('baseUrl should not have a trailing slash');
    }

    this.serverUrl = url;
    this.eventManager.emit(StoreEvents.ServerURLChanged, url);

    if (supportsWebSockets()) {
      const userDisconnected =
        typeof localStorage !== 'undefined' &&
        localStorage.getItem('ws-disconnected') === '1';

      if (!userDisconnected) {
        this.openWebSocket(url);
      }
    }
  }

  /** Returns the current Drive subject, or `undefined` if no drive
   *  has been selected. Callers must handle the absent case rather
   *  than treat the server URL as a drive — see the type doc on
   *  `private drive` for why. */
  public getDrive(): string | undefined {
    return this.drive;
  }

  /** Sets the current Drive.
   *
   *  Accepts either a drive subject (a DID — the only form that actually
   *  identifies a drive in the index) or an HTTP URL. An HTTP URL is
   *  treated as a *server origin*, not a drive: it updates `serverUrl`
   *  but leaves `this.drive` untouched (i.e. `getDrive()` keeps
   *  returning whatever real drive — possibly `undefined` — was set
   *  before). This split is what prevents the SYNC_VV / encodeSub
   *  paths from running against a bare host URL, which the server's
   *  `collect_drive_subjects` cannot enumerate cheaply.
   *
   *  Both forms still persist to localStorage and fire `DriveChanged`
   *  so AppSettings-style UI mirrors stay in sync.
   */
  public setDrive(drive: string): void {
    const isUrl = drive.startsWith('http://') || drive.startsWith('https://');

    if (isUrl) {
      const url = new URL(drive);
      this.setServerUrl(url.origin);
    } else {
      this.drive = drive;
    }

    if (typeof window !== 'undefined') {
      localStorage.setItem('drive', JSON.stringify(drive));
    }

    this.eventManager.emit(StoreEvents.DriveChanged, drive);
  }

  /** Opens a WebSocket for this Atomic Server URL */
  public openWebSocket(url: string) {
    // Check if we're running in a webbrowser
    if (supportsWebSockets()) {
      if (this.webSockets.has(url)) {
        return;
      }

      this.webSockets.set(url, new WSClient(url, this));
    } else {
      console.warn('WebSockets not supported, no window available');
    }
  }

  /**
   * Force-reconnect to the server by dropping and recreating the WebSocket.
   *
   * Resolves once the new socket is open and `serverConnected` flips back
   * to `true`. Rejects with the connection error if the socket closes or
   * fails before that happens, or if `timeoutMs` elapses with no outcome.
   *
   * Returning a promise lets callers route reconnect failures through the
   * standard `store.notifyError(e)` pipeline (and therefore through the
   * global `StoreEvents.Error` toast) instead of polling sync status to
   * detect the failure themselves.
   */
  public reconnect(timeoutMs = 15000): Promise<void> {
    const url = this.serverUrl;

    if (!url) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let unsub: (() => void) | undefined;
      const timer = setTimeout(() => {
        unsub?.();
        reject(
          new Error(
            `Reconnect to ${url} timed out after ${timeoutMs}ms. Check that the server is running and reachable.`,
          ),
        );
      }, timeoutMs);

      unsub = this.on(StoreEvents.ConnectionChanged, connected => {
        if (connected) {
          clearTimeout(timer);
          unsub?.();
          resolve();
        } else if (this._serverConnectionError) {
          // A disconnect without an error message is the synchronous
          // teardown step below — keep waiting for the real outcome.
          clearTimeout(timer);
          unsub?.();
          reject(new Error(this._serverConnectionError));
        }
      });

      // Tear down + reopen. The `setServerConnected(false)` here fires
      // `ConnectionChanged` with `_serverConnectionError === undefined`,
      // which the listener above ignores.
      const existing = this.webSockets.get(url);

      if (existing) {
        existing.close();
        this.webSockets.delete(url);
      }

      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('ws-disconnected');
      }

      this.setServerConnected(false);
      this.openWebSocket(url);
    });
  }

  /** Close the WebSocket connection. Persists across refresh until reconnect(). */
  public disconnect(): void {
    const existing = this.webSockets.get(this.serverUrl);

    if (existing) {
      existing.close();
      this.webSockets.delete(this.serverUrl);
    }

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('ws-disconnected', '1');
    }
  }

  /**
   * Subscribe to changes for a resource. The callback fires on every
   * `notify` for that subject (local commits + remote pushes).
   * Returns an unsubscriber. Per-property subscriptions are handled
   * separately by `Resource.on(ResourceEvents.LocalChange)`.
   */
  public subscribe(subject: string, callback: ResourceCallback): () => void {
    if (subject === undefined) {
      throw Error('Cannot subscribe to undefined subject');
    }

    const normalized = this.normalizeSubject(subject);

    return this.addLoroSubscriber(this.subscribers, normalized, callback, () =>
      this.subscribeWebSocket(normalized),
    );
  }

  /** v2 uses drive-level WS subscriptions — every resource in the drive
   *  is delivered through the single `SUB <drive>` sent in
   *  {@link WSClient.handleOpen}. The server's `CommitMonitor` fans
   *  CommitMessages out to drive subscribers when the commit's target
   *  lives under that drive. This per-resource entry-point is kept as
   *  a no-op for API stability — callers don't need to gate themselves.
   *  The lookup confirms the origin's WS exists. */
  public subscribeWebSocket(subject: string): void {
    if (!this._serverConnected) return;
    const normalized = this.normalizeSubject(subject);

    if (
      normalized === unknownSubject ||
      normalized.includes('/commits/') ||
      normalized.startsWith('did:ad:commit:')
    ) {
      return;
    }

    try {
      this.getWebSocketForSubject(subject);
    } catch (e) {
      console.error(e);
    }
  }

  // === Loro CRDT Sync ===

  /** Add `callback` to `map[subject]` and return an unsubscriber.
   *  `onFirstAdd` fires when the list goes 0 → 1 (per-subject WS
   *  subscribe). `onLastRemove` fires when it goes 1 → 0 (WS
   *  unsubscribe). Used by both Loro sync and Loro ephemeral
   *  channels — same shape, different transport hooks. */
  private addLoroSubscriber<T>(
    map: Map<string, T[]>,
    subject: string,
    callback: T,
    onFirstAdd?: () => void,
    onLastRemove?: () => void,
  ): () => void {
    const existing = map.get(subject);

    if (existing) {
      existing.push(callback);
    } else {
      map.set(subject, [callback]);
      onFirstAdd?.();
    }

    return () => {
      const subs = map.get(subject);
      if (!subs) return;
      const filtered = subs.filter(c => c !== callback);

      if (filtered.length === 0) {
        map.delete(subject);
        onLastRemove?.();
      } else {
        map.set(subject, filtered);
      }
    };
  }

  private dispatchLoroMessage<T extends (update: Uint8Array) => void>(
    map: Map<string, T[]>,
    message: string,
  ): void {
    let subject: string;
    let update: string;

    try {
      const parsed = JSON.parse(message) as {
        subject: string;
        update: string;
      };
      subject = parsed.subject;
      update = parsed.update;
    } catch (e) {
      // Malformed text frame (off-by-one slice on the receive side
      // used to produce \"E {...}\" — fixed in websockets.ts but
      // keeping this catch so a future format drift can't break
      // the WS message pump). Bytes are dropped; the CRDT keeps
      // its own state and re-syncs on next exchange.
      console.warn('[Loro] dispatch parse failed:', e);

      return;
    }

    const subs = map.get(subject);
    if (!subs) return;
    const bytes = decodeB64(update);
    subs.forEach(cb => cb(bytes));
  }

  /**
   * Subscribe to Loro document sync updates for a resource.
   * Real-time CRDT synchronization — persistent changes go through commits.
   * @returns A function to unsubscribe.
   */
  public subscribeLoroSync(
    subject: string,
    callback: LoroSyncCallback,
  ): () => void {
    return this.addLoroSubscriber(
      this.loroSyncSubscribers,
      subject,
      callback,
      () => {
        if (this._serverConnected) {
          this.getWebSocketForSubject(subject)?.subscribeLoroSync(subject);
        }
      },
      () => {
        if (this._serverConnected) {
          this.getWebSocketForSubject(subject)?.unsubscribeLoroSync(subject);
        }
      },
    );
  }

  /** Broadcast a Loro document update to all peers via WebSocket.
   *  Non-persistent real-time; persistence is via commits. */
  public broadcastLoroSyncUpdate(subject: string, update: Uint8Array): void {
    if (!this._serverConnected) return;
    this.getWebSocketForSubject(subject)?.sendLoroSyncUpdate(
      JSON.stringify({ subject, update: encodeB64(update) }),
    );
  }

  /** Subscribe to Loro ephemeral updates (cursors, presence). */
  public subscribeLoroEphemeral(
    subject: string,
    callback: LoroEphemeralCallback,
  ): () => void {
    return this.addLoroSubscriber(
      this.loroEphemeralSubscribers,
      subject,
      callback,
    );
  }

  /** Broadcast a Loro ephemeral update (cursors, presence) to peers. */
  public broadcastLoroEphemeralUpdate(
    subject: string,
    update: Uint8Array,
  ): void {
    if (!this._serverConnected) return;
    this.getWebSocketForSubject(subject)?.sendLoroEphemeralUpdate(
      JSON.stringify({ subject, update: encodeB64(update) }),
    );
  }

  public getLoroSyncSubjects(): string[] {
    return Array.from(this.loroSyncSubscribers.keys());
  }

  public getLoroEphemeralSubjects(): string[] {
    return Array.from(this.loroEphemeralSubscribers.keys());
  }

  /** @internal */
  public __handleLoroSyncMessage(message: string): void {
    this.dispatchLoroMessage(this.loroSyncSubscribers, message);
  }

  /** @internal */
  public __handleLoroEphemeralMessage(message: string): void {
    this.dispatchLoroMessage(this.loroEphemeralSubscribers, message);
  }

  /** Unregisters the callback (see `subscribe()`) */
  public unsubscribe(subject: string, callback: ResourceCallback): void {
    if (subject === undefined) return;
    const normalized = this.normalizeSubject(subject);
    const subs = this.subscribers.get(normalized);
    if (!subs) return;
    const filtered = subs.filter(cb => cb !== callback);
    if (filtered.length === 0) this.subscribers.delete(normalized);
    else this.subscribers.set(normalized, filtered);
  }

  public on<T extends StoreEvents>(event: T, callback: StoreEventHandlers[T]) {
    return this.eventManager.register(event, callback);
  }

  private emitSyncStatus(): void {
    this.eventManager.emit(StoreEvents.SyncStatusChanged, this.getSyncStatus());
  }

  private pushCommitLog(entry: Omit<CommitLogEntry, 'id'>): void {
    // Dedup by commitId so a `pending` entry transitions in place to `sent` /
    // `failed` once the push resolves, rather than producing two rows for the
    // same commit. Incoming commits without an outgoing pending counterpart
    // simply prepend.
    const existingIdx = entry.commitId
      ? this._commitLog.findIndex(e => e.commitId === entry.commitId)
      : -1;

    if (existingIdx >= 0) {
      // Status transition for an already-logged commit. Two things
      // matter: (1) reuse the original \`propertySummaries\` —
      // \`summarizeCommitProperties\` is destructive on the second
      // call (it stored the snapshot as the prior baseline; the
      // second pass diffs the snapshot against itself → empty); (2)
      // move the merged entry to the top so users see fresh status
      // changes on the right side of the activity log.
      const prior = this._commitLog[existingIdx];
      const merged: CommitLogEntry = {
        ...prior,
        ...entry,
        propertySummaries: prior.propertySummaries,
      };
      this._commitLog = [
        merged,
        ...this._commitLog.slice(0, existingIdx),
        ...this._commitLog.slice(existingIdx + 1),
      ];
    } else {
      this._commitLog = [{ ...entry, id: ulid() }, ...this._commitLog].slice(
        0,
        50,
      );
    }

    this.eventManager.emit(StoreEvents.CommitLogChanged, this.getCommitLog());
  }

  /** Build a commit-log entry with the fields shared across every
   *  status / direction (subject, signer, prev, derived commitId,
   *  flags, summary). Per-status extras (server-supplied commitId,
   *  error message) come in via `extras`. */
  private buildCommitLogEntry(
    commit: Commit,
    direction: 'incoming' | 'outgoing',
    status: CommitLogEntry['status'],
    extras: { commitId?: string; error?: string } = {},
  ): Omit<CommitLogEntry, 'id'> {
    return {
      timestamp: Date.now(),
      direction,
      status,
      subject: commit.subject,
      signer: commit.signer,
      previousCommit: commit.previousCommit,
      commitId:
        extras.commitId ??
        (commit.signature ? `did:ad:commit:${commit.signature}` : undefined),
      hasLoroUpdate: !!commit.loroUpdate,
      destroy: !!commit.destroy,
      summary: this.summarizeCommit(commit),
      propertySummaries: this.summarizeCommitProperties(commit),
      ...(extras.error !== undefined ? { error: extras.error } : {}),
    };
  }

  /**
   * Records a locally-signed but not-yet-pushed commit as `pending` in the
   * commit log. When the push resolves, {@link postCommit} reuses the same
   * `commitId` so the entry transitions in place to `sent` or `failed`.
   */
  public logPendingCommit(commit: Commit): void {
    this.pushCommitLog(this.buildCommitLogEntry(commit, 'outgoing', 'pending'));
  }

  private summarizeCommit(commit: Commit): string {
    const parts: string[] = [];

    if (commit.destroy) {
      parts.push('destroy');
    } else if (!commit.previousCommit) {
      parts.push('created');
    } else {
      parts.push('updated');
    }

    if (commit.loroUpdate) {
      parts.push('(loro)');
    }

    return parts.join(' ');
  }

  /**
   * Diff this commit's loro snapshot against the previous one we logged for
   * the same subject. Only properties that differ — added, modified, removed
   * — are emitted. Genesis commits (no prior) treat every property as
   * `changed`. Returning an empty list is itself useful debug info: it means
   * the commit's snapshot has identical contents to the previous one, which
   * usually points to a duplicate-send or a UI that signed without a real
   * change.
   *
   * `pushCommitLog` is responsible for not stomping a real summary on a
   * status transition; this method always recomputes against the stored
   * baseline.
   */
  private summarizeCommitProperties(
    commit: Commit,
  ): CommitLogPropertySummary[] | undefined {
    if (!commit.loroUpdate) {
      return undefined;
    }

    try {
      const materialized = new Resource(commit.subject);
      materialized.importLoroUpdate(commit.loroUpdate);

      const currentEntries = new Map<string, JSONValue>();

      for (const [prop, value] of materialized.getEntries()) {
        if (
          prop === commits.properties.loroUpdate ||
          prop === commits.properties.lastCommit
        ) {
          continue;
        }

        currentEntries.set(prop, value as JSONValue);
      }

      const priorBytes = this._commitLogPriorSnapshots.get(commit.subject);
      const priorEntries = new Map<string, JSONValue>();

      if (priorBytes) {
        try {
          const prior = new Resource(commit.subject);
          prior.importLoroUpdate(priorBytes);

          for (const [prop, value] of prior.getEntries()) {
            if (
              prop === commits.properties.loroUpdate ||
              prop === commits.properties.lastCommit
            ) {
              continue;
            }

            priorEntries.set(prop, value as JSONValue);
          }
        } catch (e) {
          console.warn('[summarizeCommitProperties] prior decode failed:', e);
        }
      }

      const summaries: CommitLogPropertySummary[] = [];

      for (const [prop, value] of currentEntries) {
        const before = priorEntries.get(prop);

        if (!commitLogValuesEqual(before, value)) {
          summaries.push({ property: prop, value, changeType: 'changed' });
        }
      }

      for (const [prop] of priorEntries) {
        if (!currentEntries.has(prop)) {
          summaries.push({
            property: prop,
            value: null as unknown as JSONValue,
            changeType: 'removed',
          });
        }
      }

      this._commitLogPriorSnapshots.set(commit.subject, commit.loroUpdate);

      return summaries.length > 0 ? summaries.slice(0, 20) : undefined;
    } catch (e) {
      console.warn('[summarizeCommitProperties] failed:', e);

      return undefined;
    }
  }

  /**
   * If the resource carries a `blob` reference, push the locally-stored bytes
   * to the server. Prefers the WS `BLOB_RESPONSE` fast path; falls back to
   * `PUT /blob/<hash>` over HTTP when the WS isn't open. Without the HTTP
   * fallback the server keeps the resource but never receives the bytes, so
   * `/download/files/<hash>` returns 404 — matching {@link postCommit}'s
   * transport (also HTTP) keeps both halves of an upload reliable.
   *
   * No-op if there's no clientDb (HTTP `/upload` already wrote the bytes
   * server-side) or no local copy of the bytes.
   *
   * Called from {@link Resource.pushCommits} on every successful commit push,
   * so the bytes get sent both on initial save AND after `syncDirtyResources`
   * flushes commits that were queued while offline.
   */
  public async maybePushBlobForResource(resource: Resource): Promise<void> {
    if (!this.clientDb) return;

    const blobValue = resource.get(BLOB);
    if (typeof blobValue !== 'string') return;
    const prefix = 'did:ad:blob:';
    if (!blobValue.startsWith(prefix)) return;
    const hashHex = blobValue.slice(prefix.length);

    let hashBytes: Uint8Array;

    try {
      hashBytes = hexToBytes(hashHex);
    } catch {
      return;
    }

    if (hashBytes.length !== 32) return;

    let bytes: Uint8Array | null = null;

    try {
      bytes = await this.clientDb.getBlob(hashBytes);
    } catch {
      return;
    }

    if (!bytes) return;

    // HTTP PUT is the source of truth for blob delivery. Storage is content-
    // addressed and idempotent, so re-posting is a no-op. The WS BLOB_RESPONSE
    // path can drop frames when the connection closes mid-flight (e.g. server
    // heartbeat timeout right after `send()`), leaving the bytes "sent" from
    // the client's POV but never landing on the server. Subsequent commits
    // that depend on the blob (Plugin install reading the zip) then fail
    // server-side. Use the durable HTTP path; awaiting completion serializes
    // it with downstream commits.
    const url = `${this.getServerUrl()}/blob/${hashHex}`;
    await fetch(url, {
      method: 'PUT',
      // Cast: TS lib.dom marks Uint8Array<SharedArrayBuffer> incompatible with
      // BodyInit/BlobPart; at runtime our bytes are ArrayBuffer-backed.
      body: bytes as unknown as BodyInit,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  public logIncomingCommit(commit: Commit): void {
    this.pushCommitLog(
      this.buildCommitLogEntry(commit, 'incoming', 'received'),
    );
  }

  /**
   * Uploads files. The bytes are hashed (BLAKE3), stored in the local blob
   * store, and a `File` resource is created and committed through the normal
   * sync pipeline. The peer (server or another client) receives the resource
   * via Loro sync, sees the BLAKE3 hash, and pulls the bytes via the
   * BLOB_REQUEST/RESPONSE frames. Same path online or offline.
   */
  public async uploadFiles(
    files: FileOrFileLike[],
    parent: string,
  ): Promise<string[]> {
    const agent = this.getAgent();

    if (!agent) {
      throw Error('No agent set, cannot upload files');
    }

    // No local blob store — fall back to multipart POST `/upload`. The
    // server hashes, stores in Tree::Blobs, and creates the File resource
    // for us. Works in any browser (and Node) without WASM. The local-first
    // path below is preferable for offline support, but it's a hard
    // requirement only when ClientDb is attached.
    if (!this.clientDb) {
      const resources = await this.client.uploadFiles(
        files,
        this.getServerUrl(),
        agent,
        parent,
      );
      for (const r of resources) this.addResource(r);
      const subjects: string[] = [];

      for (const r of resources) {
        await this.notifyResourceManuallyCreated(r);
        subjects.push(r.subject);
      }

      return subjects;
    }

    const createdSubjects: string[] = [];
    const useDid =
      this.getAgent()!.subject?.startsWith('did:ad:agent:') ?? false;

    for (const file of files) {
      const blob = 'blob' in file ? file.blob : file;
      const name = file.name;
      const data = new Uint8Array(await blob.arrayBuffer());
      const hashBytes = await this.clientDb.blake3Hash(data);
      const hash = bytesToHex(hashBytes);

      await this.clientDb!.putBlob(hashBytes, data);

      const newSubject = useDid
        ? `_new:${this.randomPart()}`
        : this.createHTTPSubject(parent);

      const resource = this.getResourceLoading(newSubject, {
        newResource: true,
      });

      // All values are produced from trusted code (hashes, fixed property
      // URLs). Skip validation — it would otherwise fetch each property's
      // definition over HTTP, which fails for new properties not yet on
      // atomicdata.dev (e.g. blob).
      await resource.set(core.properties.isA, [server.classes.file], false);
      await resource.set(core.properties.parent, parent, false);
      await resource.set(server.properties.filename, name, false);
      await resource.set(server.properties.filesize, blob.size, false);
      await resource.set(server.properties.mimetype, blob.type, false);
      await resource.set(INTERNAL_ID, hash, false);
      await resource.set(BLOB, `did:ad:blob:${hash}`, false);
      await resource.set(
        server.properties.downloadUrl,
        `${this.getServerUrl()}/download/files/${hash}`,
        false,
      );

      // For DID resources, sign the genesis commit locally so the placeholder
      // `_new:` subject is replaced with the real `did:ad:` subject derived
      // from the signature, then STASH it on the resource — mirrors
      // `Store.newResource`. `save()` below moves the stashed genesis into
      // the outbox and drains it. (Stashing on the resource rather than
      // enqueuing here means a never-saved upload is never POSTed; here we
      // always `save()`, but the genesis MUST be stashed or `save()` has
      // nothing to POST — `signChanges` resets `commitBuilder.isGenesis`,
      // so the genesis would otherwise be silently dropped.)
      if (useDid) {
        // `signChanges` auto-detects genesis (DID-eligible `_new:` subject,
        // no previousCommit) and derives the `did:ad:` subject.
        const genesis = await resource.signChanges(this.getAgent()!);
        resource.stashGenesis(genesis);
      }

      await resource.save();
      // The blob bytes are pushed to the server from `Resource.pushCommits`
      // (via `Store.maybePushBlobForResource`) — that path covers both the
      // online-save case here AND the offline → reconnect retry path, where
      // `syncDirtyResources` flushes the queued commits and the same hook
      // fires after the deferred push lands.
      await this.notifyResourceManuallyCreated(resource);
      createdSubjects.push(resource.subject);
    }

    return createdSubjects;
  }

  /** Posts a Commit to some endpoint. Returns the Commit created by the server. */
  public async postCommit(commit: Commit, endpoint: string): Promise<Commit> {
    const close = perfSpan('store.postCommit', {
      genesis: commit.previousCommit === undefined,
    });

    try {
      const created = await this.sendCommit(commit, endpoint);
      close('ok');
      this.pushCommitLog(
        this.buildCommitLogEntry(commit, 'outgoing', 'sent', {
          commitId: commitIdOf(created),
        }),
      );
      // Materialize the just-signed commit as a Resource so subsequent
      // `useResource(commitSubject)` lookups (chatroom <CommitDetail>,
      // version views, etc.) hit the local cache instead of round-
      // tripping back to the server for data we already had in hand.
      // The offline-save branch already does this via
      // `applyPendingCommitsLocally` (resource.ts); the online happy
      // path used to skip it, which produced the `GET did:ad:commit:*`
      // visible in the network log right after posting a chat message.
      this.materializeCommitLocally(created);

      return created;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      close({ err: errMsg });
      // Pass the error through `extras.error`; the derived commitId in
      // `buildCommitLogEntry` matches the prior `pending` entry so it
      // transitions in place rather than producing a second row.
      this.pushCommitLog(
        this.buildCommitLogEntry(commit, 'outgoing', 'failed', {
          error: errMsg,
        }),
      );
      throw e;
    }
  }

  /**
   * Prefer the WebSocket transport when the matching origin's WS is open and
   * authenticated; fall back to HTTP `client.postCommit` otherwise. The WS
   * round-trip lets the server tag the resulting `DbEvent`s with the
   * originating connection id and suppress broadcasting them back — closes
   * the "client gets its own commit as a subscription push" echo. HTTP
   * commits still work; they just always reach every subscriber.
   */
  private async sendCommit(commit: Commit, endpoint: string): Promise<Commit> {
    const ws = this.getWebSocketForEndpoint(endpoint);

    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        return await ws.postCommit(commit);
      } catch (e) {
        // Fall through to HTTP — a broken WS shouldn't block saves while
        // the reconnect timer is still backing off. The WS error already
        // surfaced in console; the HTTP path will produce its own.
        console.warn('[Store.postCommit] WS path failed, using HTTP:', e);
      }
    }

    return this.client.postCommit(commit, endpoint);
  }

  private getWebSocketForEndpoint(endpoint: string): WSClient | undefined {
    try {
      const origin = new URL(endpoint).origin;

      return this.webSockets.get(origin);
    } catch {
      return this.getDefaultWebSocket();
    }
  }

  /**
   * Cache a freshly-signed commit as a Resource in the local store.
   * Idempotent: bails if the commit's subject is already present
   * (e.g. the offline path beat us to it via `applyPendingCommitsLocally`).
   */
  public materializeCommitLocally(commit: Commit): void {
    const signature = commit.signature;
    if (!signature) return;
    const commitSubject = `did:ad:commit:${signature}`;
    if (this.resources.has(commitSubject)) return;

    const commitResource = new Resource(commitSubject);
    commitResource.applyHydratedValues(
      Object.entries(commitToJsonADObject(commit)) as Iterable<
        [string, any] // eslint-disable-line @typescript-eslint/no-explicit-any
      >,
    );
    commitResource.loading = false;
    commitResource.new = false;
    this.applyIncoming({
      subject: commitSubject,
      resource: commitResource,
      source: 'local-post',
    });
  }

  /**
   * Returns the ancestry of a resource, starting with the resource itself.
   */
  public async getResourceAncestry(resource: Resource): Promise<string[]> {
    const ancestry: string[] = [resource.subject];

    let lastAncestor: string = resource.get(core.properties.parent) as string;

    if (lastAncestor) {
      ancestry.push(lastAncestor);
    }

    while (lastAncestor) {
      const lastResource = await this.getResource(lastAncestor);

      if (lastResource) {
        lastAncestor = lastResource.get(core.properties.parent) as string;

        if (lastAncestor === undefined) {
          break;
        }

        if (ancestry.includes(lastAncestor)) {
          throw new Error(
            `Resource ${resource.subject} ancestry is cyclical. ${lastAncestor} is already in the ancestry}`,
          );
        }

        ancestry.push(lastAncestor);
      }
    }

    return ancestry;
  }

  /**
   * Returns a list of resources currently in the store which pass the given filter function.
   * This is a client-side filter, and does not query the server.
   */
  public clientSideQuery(filter: (resource: Resource) => boolean): Resource[] {
    return Array.from(this.resources.values()).filter(filter);
  }

  /**
   * @Internal
   * Add the resource to a batch that is saved when the parent is saved. Only gets saved when the parent is new.
   */
  public batchResource(subject: string) {
    const resource = this._resources.get(subject);

    if (!resource) {
      throw new Error(
        `Resource ${subject} can not be saved because it is not in the store.`,
      );
    }

    const parent = resource.get(core.properties.parent);

    if (parent === undefined) {
      throw new Error(
        `Resource ${subject} can not be added to a batch because it's missing a parent.`,
      );
    }

    if (!this.batchedResources.has(parent)) {
      this.batchedResources.set(parent, new Set([subject]));
    } else {
      this.batchedResources.get(parent)!.add(subject);
    }
  }

  /**
   * @Internal
   * Saves all resources that are in a batch for a parent.
   */
  public async saveBatchForParent(subject: string) {
    const subjects = this.batchedResources.get(subject);

    if (!subjects) return;

    for (const resourceSubject of subjects) {
      const resource = this._resources.get(resourceSubject);

      await resource?.save();
    }

    this.batchedResources.delete(subject);
  }

  public async importJsonAD(
    jsonADString: string,
    options: ImportJsonADOptions,
  ): Promise<void> {
    const url = new URL(endpoints.import, this.serverUrl);
    url.searchParams.set('parent', options.parent);
    url.searchParams.set(
      'overwrite-outside',
      options.overwriteOutside ? 'true' : 'false',
    );

    const result = await this.postToServer(url.toString(), jsonADString);

    if (result.error) {
      throw result.error;
    }
  }

  /**
   * Make sure the given tree of resources are available in the store.
   * This is useful in situations where you need certain resources to be available before rendering a page.
   * For example when rendering on a server that does not wait for resources to be fully available.
   *
   * **Example**:
   * ```ts
   * await store.preloadResourceTree('https://my-website.com', {
   *  [myWebsite.properties.projects]: {
   *    [myWebsite.properties.collaborators]: {
   *      [core.properties.image]: true,
   *    },
   *    [core.properties.image]: true,
   *  },
   * });
   * ```
   */
  public async preloadResourceTree(
    subject: string,
    treeTemplate: ResourceTreeTemplate,
  ): Promise<void> {
    const loadResourceTreeInner = async (
      resource: Resource,
      tree: ResourceTreeTemplate,
    ) => {
      const promises: Promise<unknown>[] = [];

      for (const [property, branch] of Object.entries(tree)) {
        await this.getResource(property);
        const values = normalizeToArray(resource.get(property));
        const resources = await Promise.all(
          values.map(value => this.getResource(value)),
        );

        if (typeof branch === 'boolean') {
          continue;
        }

        for (const res of resources) {
          promises.push(loadResourceTreeInner(res, branch));
        }
      }

      return Promise.allSettled(promises.flat());
    };

    const resource = await this.getResource(subject);

    await loadResourceTreeInner(resource, treeTemplate);
  }

  /** Creates a random HTTP subject under the given parent URL. */
  private createHTTPSubject(parentSubject: string): string {
    return `${parentSubject}/${this.randomPart()}`;
  }

  private randomPart(): string {
    return ulid().toLowerCase();
  }

  private async findAvailableSubject(
    path: string,
    parent: string,
    firstTry = true,
  ): Promise<string> {
    let url = new URL(`${parent}/${path}`).toString();

    if (!firstTry) {
      const randomPart = this.randomPart();
      url += `-${randomPart}`;
    }

    const taken = await this.checkSubjectTaken(url);

    if (taken) {
      return this.findAvailableSubject(path, parent, false);
    }

    return url;
  }

  /** Per-subject snapshot wrappers for `useSyncExternalStore`. Each
   * snapshot's `resource` field is a fresh Proxy of the cached
   * Resource, so `R.foo` reads stay reactive (Resource is mutated
   * in place, but the Proxy identity changes per notify). The
   * snapshot tuple identity changes too, which is what
   * `useSyncExternalStore` checks. */
  private snapshots = new Map<string, { resource: Resource }>();

  public getResourceSnapshot(
    subject: string,
    opts: FetchOpts = {},
  ): { resource: Resource } {
    const r = this.getResourceLoading(subject, opts);
    const key = this.normalizeSubject(r.subject);
    let snap = this.snapshots.get(key);

    if (!snap || snap.resource !== r.__internalObject) {
      snap = { resource: r.__internalObject };
      this.snapshots.set(key, snap);
    }

    return snap;
  }

  /** Lets subscribers know that a resource has been changed. */
  private async notify(resource: Resource): Promise<void> {
    // Bump snapshot tuple identity so `useSyncExternalStore` consumers
    // re-render. The Resource itself is mutated in place, but a fresh
    // outer `{resource}` object is `!== ` the previous one, which is
    // all `Object.is` needs.
    const key = this.normalizeSubject(resource.subject);
    this.snapshots.set(key, { resource: resource.__internalObject });

    this.eventManager.emit(StoreEvents.ResourceUpdated, resource);

    const callbacks = this.subscribers.get(key);
    if (!callbacks) return;
    Promise.allSettled(callbacks.map(async cb => cb(resource)));
  }
}

const normalizeToArray = (value: JSONValue): string[] => {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value as string[];
  }

  return [];
};

/**
 * A Property represents a relationship between a Subject and its Value.
 * https://atomicdata.dev/classes/Property
 */
export interface Property {
  subject: string;
  /** https://atomicdata.dev/properties/datatype */
  datatype: Datatype;
  /** https://atomicdata.dev/properties/shortname */
  shortname: string;
  /** https://atomicdata.dev/properties/description */
  description: string;
  /** https://atomicdata.dev/properties/classType */
  classType?: string;
  /** If the Property cannot be found or parsed, this will contain the error */
  error?: Error;
  /** https://atomicdata.dev/properties/isDynamic */
  isDynamic?: boolean;
  /** When the Property is still awaiting a server response */
  loading?: boolean;
  allowsOnly?: string[];
}

export interface FetchOpts {
  /**
   * If this is true, incomplete resources will not be automatically fetched.
   * Incomplete resources are faster to process server-side, but they need to be
   * fetched again when all properties are needed.
   */
  allowIncomplete?: boolean;
  /** Do not fetch over WebSockets, always fetch over HTTP(S) */
  noWebSocket?: boolean;
  /**
   * If true, will not send a request to a server - it will simply create a new
   * local resource.
   */
  newResource?: boolean;
}

/** Convert a Resource to a JSON-AD string for storage in the WASM DB. */
function resourceToJsonAd(resource: Resource): string | null {
  const obj = resource.toObject({ includeBinary: false });

  return obj ? JSON.stringify(obj) : null;
}
