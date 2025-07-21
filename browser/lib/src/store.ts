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
import type { JSONValue } from './value.js';
import { WSClient } from './websockets.js';
import { endpoints } from './urls.js';
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

  private eventManager = new EventManager<StoreEvents, StoreEventHandlers>();

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
  }

  /** Returns the ClientDbWorker if one has been set (may still be initializing). */
  public getClientDb(): ClientDbWorker | undefined {
    return this.clientDb;
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
  }

  /**
   * Sync all dirty resources to the server.
   * For each dirty resource, creates a fresh commit from the current state
   * (Loro snapshot has all accumulated changes) and POSTs it.
   * Called on WebSocket reconnect.
   */
  public async syncDirtyResources(): Promise<void> {
    if (this.dirtyForSync.size === 0) return;

    const agent = this.getAgent();

    if (!agent) return;

    const subjects = [...this.dirtyForSync];
    console.info(`[Sync] Syncing ${subjects.length} dirty resources...`);

    for (const subject of subjects) {
      const resource = this.resources.get(subject);

      if (!resource) {
        this.dirtyForSync.delete(subject);
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

    // If the resource is already in the store, we merge it so code that depends on the resource will get the new values.
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
    // Don't forward loading/new/incomplete resources.
    if (
      this.clientDb &&
      !resource.loading &&
      !resource.new &&
      !resource.get(core.properties.incomplete)
    ) {
      try {
        const jsonAd = resourceToJsonAd(resource);

        if (jsonAd) {
          this.clientDb.putResource(jsonAd).catch(() => {
            // Silently ignore — the in-memory store is the source of truth
          });
        }
      } catch {
        // Serialization errors are not critical
      }
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

  public async search(query: string, opts: SearchOpts = {}): Promise<string[]> {
    // Try local search first if the index has content and no filters are set.
    // Filters (property-value constraints) require server-side Tantivy for now.
    if (this.localSearch.size > 0 && !opts.filters && !opts.parents) {
      const local = this.localSearch.search(query, opts.limit ?? 30);

      if (local.subjects.length > 0) {
        return local.subjects;
      }
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

  /** Creates a random HTTP subject, optionally nested under a parent URL. */
  public createSubject(parent?: string): string {
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

    // Check localStorage first for offline-saved resources (these preserve
    // loroUpdate snapshots that the WASM DB parser might drop).
    if (typeof localStorage !== 'undefined') {
      const offlineJson = localStorage.getItem(`atomic.offline.${subject}`);

      if (offlineJson) {
        try {
          hasLocalData = this.hydrateResourceFromJson(
            subject,
            JSON.parse(offlineJson),
          );
        } catch {
          // Corrupted — remove it
          localStorage.removeItem(`atomic.offline.${subject}`);
        }
      }
    }

    // Try the WASM DB if localStorage didn't have it
    if (!hasLocalData && this.clientDb?.isReady) {
      try {
        const jsonAd = await this.clientDb.getResource(subject);

        if (jsonAd) {
          hasLocalData = this.hydrateResourceFromJson(
            subject,
            JSON.parse(jsonAd),
          );
        }
      } catch {
        // WASM DB failed — continue to server
      }
    }

    // Try the server — skip background refresh if we already have local data
    // and the server might be down (to avoid overwriting good data with error resources).
    try {
      if (hasLocalData) {
        // We have local data — don't risk overwriting it with an errored fetch.
        // The QUERY_UPDATE / COMMIT WS flow will bring in updates when the server is back.
      } else {
        // Blocking: we have no data, server is our only hope
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
    const resource = new Resource(subject);

    for (const [key, value] of Object.entries(parsed)) {
      if (key === '@id') continue;
      resource.setUnsafe(key, value as JSONValue);
    }

    resource.loading = false;
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

    // Resolve relative subjects to full URLs
    const fetchSubject =
      subject.startsWith('http') || subject.startsWith('did:ad:')
        ? subject
        : new URL(subject, this.serverUrl).toString();

    // Use WebSocket if available, else use HTTP(S)
    const ws = this.getWebSocketForSubject(fetchSubject);

    if (
      !opts.fromProxy &&
      !opts.noWebSocket &&
      supportsWebSockets() &&
      ws?.readyState === WebSocket.OPEN
    ) {
      // Use WebSocket
      await ws.fetch(fetchSubject);
      // Resource should now have been added to the store by the websocket client.
    } else {
      // Use HTTPS
      const signInfo = this.agent
        ? { agent: this.agent, serverURL: this.getServerUrl() }
        : undefined;

      const { resource, createdResources } =
        await this.client.fetchResourceHTTP(fetchSubject, {
          from: opts.fromProxy ? this.getServerUrl() : undefined,
          method: opts.method,
          body: opts.body,
          signInfo,
          // Always pass serverURL so DID subjects can be resolved via the
          // correct backend URL even when the agent hasn't loaded from IDB yet.
          serverURL: this.getServerUrl(),
        });

      // The client already returns the requested top-level resource as `resource`.
      this.addResources(resource, {
        alias: subject,
        // POST endpoint responses can reuse the same @id as an already loaded GET
        // resource (e.g. invite preview -> invite accept redirect). Force merge.
        skipCommitCompare: opts.method === 'POST',
      });

      // Any other resources that were returned (e.g. linked resources)
      createdResources.forEach(r => {
        if (
          this.normalizeSubject(r.subject) !==
          this.normalizeSubject(resource.subject)
        ) {
          this.addResources(r);
        }
      });
    }

    return this.resources.get(this.normalizeSubject(subject))!;
  }

  public getAllSubjects(): string[] {
    return Array.from(this.resources.keys());
  }

  /** Returns the WebSocket for the current Server URL */
  public getDefaultWebSocket(): WSClient | undefined {
    return this.webSockets.get(this.getServerUrl());
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
      }

      this.addResources(resource, { alias: normalized });

      if (!opts.newResource && !isTemporarySubject) {
        this.fetchResourceWithLocalFallback(normalized, opts);
      }

      return resource;
    } else if (!opts.allowIncomplete && resource.loading === false) {
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
        `Property ${subject} has no datatype: ${resource.getPropVals()}`,
      );
    }

    const shortname = resource.get(core.properties.shortname);

    if (shortname === undefined) {
      throw Error(
        `Property ${subject} has no shortname: ${resource.getPropVals()}`,
      );
    }

    const description = resource.get(core.properties.description);

    if (description === undefined) {
      throw Error(
        `Property ${subject} has no description: ${resource.getPropVals()}`,
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
  public isOffline(): boolean {
    // If we are in a node/server environment assume we are online.
    if (!hasBrowserAPI()) {
      return false;
    }

    return !window?.navigator?.onLine;
  }

  public async notifyResourceSaved(resource: Resource): Promise<void> {
    await this.eventManager.emit(StoreEvents.ResourceSaved, resource);
  }

  public async notifyResourceManuallyCreated(
    resource: Resource,
  ): Promise<void> {
    await this.eventManager.emit(StoreEvents.ResourceManuallyCreated, resource);
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

    // TODO This is not the right place
    if (supportsWebSockets()) {
      this.openWebSocket(url);
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

      // Only subscribe if there's a websocket. When it's opened, all subject will be iterated and subscribed
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
    const ws = this.getWebSocketForSubject(subject);

    const unsub = () => {
      const subscribers = this.loroSyncSubscribers.get(subject);

      if (subscribers) {
        const afterUnsub = subscribers.filter(item => item !== callback);

        if (afterUnsub.length === 0) {
          this.loroSyncSubscribers.delete(subject);
          ws?.unsubscribeLoroSync(subject);
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
    ws?.subscribeLoroSync(subject);

    return unsub;
  }

  /**
   * Broadcast a Loro document update to all peers via WebSocket.
   * These are non-persistent real-time updates. For persistence, use commits with loroUpdate.
   */
  public broadcastLoroSyncUpdate(subject: string, update: Uint8Array): void {
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

  /** Uploads files to atomic server and create resources for them, then returns the subjects.
   * If using this in Node.js and it does not work, try injecting node-fetch using `Store.injectFetch()` Some versions of Node create mallformed FormData when using the build-in fetch.
   */
  public async uploadFiles(
    files: FileOrFileLike[],
    parent: string,
  ): Promise<string[]> {
    const agent = this.getAgent();

    if (!agent) {
      throw Error('No agent set, cannot upload files');
    }

    const resources = await this.client.uploadFiles(
      files,
      this.getServerUrl(),
      agent,
      parent,
    );

    this.addResources(resources);

    return resources.map(r => r.subject);
  }

  /** Posts a Commit to some endpoint. Returns the Commit created by the server. */
  public async postCommit(commit: Commit, endpoint: string): Promise<Commit> {
    return this.client.postCommit(commit, endpoint);
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
  const propvals = resource.getPropVals();

  if (propvals.size === 0) return null;

  const obj: Record<string, unknown> = { '@id': resource.subject };

  for (const [key, value] of propvals) {
    // Skip Uint8Array values (Loro snapshots) — JSON.stringify turns them
    // into huge {"0":98,"1":71,...} objects that block the main thread.
    // These are persisted separately through the offline save path.
    if (value instanceof Uint8Array) continue;
    obj[key] = value;
  }

  return JSON.stringify(obj);
}
