import { ulid } from 'ulidx';
import type { Agent } from './agent.js';
import {
  removeCookieAuthentication,
  setCookieAuthentication,
} from './authentication.js';
import { Client, type FileOrFileLike } from './client.js';
import { parseCommitJSON, type Commit } from './commit.js';
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
import { Resource, unknownSubject, type ResourceSource } from './resource.js';
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
import { OpfsPersistor } from './opfs-persistor.js';
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
  driveSyncInProgress: boolean;
  dirtySyncInProgress: boolean;
  syncInProgress: boolean;
  pendingDirtyCount: number;
  pendingDirtySubjects: string[];
  serverUrl: string;
  drive: string;
  websocketReadyState?: number;
  websocketProtocol?: string;
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

/**
 * Where a {@link IncomingChange} came from. Carried through to the
 * resource's `source` field and to listeners so collection-membership
 * updates and React subscribers can decide whether they care.
 *
 * This is the *one* enum that distinguishes ingress paths. The set
 * is deliberately small — adding a new ingress is one new variant
 * here plus one call site, not a new code path through 4 files.
 */
export type ChangeSource =
  /** Response to our own `WSClient.fetch(subject)` GET. */
  | 'ws-pending-get'
  /** Subscription push from another client (or our own commit echo). */
  | 'ws-sub-push'
  /** Drive sync delta — bulk-applied during reconnect handshake. */
  | 'ws-sync-push'
  /** `QUERY_UPDATE` push announcing a collection membership change. */
  | 'ws-query-update'
  /** Resource arrived via the HTTP fallback (`Client.fetchResourceHTTP`). */
  | 'http-fetch'
  /** Local commit signed and added to in-memory state, not yet POSTed. */
  | 'local-pre-push'
  /** Server `POST /commit` returned `200`; commit is durable upstream. */
  | 'local-acked'
  /** Outbox replay of a commit signed in a previous session. */
  | 'offline-replay';

/**
 * One authoritative-or-local update to a resource, in either Loro or
 * JSON-AD wire form. The single ingress used by every code path that
 * learns of a new version of a resource.
 *
 * Before: WS UPDATE / SYNC_PUSH / QUERY_UPDATE / pending-GET / HTTP
 * fetch / local commit pre-/post-POST / offline replay each had their
 * own bespoke setup (`setSource`, `setSourceTimestamp`, `loading=false`,
 * conditional `addResources({skipCommitCompare})`, optional
 * `persistToClientDb`, ad-hoc echo detection). 9 ingress paths, 4
 * echo-detection schemes.
 *
 * After: every path constructs an `IncomingChange` and calls
 * {@link Store.applyIncoming}. Subject normalisation, commit-id
 * dedup, persistence, and notification happen in one place with one
 * ordering contract.
 */
export interface IncomingChange {
  subject: string;
  /** Loro snapshot or delta — exclusive with {@link jsonAd}. */
  loroBytes?: Uint8Array;
  /** JSON-AD payload — exclusive with {@link loroBytes}. Used for
   * the HTTP fetch path where the server returns JSON-AD. */
  jsonAd?: string;
  /** `did:ad:commit:<sig>` of the commit that produced this state.
   * Used for echo dedup: a change whose commitId equals the cached
   * resource's `lastCommit` is a no-op. */
  commitId?: string;
  source: ChangeSource;
  /** Defaults to `Date.now()` when omitted. */
  receivedAt?: number;
  /** Force notify even if dedup says it's an echo. Reserved for
   * paths that intentionally re-trigger UI (e.g. resource-renamed
   * post-genesis). Default false. */
  forceNotify?: boolean;
}

/** Returns True if the client has WebSocket support */
const supportsWebSockets = () => typeof WebSocket !== 'undefined';

/**
 * Map the {@link ChangeSource} (the ingress-path enum we own here)
 * onto {@link ResourceSource} (the legacy field on `Resource`). Kept
 * one-way so future `Resource` consumers see a stable enum, while
 * we evolve the more granular `ChangeSource` for ingress dedup +
 * telemetry purposes.
 */
function mapChangeSourceToResourceSource(s: ChangeSource): ResourceSource {
  switch (s) {
    case 'ws-pending-get':
    case 'ws-sub-push':
      return 'server-ws';
    case 'ws-sync-push':
      return 'ws-sync';
    case 'ws-query-update':
      return 'server-ws';
    case 'http-fetch':
      return 'server-http';
    case 'local-pre-push':
    case 'local-acked':
      return 'created';
    case 'offline-replay':
      return 'local-cache';
  }
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
  /**
   /** The base URL of an Atomic Server. This is where to send commits, create new
    * instances, search, etc.
    */
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
  /**
   * Single chokepoint for every OPFS write. Created lazily in
   * `setClientDb` and held until the worker is replaced. Read paths
   * still use `clientDb` directly (see `queryLocalDb`); writes go
   * through this so the JSON-AD/Loro-snapshot pair lands atomically.
   */
  private persistor?: OpfsPersistor;
  /** Client-side full-text search index (MiniSearch). */
  private localSearch = new LocalSearch();
  /**
   * Single durable queue of "writes that haven't reached the
   * server". Replaces the old quartet (`dirtyForSync` Set,
   * `atomic.dirtyForSync` localStorage key,
   * `atomic.offline.<subject>` per-subject keys, and the
   * `_lastLocalSignature` reload-amnesia footgun). On construction
   * the outbox migrates from the legacy keys, then the legacy keys
   * are removed.
   */
  public readonly outbox: LocalOutbox = new LocalOutbox();
  /**
   * Whether the Store has an active connection to the server.
   * Driven by WebSocket open/close events. When false, commits are stored
   * locally and synced when the connection is restored.
   */
  private _serverConnected = false;
  private _driveSyncInProgress = false;
  private _dirtySyncInProgress = false;
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
    this.persistor = new OpfsPersistor(clientDb);
    this.emitSyncStatus();
  }

  /** Returns the ClientDbWorker if one has been set (may still be initializing). */
  public getClientDb(): ClientDbWorker | undefined {
    return this.clientDb;
  }

  /**
   * Returns the OPFS write chokepoint — present iff a `clientDb`
   * is attached. Prefer this over `getClientDb()` for any path
   * that writes to OPFS; reads still go through `getClientDb()`
   * for now (read-side migration is its own step).
   */
  public getPersistor(): OpfsPersistor | undefined {
    return this.persistor;
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
   * Mark a resource as having local changes that need to be synced
   * to the server. Called when a save fails due to the server being
   * unreachable. The actual queuing of commits is now done via
   * {@link Resource.applyPendingCommitsLocally}, which writes to
   * the outbox; this method is kept for API compatibility but is
   * effectively a status-update no-op once the outbox already has
   * an entry for the subject.
   */
  public markDirtyForSync(_subject: string): void {
    this.emitSyncStatus();
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
    if (this.outbox.size === 0) return;

    this.setDirtySyncInProgress(true);
    const agent = this.getAgent();

    if (!agent) {
      this.setDirtySyncInProgress(false);

      return;
    }

    perfMark('store.syncDirtyResources.subjects', { count: this.outbox.size });

    try {
      await this.outbox.drain({
        sort: this.sortOutboxEntries,
        postEntry: this.postOutboxEntry,
      });
    } finally {
      this.setDirtySyncInProgress(false);
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
    const resource = this.resources.get(entry.subject);

    if (!resource) {
      // No in-memory resource — outbox is stale. Drop the entry
      // (next reload won't see it either).
      return;
    }

    if (resource.hasUnsavedChanges()) {
      await resource.save();
    } else {
      await resource.pushCommits();
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

      const parsed = JSON.parse(jsonAd);
      const resource = new Resource(subject);

      resource.applyHydratedValues(
        Object.entries(parsed).filter(([key]) => key !== '@id') as [
          string,
          JSONValue,
        ][],
      );

      resource.getLoroDoc();

      resource.loading = false;
      resource.source = 'client-db';
      resource.sourceTimestamp = Date.now();
      this.addResources(resource, { skipCommitCompare: true });

      return resource;
    } catch {
      return null;
    }
  }

  /**
   * Normalizes a subject: if it is a relative path, it becomes a full URL using the server's base URL.
   * DIDs and full HTTP URLs are returned as-is.
   */
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
   * **The single ingress point** for resource state arriving from any
   * source (WS UPDATE / SYNC_PUSH / QUERY_UPDATE / pending-GET, HTTP
   * fetch, local commit pre-/post-POST, offline replay). All call
   * sites construct an {@link IncomingChange} and call this method
   * — the function handles subject normalisation, commit-id dedup,
   * Loro/JSON-AD hydration, atomic OPFS persistence, and the single
   * `notify` fan-out in one ordered pass.
   *
   * Returns `'applied'` if the change reached `notify`, `'deduped'`
   * if `commitId` matched the cached `lastCommit` (no-op echo), or
   * `'invalid'` if the change was malformed.
   *
   * Implementation note: this is currently a thin shim over the
   * existing `addResource` flow. As WS handlers and the local
   * commit path migrate over, the bespoke `getResourceLoading +
   * importLoroUpdate + addResources({skipCommitCompare: true})` blocks
   * will collapse into one `applyIncoming(...)` call per ingress.
   */
  public applyIncoming(
    change: IncomingChange,
  ): 'applied' | 'deduped' | 'invalid' {
    if (!change.loroBytes && !change.jsonAd) return 'invalid';

    const subject = this.normalizeSubject(change.subject);
    const aliased = this.aliases.get(subject) ?? subject;

    // Commit-id dedup: replaces the bespoke `isEcho` block in the
    // WS UPDATE handler and the `skipCommitCompare` gate in
    // `addResource`. A change whose `commitId` matches the cached
    // `lastCommit` is an echo of state we already applied.
    const existing = this.resources.get(aliased);
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

    // Hydrate into an in-memory Resource. Reuse an existing
    // instance when present so callers' references stay valid;
    // otherwise create a placeholder (`getResourceLoading`).
    const resource =
      existing ?? this.getResourceLoading(subject, { newResource: false });

    if (change.loroBytes) {
      resource.importLoroUpdate(change.loroBytes);
    }
    // jsonAd path is exercised by HTTP fetch + offline replay; the
    // current `addResource` consumers go through their own JSON-AD
    // parsing, so we leave that wiring to the migration step that
    // moves them over (Step 3.5).

    if (change.commitId) {
      resource.setLastCommitValue(change.commitId);
    }

    resource.source = mapChangeSourceToResourceSource(change.source);
    resource.sourceTimestamp = change.receivedAt ?? Date.now();
    resource.loading = false;

    // Re-use the shared addResource flow for persistence + notify.
    // `skipCommitCompare` is unconditionally true here because we
    // already deduped above — the in-flight `addResource` gate
    // would just repeat that check.
    this.addResource(resource, { skipCommitCompare: true });

    return 'applied';
  }

  public addResources(
    resources: Resource | Resource[],
    opts?: AddResourcesOpts,
  ): void {
    for (const resource of Array.isArray(resources) ? resources : [resources]) {
      this.addResource(resource, opts ?? {});
    }
  }

  /**
   * @deprecated Will be marked private in the future, please use `addResources`
   *
   * Adds a Resource to the store and notifies subscribers. Replaces existing
   * resources, unless this new resource is explicitly incomplete.
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

    // Queue the OPFS write BEFORE firing `ResourceUpdated`. The clientDb
    // worker processes messages in posted order (see `workQueue` in
    // `client-db.worker.ts`), so a `putResource` queued before a
    // subsequent `queryLocalDb` is guaranteed to land first. Listeners on
    // `ResourceUpdated` that call `Collection.refresh()` (which queues
    // `queryLocalDb` via `fetchPageFromLocalDb`) thus see the new
    // resource in OPFS — no race. The put itself stays fire-and-forget
    // (no `await`); only the message-queue order matters.
    //
    // Persist only resources whose commits have reached the server. After
    // `signChanges`, `resource.new` is false but `hasPendingCommits` is still
    // true — indicating a locally-signed commit that hasn't been pushed.
    // Those include unsaved placeholders like `TableNewRow`'s pre-created
    // empty row: seeding them would drop a phantom child into OPFS that the
    // children query then picks up on every reload.
    // Offline-applied resources persist themselves via
    // `applyPendingCommitsLocally`, so `addResource` doesn't need to handle
    // them here either.
    if (
      this.persistor &&
      !resource.loading &&
      !resource.new &&
      !resource.hasPendingCommits &&
      !resource.get(core.properties.incomplete)
    ) {
      try {
        const jsonAd = resourceToJsonAd(resource);

        if (jsonAd) {
          // If the resource has a Loro doc in memory, export the
          // snapshot here and write both forms in one worker
          // postMessage. This used to be a separate
          // `WSClient.persistToClientDb` call after this one, which
          // meant the JSON-AD index entry could land in OPFS while
          // its Loro snapshot didn't — a half-state that the next
          // reload would silently inherit. The atomic put closes
          // that gap.
          let snapshot: Uint8Array | undefined;
          try {
            const doc = resource.getLoroDoc?.();
            if (doc) snapshot = doc.export({ mode: 'snapshot' });
          } catch {
            // Resource has no Loro state — fine, fall back to
            // JSON-AD-only put below.
          }
          // Fire-and-forget. We previously chained a `getResource` after
          // every put to verify the round-trip — that doubled the worker
          // messages on drive sync (a 50-resource sync queues 100
          // postMessages), and the worker's serialised queue + the
          // putResource error-path below already surface real failures.
          this.persistor
            .putResource({ subject: resource.subject, jsonAd, snapshot })
            .catch(e => {
              console.error(
                `[ClientDb] putResource failed for ${resource.subject.slice(0, 60)}:`,
                e,
              );
            });
        }
      } catch (e) {
        console.error(
          `[ClientDb] PUT serialization threw for ${resource.subject.slice(0, 60)}:`,
          e,
        );
      }
    }

    // Notify subscribers AFTER the OPFS put has been queued. Any listener
    // that triggers a `queryLocalDb` (e.g. `Collection.refresh()`) will
    // see the new resource because the worker's serialized message queue
    // processes the put before the query.
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
          const resource = this.resources.get(
            this.aliases.get(subject) ?? subject,
          );

          if (resource) {
            resource.loading = false;
            resource.setError(
              new Error(
                'Offline: resource not available locally. Reconnect to fetch.',
              ),
            );
            this.notify(resource);
          }
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
            const resolved = this.aliases.get(subject) ?? subject;
            const resource = this.resources.get(resolved);

            if (resource) {
              resource.setError(
                new AtomicError(
                  `Resource ${subject} not found on server`,
                  ErrorType.NotFound,
                ),
              );
              this.notify(resource);
            }
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
        const resource = this.resources.get(
          this.aliases.get(subject) ?? subject,
        );

        if (resource) {
          resource.loading = false;
          resource.setError(
            e instanceof Error ? e : new Error('Resource fetch failed'),
          );
          this.notify(resource);
        }
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
    // Don't overwrite a resource that has a Loro snapshot with one that doesn't.
    const existing = this.resources.get(this.normalizeSubject(subject));

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
    if (existing && existing.hasPendingCommits) {
      return true;
    }

    // Same problem after a page reload: the in-memory queue is gone, but
    // the outbox persisted it durably. Re-attach the queue to the
    // freshly hydrated instance so the next sync can push.
    const outboxEntry = this.outbox.getEntry(subject);
    const restoredCommits: Commit[] | undefined = outboxEntry
      ? [...outboxEntry.commits]
      : undefined;

    const resource = new Resource(subject);

    resource.applyHydratedValues(
      Object.entries(parsed).filter(([key]) => key !== '@id') as [
        string,
        JSONValue,
      ][],
    );

    resource.getLoroDoc();

    resource.loading = false;
    resource.source = 'client-db';
    resource.sourceTimestamp = Date.now();
    this.addResources(resource, { alias: subject });

    // Re-attach restored commits AFTER addResources because addResources may
    // merge the new instance into an existing placeholder (created by
    // getResourceLoading); merge() carries Loro/cache state but not
    // `_pendingCommits`, so writing them on the just-created `resource`
    // wouldn't survive. Pull the canonical instance back out and patch it.
    if (restoredCommits?.length) {
      const stored = this.resources.get(this.normalizeSubject(subject));
      stored?.setPendingCommits(restoredCommits);
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
      this.addResources(local, { skipCommitCompare: true });

      return local;
    }

    if (opts.setLoading) {
      const newR = new Resource<C>(subject);
      newR.loading = true;
      this.addResources(newR, { skipCommitCompare: true });
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

      resource.source = 'server-http';
      resource.sourceTimestamp = Date.now();
      this.addResources(resource, {
        alias: subject,
        skipCommitCompare: opts.method === 'POST',
      });

      createdResources.forEach(r => {
        if (
          this.normalizeSubject(r.subject) !==
          this.normalizeSubject(resource.subject)
        ) {
          r.source = 'server-http';
          r.sourceTimestamp = Date.now();
          this.addResources(r);
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
    if (subjectRaw === unknownSubject || subjectRaw === null) {
      const newR = new Resource<C>(unknownSubject, opts.newResource);
      newR.setStore(this);

      return newR;
    }

    const normalized = this.normalizeSubject(subjectRaw);
    // Commit DIDs identify the commit resource directly — they must never
    // resolve through the alias map. Without this guard, an alias added by
    // a prior fetch (e.g. `did:ad:commit:<sig>` accidentally aliased to the
    // committed-to subject during signing/hydration) sends the user to the
    // resource the commit edits instead of the commit itself.
    const isCommitDid = normalized.startsWith('did:ad:commit:');
    const resolved = isCommitDid
      ? normalized
      : (this.aliases.get(normalized) ?? normalized);
    const isTemporarySubject =
      normalized.startsWith('_new:') || normalized.startsWith('_local:');

    // This is needed because it can happen that the useResource react hook is called while there is no subject passed.
    if (normalized === unknownSubject || normalized === null) {
      const newR = new Resource<C>(unknownSubject, opts.newResource);
      newR.setStore(this);

      return newR;
    }

    let resource = this.resources.get(resolved);

    if (!resource) {
      resource = new Resource<C>(
        normalized,
        opts.newResource || isTemporarySubject,
      );

      // New resources don't have to load, they are just created.
      if (!opts.newResource && !isTemporarySubject) {
        resource.loading = true;
      } else {
        resource.source = 'created';
        resource.sourceTimestamp = Date.now();
      }

      this.addResources(resource, { alias: normalized });

      if (!opts.newResource && !isTemporarySubject) {
        this.fetchResourceWithLocalFallback(normalized, opts);
      }

      return resource;
    }

    if (!opts.allowIncomplete && resource.loading === false) {
      // In many cases, a user will always need a complete resource.
      // This checks if the resource is incomplete and fetches it if it is.
      if (resource.get(core.properties.incomplete)) {
        resource.loading = true;
        this.addResources(resource);
        this.fetchResourceFromServer(resolved, opts);
      }
    }

    return resource;
  }

  /**
   * @deprecated
   * renamed to `getResource`
   */
  public async getResourceAsync<C extends OptionalClass = UnknownClass>(
    subject: string,
  ): Promise<Resource<C>> {
    return this.getResource(subject);
  }

  /**
   * Gets a resource by URL. Fetches and parses it if it's not available in the
   * store. Not recommended to use this for rendering, because it might cause
   * resources to be fetched multiple times.
   */
  public async getResource<C extends OptionalClass = UnknownClass>(
    subjectRaw: string,
  ): Promise<Resource<C>> {
    const normalized = this.normalizeSubject(subjectRaw);
    const resolved = this.aliases.get(normalized) ?? normalized;

    const found = this.resources.get(resolved);

    if (found && found.isReady()) {
      return found;
    }

    /** Fix the case where a resource was previously requested but still not ready */
    if (found && !found.isReady()) {
      return new Promise((resolve, reject) => {
        const defaultTimeout = 10000;

        const cb: ResourceCallback<C> = res => {
          this.unsubscribe(subjectRaw, cb);
          resolve(res);
        };

        this.subscribe(subjectRaw, cb);

        setTimeout(() => {
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
   * If the store does not have an active internet connection, will return
   * false. This may affect some functionality. For example, some checks will
   * not be performed client side when offline.
   */
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

    if (connected) {
      this.syncDirtyResources().catch(e => {
        console.warn('[Sync] Failed to sync dirty resources on reconnect:', e);
      });
      this.refetchOfflineErroredResources();
    }
  }

  /**
   * When coming back online, re-fetch resources whose state was affected by
   * being offline:
   *   - errored with our `Offline:` marker (surfaced by the fallback path), or
   *   - still stuck in `loading=true` (fetch started but never completed,
   *     e.g. because the server went down mid-flight).
   */
  private refetchOfflineErroredResources(): void {
    const subjectsToRetry: string[] = [];

    for (const [subject, resource] of this.resources.entries()) {
      const erroredOffline =
        resource.error && resource.error.message.startsWith('Offline:');
      const stuckLoading = resource.loading && !resource.new;

      if (erroredOffline || stuckLoading) {
        subjectsToRetry.push(subject);
      }
    }

    for (const subject of subjectsToRetry) {
      const resource = this.resources.get(subject);

      if (!resource) continue;

      resource.error = undefined;
      resource.loading = true;
      this.notify(resource);
      this.fetchResourceFromServer(subject).catch(() => {
        // fetchResourceFromServer already handles its own errors.
      });
    }
  }

  /**
   * @deprecated Use `serverConnected` instead. `navigator.onLine` is unreliable.
   */
  public isOffline(): boolean {
    return !this._serverConnected;
  }

  public startDriveSync(_drive: string): void {
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
    if (this._firstDriveSyncResolve) {
      this._firstDriveSyncResolve();
      this._firstDriveSyncResolve = undefined;
    }
  }

  /** True once any drive sync has finished in this session. Used by
   * collection queries to decide whether an empty local-DB result is
   * authoritative ("the table has no children") or ambiguous ("the index
   * may not be populated yet"). */
  public hasCompletedDriveSync(): boolean {
    return this._lastDriveSync !== undefined;
  }

  /** Resolves once the WebSocket has run its first drive-sync handshake
   * (`SYNC_DIFF` + `SYNC_PUSH` complete, `finishDriveSync` called). Used by
   * collection fetches to defer the fallback `/query` GET until the local
   * WASM DB has been populated by the sync — the index then satisfies the
   * query locally and the server round-trip can be skipped entirely.
   * Resolves immediately if a sync has already completed in this session. */
  public waitForFirstDriveSync(): Promise<void> {
    if (this._lastDriveSync) return Promise.resolve();
    if (!this._firstDriveSyncPromise) {
      this._firstDriveSyncPromise = new Promise<void>(resolve => {
        this._firstDriveSyncResolve = resolve;
      });
    }
    return this._firstDriveSyncPromise;
  }
  private _firstDriveSyncPromise: Promise<void> | undefined;
  private _firstDriveSyncResolve: (() => void) | undefined;

  public getSyncStatus(): StoreSyncStatus {
    const ws = this.getDefaultWebSocket();

    return {
      serverConnected: this._serverConnected,
      driveSyncInProgress: this._driveSyncInProgress,
      dirtySyncInProgress: this._dirtySyncInProgress,
      syncInProgress: this._driveSyncInProgress || this._dirtySyncInProgress,
      pendingDirtyCount: this.outbox.size,
      pendingDirtySubjects: this.outbox.pendingSubjects(),
      serverUrl: this.serverUrl,
      drive: this.drive,
      websocketReadyState: ws?.readyState,
      websocketProtocol: 'v2',
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
    this.recentlyCreatedSubjects.set(resource.subject, Date.now());
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
      const resources = parser.parse(json);
      this.addResources(resources);
    });
  }

  /**
   * Fetches all Classes and Properties from your current server, including external resources.
   * This helps to speed up time to interactive, but may not be necessary for all applications.
   */
  public async preloadPropsAndClasses(): Promise<void> {
    // TODO: use some sort of CollectionBuilder for this.
    const classesUrl = new URL('/classes', this.serverUrl);
    const propertiesUrl = new URL('/properties', this.serverUrl);
    classesUrl.searchParams.set('include_external', 'true');
    propertiesUrl.searchParams.set('include_external', 'true');
    classesUrl.searchParams.set('include_nested', 'true');
    propertiesUrl.searchParams.set('include_nested', 'true');
    classesUrl.searchParams.set('page_size', '999');
    propertiesUrl.searchParams.set('page_size', '999');
    await Promise.all([
      this.fetchResourceFromServer(classesUrl.toString()),
      this.fetchResourceFromServer(propertiesUrl.toString()),
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

  /** Removes resource from this store, does not delete it from the server, use `resource.destroy()` to delete it from the server. */
  public removeResource(subjectRaw: string, shouldNotify = true): void {
    const normalized = this.normalizeSubject(subjectRaw);
    const resolved = this.aliases.get(normalized) ?? normalized;

    const resource = this.resources.get(resolved);

    // Tombstone in ClientDb (OPFS) so the resource doesn't reappear after a
    // page reload. The in-memory `resources` map is wiped on reload, but the
    // WASM DB persists; without this, cascade-deleted children survive
    // restart and re-render. Fire-and-forget — the worker queues writes.
    if (this.persistor) {
      void this.persistor.removeResource(resolved).catch(() => undefined);
    }

    if (resource) {
      this.resources.delete(resolved);
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

    this.addResources(resource);
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
        setCookieAuthentication(this.serverUrl, agent);
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
   * Registers a callback for when the a resource is updated. When you call
   * this
   * The method returns a function that you can call to unsubscribe. You can also unsubscribe by calling `store.unsubscribe()`.
   */
  // TODO: consider subscribing to properties, maybe add a second subscribe function, use that in useValue
  public subscribe(subject: string, callback: ResourceCallback): () => void {
    if (subject === undefined) {
      throw Error('Cannot subscribe to undefined subject');
    }

    const normalized = this.normalizeSubject(subject);

    let callbackArray = this.subscribers.get(normalized);

    if (callbackArray === undefined) {
      // Only subscribe once
      this.subscribeWebSocket(normalized);
      callbackArray = [];
    }

    callbackArray.push(callback);
    this.subscribers.set(normalized, callbackArray);

    return () => {
      this.unsubscribe(normalized, callback);
    };
  }

  public subscribeWebSocket(subject: string): void {
    if (!this._serverConnected) return;

    const normalized = this.normalizeSubject(subject);

    if (normalized === unknownSubject) {
      return;
    }

    // Commits are immutable — no need to subscribe for push updates
    if (
      normalized.includes('/commits/') ||
      normalized.startsWith('did:ad:commit:')
    ) {
      return;
    }

    try {
      const ws = this.getWebSocketForSubject(subject);
      ws?.subscribeResource(subject);
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * Subscribe to Yjs Sync messages send over the websocket connection.
   * These sync messages can be used for realtime collaboration and are not persisted on the server.
   * For regular updates to normal values an ydocs use `store.subscribe()` instead.
   * @param subject The subject of the resource that you want to subscribe to.
   * @param property The property that contains the ydoc.
   * @param callback The callback that will be called when the doc or awareness state changes.
   * @returns A function that can be called to unsubscribe.
   */
  // === Loro CRDT Sync ===

  /**
   * Subscribe to Loro document sync updates for a resource.
   * This is for real-time CRDT synchronization — persistent changes go through commits.
   * @returns A function to unsubscribe.
   */
  public subscribeLoroSync(
    subject: string,
    callback: LoroSyncCallback,
  ): () => void {
    const unsub = () => {
      const subscribers = this.loroSyncSubscribers.get(subject);

      if (subscribers) {
        const afterUnsub = subscribers.filter(item => item !== callback);

        if (afterUnsub.length === 0) {
          this.loroSyncSubscribers.delete(subject);

          if (this._serverConnected) {
            this.getWebSocketForSubject(subject)?.unsubscribeLoroSync(subject);
          }
        } else {
          this.loroSyncSubscribers.set(subject, afterUnsub);
        }
      }
    };

    const subscribers = this.loroSyncSubscribers.get(subject);

    if (subscribers) {
      subscribers.push(callback);

      return unsub;
    }

    this.loroSyncSubscribers.set(subject, [callback]);

    if (this._serverConnected) {
      this.getWebSocketForSubject(subject)?.subscribeLoroSync(subject);
    }

    return unsub;
  }

  /**
   * Broadcast a Loro document update to all peers via WebSocket.
   * These are non-persistent real-time updates. For persistence, use commits with loroUpdate.
   */
  public broadcastLoroSyncUpdate(subject: string, update: Uint8Array): void {
    if (!this._serverConnected) return;

    const ws = this.getWebSocketForSubject(subject);

    const messageBody = {
      subject,
      update: encodeB64(update),
    };

    ws?.sendLoroSyncUpdate(JSON.stringify(messageBody));
  }

  /**
   * Subscribe to Loro ephemeral updates (cursors, presence) for a resource.
   * @returns A function to unsubscribe.
   */
  public subscribeLoroEphemeral(
    subject: string,
    callback: LoroEphemeralCallback,
  ): () => void {
    const unsub = () => {
      const subscribers = this.loroEphemeralSubscribers.get(subject);

      if (subscribers) {
        const afterUnsub = subscribers.filter(item => item !== callback);

        if (afterUnsub.length === 0) {
          this.loroEphemeralSubscribers.delete(subject);
        } else {
          this.loroEphemeralSubscribers.set(subject, afterUnsub);
        }
      }
    };

    const subscribers = this.loroEphemeralSubscribers.get(subject);

    if (subscribers) {
      subscribers.push(callback);

      return unsub;
    }

    this.loroEphemeralSubscribers.set(subject, [callback]);

    return unsub;
  }

  /**
   * Broadcast a Loro ephemeral update (cursor positions, presence) to peers.
   */
  public broadcastLoroEphemeralUpdate(
    subject: string,
    update: Uint8Array,
  ): void {
    if (!this._serverConnected) return;

    const ws = this.getWebSocketForSubject(subject);

    const messageBody = {
      subject,
      update: encodeB64(update),
    };

    ws?.sendLoroEphemeralUpdate(JSON.stringify(messageBody));
  }

  /** @internal */
  public __handleLoroSyncMessage(message: string): void {
    const messageBody: { subject: string; update: string } =
      JSON.parse(message);
    const subscribers = this.loroSyncSubscribers.get(messageBody.subject);

    if (subscribers) {
      const update = decodeB64(messageBody.update);
      subscribers.forEach(callback => callback(update));
    }
  }

  /** @internal */
  public __handleLoroEphemeralMessage(message: string): void {
    const messageBody: { subject: string; update: string } =
      JSON.parse(message);
    const subscribers = this.loroEphemeralSubscribers.get(messageBody.subject);

    if (subscribers) {
      const update = decodeB64(messageBody.update);
      subscribers.forEach(callback => callback(update));
    }
  }

  public unSubscribeWebSocket(subject: string): void {
    if (subject === unknownSubject) {
      return;
    }

    try {
      this.getDefaultWebSocket()?.unsubscribeResource(subject);
    } catch (e) {
      console.error(e);
    }
  }

  /** Unregisters the callback (see `subscribe()`) */
  public unsubscribe(subject: string, callback: ResourceCallback): void {
    if (subject === undefined) {
      return;
    }

    const normalized = this.normalizeSubject(subject);
    let callbackArray = this.subscribers.get(normalized);

    if (callbackArray) {
      callbackArray = callbackArray.filter(cb => cb !== callback);
      this.subscribers.set(normalized, callbackArray);
    }
  }

  public on<T extends StoreEvents>(event: T, callback: StoreEventHandlers[T]) {
    return this.eventManager.register(event, callback);
  }

  private setDirtySyncInProgress(syncing: boolean): void {
    if (this._dirtySyncInProgress === syncing) return;
    this._dirtySyncInProgress = syncing;
    this.emitSyncStatus();
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

    // On a status transition we ran `summarizeCommitProperties` a second time
    // for the same commit. The first call stored the snapshot as the prior
    // baseline; the second call diffs the snapshot against itself → empty
    // → undefined. Reuse the original summary so the empty diff doesn't
    // overwrite the real one when we spread-merge below.
    if (existingIdx >= 0) {
      entry = {
        ...entry,
        propertySummaries: this._commitLog[existingIdx].propertySummaries,
      };
    }

    if (existingIdx >= 0) {
      const merged: CommitLogEntry = {
        ...this._commitLog[existingIdx],
        ...entry,
      };
      this._commitLog = [
        merged,
        ...this._commitLog.slice(0, existingIdx),
        ...this._commitLog.slice(existingIdx + 1),
      ];
    } else {
      this._commitLog = [
        {
          ...entry,
          id: ulid(),
        },
        ...this._commitLog,
      ].slice(0, 50);
    }
    this.eventManager.emit(StoreEvents.CommitLogChanged, this.getCommitLog());
  }

  /**
   * Records a locally-signed but not-yet-pushed commit as `pending` in the
   * commit log. When the push resolves, {@link postCommit} reuses the same
   * `commitId` so the entry transitions in place to `sent` or `failed`.
   */
  public logPendingCommit(commit: Commit): void {
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
    this.pushCommitLog({
      timestamp: Date.now(),
      direction: 'incoming',
      status: 'received',
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
      this.addResources(resources);
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

      await this.persistor!.putBlob(hashBytes, data);

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
      this.pushCommitLog({
        timestamp: Date.now(),
        direction: 'outgoing',
        status: 'sent',
        subject: commit.subject,
        signer: commit.signer,
        previousCommit: commit.previousCommit,
        commitId:
          (created.id as string | undefined) ??
          (created.signature
            ? `did:ad:commit:${created.signature}`
            : undefined),
        hasLoroUpdate: !!commit.loroUpdate,
        destroy: !!commit.destroy,
        summary: this.summarizeCommit(commit),
        propertySummaries: this.summarizeCommitProperties(commit),
      });

      return created;
    } catch (e) {
      close({ err: e instanceof Error ? e.message : String(e) });
      this.pushCommitLog({
        timestamp: Date.now(),
        direction: 'outgoing',
        status: 'failed',
        subject: commit.subject,
        signer: commit.signer,
        previousCommit: commit.previousCommit,
        // Include commitId so a prior `pending` entry transitions in place to
        // `failed` rather than producing a second row.
        commitId: commit.signature
          ? `did:ad:commit:${commit.signature}`
          : undefined,
        hasLoroUpdate: !!commit.loroUpdate,
        destroy: !!commit.destroy,
        summary: this.summarizeCommit(commit),
        propertySummaries: this.summarizeCommitProperties(commit),
        error: e instanceof Error ? e.message : String(e),
      });
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

  /** Lets subscribers know that a resource has been changed. Time to update your views.
   */
  private async notify(resource: Resource): Promise<void> {
    // Global event for collection live-membership listeners. Fires for every
    // resource that lands in the store via `addResource` — local commits and
    // remote `UPDATE` pushes alike. Kept separate from the per-subject
    // subscriber list because collections need to react to changes on
    // resources they may not yet know about (e.g. a brand-new chat message).
    this.eventManager.emit(StoreEvents.ResourceUpdated, resource);

    const subject = resource.subject;
    const callbacks = this.subscribers.get(subject);

    if (callbacks === undefined) {
      return;
    }

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
