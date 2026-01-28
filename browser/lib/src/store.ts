import { ulid } from 'ulidx';
import type { Agent } from './agent.js';
import {
  removeCookieAuthentication,
  setCookieAuthentication,
} from './authentication.js';
import { Client, type FileOrFileLike } from './client.js';
import { commitIdOf, parseCommitJSON, type Commit } from './commit.js';
import { datatypeFromUrl, type Datatype } from './datatypes.js';
import { AtomicError, ErrorType } from './error.js';
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
import { LocalOutbox, type OutboxEntry } from './local-outbox.js';

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
  /** True iff EITHER the WS-driven drive sync is mid-handshake OR
   * the outbox is currently draining. */
  syncInProgress: boolean;
  pendingDirtyCount: number;
  serverUrl: string;
  drive: string;
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
  /** The current Drive subject URL */
  private drive: string;
  /** All the resources of the store */
  private _resources: Map<string, Resource>;
  /** Mapping from HTTP aliases to primary subjects (e.g. DIDs) */
  private aliases: Map<string, string> = new Map();

  /** List of resources that have parents that are not saved to the server, when a parent is saved it should also save its children */
  private batchedResources: Map<string, Set<string>> = new Map();

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
  public readonly outbox: LocalOutbox = new LocalOutbox(() =>
    this.emitSyncStatus(),
  );
  /**
   * Whether the Store has an active connection to the server.
   * Driven by WebSocket open/close events. When false, commits are stored
   * locally and synced when the connection is restored.
   */
  private _serverConnected = false;
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

    // Initialize drive from localStorage if available
    if (typeof window !== 'undefined') {
      const storedDrive = localStorage.getItem('drive');
      this.drive = storedDrive
        ? JSON.parse(storedDrive)
        : (opts.serverUrl ?? '');
    } else {
      this.drive = opts.serverUrl ?? '';
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
    this.clientDb = clientDb;
    this.emitSyncStatus();
  }

  /** Returns the ClientDbWorker if one has been set (may still be initializing). */
  public getClientDb(): ClientDbWorker | undefined {
    return this.clientDb;
  }

  public getCommitLog(): CommitLogEntry[] {
    return [...this._commitLog];
  }

  /**
   * Surface a hydrated outbox entry's commits in `_commitLog` as
   * `pending` rows so the Sync page shows what's queued after a
   * reload, not "No activity recorded".
   */
  private hydrateCommitLogFromOutbox(entry: OutboxEntry): void {
    for (const commit of entry.commits) {
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
        postEntry: this.postOutboxEntry,
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
   * Post a single outbox entry to the server. Reuses the existing
   * Resource flow: `save()` if there are still unsaved Loro
   * changes (rare — the outbox entry already holds signed
   * commits), otherwise `pushCommits()`. Throws on failure;
   * `LocalOutbox.drain` records `lastAttemptError` and continues.
   */
  private postOutboxEntry = async (entry: OutboxEntry): Promise<void> => {
    // The outbox entry IS the source of truth for commits we owe the
    // server. Post `entry.commits` directly rather than delegating to
    // `resource.pushCommits()` — that method uses the resource's
    // in-memory `_pendingCommits` list, which is empty after a page
    // reload (the resource was just re-fetched from the server, so its
    // local state has no pending changes). Relying on it silently
    // dropped every offline commit on reload: outbox.drain saw no
    // throw, deleted the entry, and the server never received the
    // edit. sync.spec.ts:177 was the user-visible repro.
    //
    // If the resource has lingering unsaved local changes (rare —
    // typically only when `save()` is called twice in quick succession
    // and the second call hits before the first finished pushing),
    // sign them into commits first so they ride along with the
    // outbox-stored ones.
    const resource = this.resources.get(entry.subject);
    if (resource?.hasUnsavedChanges()) {
      await resource.save();
      // `save()` will have posted everything it could; if it
      // re-queued anything to the outbox the drain will iterate it.
      this.emitSyncStatus();
      return;
    }
    const endpoint = new URL('/commit', this.serverUrl).toString();
    for (const commit of entry.commits) {
      await this.postCommit(commit, endpoint);
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
        allVVs = await this.clientDb.getAllVersionVectors();
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
    resource.importLoroUpdate(change.loroBytes);
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

    // Update local full-text search index.
    if (!resource.loading && !resource.new) {
      this.localSearch.addResource(resource);
    }

    // Atomic put queued BEFORE notify. The worker's serialised
    // queue means a follow-up `queryLocalDb` (e.g. from
    // Collection.refresh in a notify listener) sees the new
    // resource. Skip for new/loading/incomplete/unsynced — those
    // persist themselves via `applyPendingCommitsLocally` or are
    // placeholders.
    if (
      this.clientDb &&
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

    // For DID resources: sign the genesis commit locally to derive the real
    // DID from the signature.  The signed commit is queued on the resource and
    // will be sent to the server on the next `save()` / `push()`.
    if (shouldUseDid && !subject) {
      const agent = this.getAgent();

      if (!agent) {
        throw new Error(
          'Cannot create a DID resource without an agent. Set an agent on the store first.',
        );
      }

      // Explicitly flag as genesis before signing so the commit builder never
      // accidentally produces a genesis commit for a later edit.
      resource.markNextCommitAsGenesis();
      await resource.signChanges(agent);
      // resource.subject is now did:ad:<signature>
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
    // Try local search first if the index has content and no filters are set.
    // Filters (property-value constraints) require server-side Tantivy for now.
    if (this.localSearch.size > 0 && !opts.filters && !opts.parents) {
      const local = this.localSearch.search(query, opts.limit ?? 30);

      if (local.subjects.length > 0) {
        return local.subjects;
      }
    }

    // When offline, return local results (even if empty) — don't hit the server.
    if (!this._serverConnected) {
      return [];
    }

    // Fall back to server search (Tantivy)
    const searchSubject = buildSearchSubject(this.serverUrl, query, opts);
    const searchResource = await this.fetchResourceFromServer(searchSubject, {
      noWebSocket: true,
    });
    const results = searchResource.get(server.properties.results) ?? [];

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
        // Online with local data — show local first, but background-verify
        // with the server. If the resource was deleted while we were away
        // (cascade delete, destroy commit while disconnected), the server
        // will return 404 and we evict from local cache. WS COMMIT updates
        // handle the live case; this handles the cold-load case.
        void this.fetchResourceFromServer(subject, opts).catch(e => {
          // Cover both HTTP 404 (ErrorType.NotFound) and WS error frames
          // (ErrorType.Server with a "not found" message). When the
          // resource is gone server-side, mark the local Resource with the
          // server's error so subscribed UI re-renders into the
          // "Resource not found" state instead of keeping stale data.
          const message: string = e?.message ?? '';

          if (
            e instanceof AtomicError &&
            (e.type === ErrorType.NotFound || /not found/i.test(message))
          ) {
            this.failResource(
              subject,
              new AtomicError(
                `Resource ${subject} not found on server`,
                ErrorType.NotFound,
              ),
            );
          }
        });
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

    // Offline-created resources keep their genesis commit in `_pendingCommits`
    // until the next reconnect, when `syncDirtyResources` drains it via
    // `pushCommits`. Replacing the in-memory instance with a fresh one from
    // clientDb wipes the queue — so the dirty subject gets "Synced" with an
    // empty queue, no /commit POST fires, the server never sees the resource,
    // and `/download/files/<hash>` keeps returning 404 even after reconnect.
    if (existing?.hasPendingCommits) {
      return true;
    }

    // Same problem after a page reload: the in-memory queue is gone, but
    // the outbox persisted it durably. Re-attach the queue to the
    // freshly hydrated instance so the next sync can push.
    const restoredCommits = this.outbox.getEntry(subject)?.commits;

    this.hydrateOfflineReplay(subject, parsed);

    // Re-attach restored commits AFTER hydrateOfflineReplay because the
    // ingress may merge the new instance into an existing placeholder
    // (created by getResourceLoading); merge() carries Loro/cache state
    // but not `_pendingCommits`, so writing them on the freshly-built
    // resource wouldn't survive. Pull the canonical instance back out
    // and patch it.
    if (restoredCommits?.length) {
      this.getResolved(subject)?.setPendingCommits([...restoredCommits]);
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
  public setServerConnected(connected: boolean): void {
    if (this._serverConnected === connected) return;

    this._serverConnected = connected;
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
    return {
      serverConnected: this._serverConnected,
      syncInProgress: this._driveSyncInProgress || this.outbox.isDraining,
      pendingDirtyCount: this.outbox.size,
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

  /** Returns the current Drive subject URL */
  public getDrive(): string {
    return this.drive;
  }

  /** Sets the current Drive and persists it to localStorage */
  public setDrive(drive: string): void {
    this.drive = drive;

    if (typeof window !== 'undefined') {
      localStorage.setItem('drive', JSON.stringify(drive));
    }

    // If the drive is an HTTP URL, also update the server URL
    if (drive.startsWith('http://') || drive.startsWith('https://')) {
      const url = new URL(drive);
      this.setServerUrl(url.origin);
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

  /** Force-reconnect to the server by dropping and recreating the WebSocket. */
  public reconnect(): void {
    const url = this.serverUrl;

    if (!url) return;

    // Close existing WebSocket
    const existing = this.webSockets.get(url);

    if (existing) {
      existing.close();
      this.webSockets.delete(url);
    }

    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('ws-disconnected');
    }

    this.openWebSocket(url);
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

  /** v2 uses drive-level WS subscriptions, so per-resource subscribe
   *  is a no-op kept for API stability — callers don't need to gate
   *  themselves. The lookup confirms the origin's WS exists. */
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
      // from the signature. Mirrors `Store.newResource` behavior.
      if (useDid) {
        resource.markNextCommitAsGenesis();
        await resource.signChanges(this.getAgent()!);
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
      const created = await this.client.postCommit(commit, endpoint);
      close('ok');
      this.pushCommitLog(
        this.buildCommitLogEntry(commit, 'outgoing', 'sent', {
          commitId: commitIdOf(created),
        }),
      );
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
