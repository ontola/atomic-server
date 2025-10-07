import { ulid } from 'ulidx';
import type { Agent } from './agent.js';
import {
  removeCookieAuthentication,
  setCookieAuthentication,
} from './authentication.js';
import { Client, type FileOrFileLike } from './client.js';
import type { Commit } from './commit.js';
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
type QueryMembershipChangedCallback = (change: QueryMembershipChange) => void;

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
   * A drive-wide query subscription told us that some resources were added or
   * removed from the drive. Fired AFTER the refetch of the affected subjects
   * has been kicked off, so consumers (useCollection / useChildren) can call
   * invalidate to recompute their member list against the now-fresh store.
   */
  QueryMembershipChanged = 'query-membership-changed',
  /** Event that gets called whenever the store encounters an error */
  Error = 'error',
}

export interface QueryMembershipChange {
  /** Property the subscription was filtered on, if any. */
  property?: string;
  /** Value the subscription was filtered on, if any. */
  value?: string;
  /** Drive scope of the subscription. */
  drive?: string;
  /** Subjects that joined the result set. */
  added: string[];
  /** Subjects that left the result set. */
  removed: string[];
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
  [StoreEvents.QueryMembershipChanged]: QueryMembershipChangedCallback;
  [StoreEvents.Error]: ErrorCallback;
};

export interface ResourceTreeTemplate {
  [property: string]: true | ResourceTreeTemplate;
}

/** Returns True if the client has WebSocket support */
const supportsWebSockets = () => typeof WebSocket !== 'undefined';

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
  /** Client-side full-text search index (MiniSearch). */
  private localSearch = new LocalSearch();
  /** Resources with local changes that haven't been synced to the server yet. */
  private dirtyForSync: Set<string> = new Set();
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

    // Restore dirty-for-sync set from localStorage
    if (typeof localStorage !== 'undefined') {
      try {
        const stored = localStorage.getItem('atomic.dirtyForSync');

        if (stored) {
          for (const s of JSON.parse(stored)) {
            this.dirtyForSync.add(s);
          }
        }
      } catch (e) {
        this.notifyError(e);
      }
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
   * Mark a resource as having local changes that need to be synced to the server.
   * Called when a save fails due to the server being unreachable.
   */
  public markDirtyForSync(subject: string): void {
    this.dirtyForSync.add(subject);

    // Persist to localStorage so it survives page reloads
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        'atomic.dirtyForSync',
        JSON.stringify([...this.dirtyForSync]),
      );
    }

    this.emitSyncStatus();
  }

  /**
   * Sync all dirty resources to the server.
   * For each dirty resource, creates a fresh commit from the current state
   * (Loro snapshot has all accumulated changes) and POSTs it.
   * Called on WebSocket reconnect.
   */
  /**
   * Sort dirty resources by dependency order so that the server receives
   * them in a valid sequence: agents first, then drives, then children
   * sorted by parent depth (shallowest first).
   */
  private sortDirtyForSync(subjects: string[]): string[] {
    const getPriority = (subject: string): number => {
      // Agents must exist before anything else
      if (subject.startsWith('did:ad:agent:')) return 0;

      // The current drive must exist before its children
      if (subject === this.drive) return 1;

      // Everything else is a child resource
      return 2;
    };

    const getDepth = (subject: string): number => {
      let depth = 0;
      let current = subject;

      // Walk up the parent chain (max 20 to avoid infinite loops)
      while (depth < 20) {
        const resource = this.resources.get(current);

        if (!resource) break;

        const parent = resource.get(core.properties.parent) as
          | string
          | undefined;

        if (!parent || parent === current) break;

        depth++;
        current = parent;
      }

      return depth;
    };

    return subjects.sort((a, b) => {
      const pa = getPriority(a);
      const pb = getPriority(b);

      if (pa !== pb) return pa - pb;

      // Within same priority, sort by parent depth (shallow first)
      return getDepth(a) - getDepth(b);
    });
  }

  public async syncDirtyResources(): Promise<void> {
    if (this.dirtyForSync.size === 0) return;

    this.setDirtySyncInProgress(true);

    const agent = this.getAgent();

    if (!agent) {
      this.setDirtySyncInProgress(false);

      return;
    }

    const subjects = this.sortDirtyForSync([...this.dirtyForSync]);
    console.info(`[Sync] Syncing ${subjects.length} dirty resources...`);

    for (const subject of subjects) {
      const resource = this.resources.get(subject);

      if (!resource) {
        this.dirtyForSync.delete(subject);
        this.emitSyncStatus();
        continue;
      }

      try {
        // The resource already has its changes in propvals + Loro doc.
        // signChanges + pushCommits will create a fresh commit and POST it.
        if (resource.hasUnsavedChanges()) {
          await resource.save();
        } else {
          // Changes were already signed but push failed — retry push.
          await resource.pushCommits();
        }

        this.dirtyForSync.delete(subject);
        this.emitSyncStatus();

        // Clean up offline localStorage entry
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(`atomic.offline.${subject}`);
        }

        console.info(`[Sync] Synced ${subject}`);
      } catch (e) {
        console.warn(`[Sync] Failed to sync ${subject}:`, e);
        // Leave in dirty set for next attempt
      }
    }

    try {
      // Update persisted dirty set
      if (typeof localStorage !== 'undefined') {
        if (this.dirtyForSync.size === 0) {
          localStorage.removeItem('atomic.dirtyForSync');
        } else {
          localStorage.setItem(
            'atomic.dirtyForSync',
            JSON.stringify([...this.dirtyForSync]),
          );
        }
      }
    } finally {
      this.setDirtySyncInProgress(false);
    }
  }

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
      this.notify(storeResource);
    } else {
      this.resources.set(subject, resource.__internalObject);
      this.notify(resource.__internalObject);
    }

    // Update local full-text search index.
    if (!resource.loading && !resource.new) {
      this.localSearch.addResource(resource);
    }

    // Forward to WASM DB in the background (non-blocking).
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
    // The intended persist site is the post-push `addResources` call in
    // `resource.pushCommits` — by then the pending queue is drained and both
    // checks pass.
    if (
      this.clientDb &&
      !resource.loading &&
      !resource.new &&
      !resource.hasPendingCommits &&
      !resource.get(core.properties.incomplete)
    ) {
      try {
        const jsonAd = resourceToJsonAd(resource);
        const short = resource.subject.slice(0, 60);

        if (jsonAd) {
          const isDid = resource.subject.startsWith('did:ad:');
          if (isDid) {
            console.info(
              `[ClientDb] PUT start: ${short} (${jsonAd.length} chars)`,
            );
          }
          this.clientDb
            .putResource(jsonAd)
            .then(async () => {
              // Verify every put round-trips. Previously only parent-having
              // resources were checked, which hid silent drops for top-level
              // DID resources (drives have no parent).
              const stored = await this.clientDb!.getResource(
                resource.subject,
              ).catch(() => null);
              if (!stored) {
                console.error(
                  `[ClientDb] PUT succeeded but resource NOT found: ${short}`,
                );
                console.error(`[ClientDb] JSON was: ${jsonAd.slice(0, 300)}`);
              } else if (isDid) {
                console.info(`[ClientDb] PUT verified: ${short}`);
              }
            })
            .catch(e => {
              console.error(
                `[ClientDb] putResource THREW for ${short}:`,
                e,
                `\n  JSON was: ${jsonAd.slice(0, 300)}`,
              );
            });
        } else {
          console.warn(
            `[ClientDb] PUT skipped (empty JSON-AD) for ${short} — resource has no serializable props yet`,
          );
        }
      } catch (e) {
        console.error(
          `[ClientDb] PUT serialization threw for ${resource.subject.slice(0, 60)}:`,
          e,
        );
      }
    } else if (this.clientDb && resource.subject.startsWith('did:ad:')) {
      console.info(
        `[ClientDb] PUT skipped for ${resource.subject.slice(0, 60)} (loading=${resource.loading}, incomplete=${!!resource.get(core.properties.incomplete)})`,
      );
    }
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

    // Link the drive to the Agent resource
    const agentResource = this.getResourceLoading(agent.subject);
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
    if (this.clientDb) {
      await this.clientDb.waitForReady();
    }

    // Try the WASM DB (OPFS) for persisted resources.
    if (this.clientDb?.isReady) {
      try {
        const jsonAd = await this.clientDb.getResource(subject);
        console.warn(
          `[offline-trace] getResource("${subject}") → ${jsonAd ? `JSON-AD (${jsonAd.length} chars)` : 'null/undefined'}`,
        );

        if (jsonAd) {
          hasLocalData = this.hydrateResourceFromJson(
            subject,
            JSON.parse(jsonAd),
          );
          console.warn(
            `[offline-trace] hydrateResourceFromJson("${subject}") → ${hasLocalData}`,
          );
        }

        // Restore Loro snapshot if available (stored separately from JSON-AD).
        if (hasLocalData) {
          const snapshot = await this.clientDb.getLoroSnapshot(subject);

          if (snapshot && snapshot.length > 0) {
            const resource = this.resources.get(subject);

            if (resource) {
              resource.importLoroUpdate(snapshot);
            }
          }
        }
      } catch (e) {
        console.warn(
          `[offline-trace] OPFS lookup/hydrate threw for "${subject}":`,
          e,
        );
      }
    } else {
      console.warn(
        `[offline-trace] clientDb not ready: clientDb=${!!this.clientDb}, isReady=${this.clientDb?.isReady}`,
      );
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
        // Online with local data — background refresh will come via WS COMMIT.
      } else {
        // Online, no local data — server is our only source.
        await this.fetchResourceFromServer(subject, opts);
      }
    } catch {
      // Server failed and no local data — resource stays in loading state.
      // This is better than showing an error when the user might come back online.
      if (!hasLocalData) {
        const resource = this.resources.get(
          this.aliases.get(subject) ?? subject,
        );

        if (resource) {
          resource.loading = false;
          resource.setError(
            new Error('Offline: resource not available locally'),
          );
          this.notify(resource);
        }
      }
    }
  }

  /** Hydrate a Resource from a parsed JSON-AD object and add it to the store. Returns true if successful. */
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
    const resolved = this.aliases.get(normalized) ?? normalized;
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
        const defaultTimeout = 5000;

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

    if (subjectsToRetry.length > 0) {
      console.info(
        `[Store] Reconnected — refetching ${subjectsToRetry.length} resource(s) that errored or were stuck loading`,
      );
    }
  }

  /**
   * @deprecated Use `serverConnected` instead. `navigator.onLine` is unreliable.
   */
  public isOffline(): boolean {
    return !this._serverConnected;
  }

  public startDriveSync(drive: string): void {
    this._driveSyncInProgress = true;
    console.info(`[Sync] Starting drive sync for ${drive}`);
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

  public getSyncStatus(): StoreSyncStatus {
    const ws = this.getDefaultWebSocket();

    return {
      serverConnected: this._serverConnected,
      driveSyncInProgress: this._driveSyncInProgress,
      dirtySyncInProgress: this._dirtySyncInProgress,
      syncInProgress: this._driveSyncInProgress || this._dirtySyncInProgress,
      pendingDirtyCount: this.dirtyForSync.size,
      pendingDirtySubjects: [...this.dirtyForSync],
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

  private summarizeCommitProperties(
    commit: Commit,
  ): CommitLogPropertySummary[] | undefined {
    if (!commit.loroUpdate) {
      return undefined;
    }

    try {
      const materialized = new Resource(commit.subject);
      materialized.importLoroUpdate(commit.loroUpdate);

      const properties = materialized
        .getEntries()
        .filter(
          ([prop]) =>
            prop !== commits.properties.loroUpdate &&
            prop !== commits.properties.lastCommit,
        )
        .map(([prop, value]) => ({ property: prop, value: value as JSONValue }))
        .slice(0, 12);

      return properties.length > 0 ? properties : undefined;
    } catch (e) {
      console.warn('[summarizeCommitProperties] failed:', e);

      return undefined;
    }
  }

  /**
   * Notifies subscribers that a drive-wide query subscription reported a
   * membership change. Called by {@link WSClient} after it parses a
   * `QUERY_UPDATE` frame and kicks off refetches.
   */
  public notifyQueryMembershipChanged(change: QueryMembershipChange): void {
    this.eventManager.emit(StoreEvents.QueryMembershipChanged, change);
  }

  /**
   * If the resource carries a `blob` reference, push the locally-stored bytes
   * to the server via a `BLOB_RESPONSE` frame. No-op if there's no clientDb
   * (HTTP `/upload` already wrote the bytes server-side), no WS connection
   * (we'll retry next time this is called), or no local copy of the bytes.
   *
   * Called from {@link Resource.pushCommits} on every successful commit push,
   * so the bytes get sent both on initial save AND after `syncDirtyResources`
   * flushes commits that were queued while offline.
   */
  public async maybePushBlobForResource(resource: Resource): Promise<void> {
    if (!this.clientDb) return;
    const ws = this.getDefaultWebSocket();
    if (!ws) return;

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

    ws.sendBlob(hashBytes, bytes);
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

      await this.clientDb.putBlob(hashBytes, data);

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
    try {
      const created = await this.client.postCommit(commit, endpoint);
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
