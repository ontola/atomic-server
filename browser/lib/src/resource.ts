import type { LoroDoc, LoroList, VersionVector } from 'loro-crdt';
import { LoroLoader } from './loro-loader.js';
import { decodeB64 } from './base64.js';
import { EventManager } from './EventManager.js';
import type { Agent } from './agent.js';
import { Client } from './client.js';
import type { Collection } from './collection.js';
import { CollectionBuilder } from './collectionBuilder.js';
import { CommitBuilder, Commit, commitToJsonADObject } from './commit.js';
import { validateDatatype } from './datatypes.js';
import { isUnauthorized } from './error.js';
import { commits } from './ontologies/commits.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';

import {
  getKnownClassDefBySubject,
  getKnownNameBySubject,
  type InferTypeOfValueInTriple,
  type OptionalClass,
  type QuickAccessPropType,
} from './ontology.js';
import type { Store } from './store.js';
import { properties, instances } from './urls.js';
import {
  valToArray,
  type JSONValue,
  type JSONArray,
  type JSONObject,
  type AtomicValue,
} from './value.js';

/**
 * If a resource has no subject, it will have this subject. This means that the
 * Resource is not saved or fetched.
 */
export const unknownSubject = 'unknown-subject';

export enum ResourceEvents {
  LocalChange = 'local-change',
  LoadingChange = 'loading-change',
}

type ResourceEventHandlers = {
  [ResourceEvents.LocalChange]: (prop: string, value: JSONValue) => void;
  [ResourceEvents.LoadingChange]: (loading: boolean) => void;
};

/**
 * Describes an Atomic Resource, which has a Subject URL and a bunch of Property
 * / Value combinations.
 *
 * Create new resources using `store.createResource()`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class Resource<C extends OptionalClass = any> {
  // WARNING: WHEN ADDING A PROPERTY, ALSO ADD IT TO THE CLONE METHOD

  /** If the resource could not be fetched, we put that info here. */
  public error?: Error;
  /** If the commit could not be saved, we put that info here. */
  public commitError?: Error;
  /** Is true for locally created, unsaved resources */
  public new: boolean;
  /**
   * Every commit that has been applied should be stored here, which prevents
   * applying the same commit twice
   */
  public appliedCommitSignatures: Set<string> = new Set();

  private _loading = false;
  private _dirty = false;

  private commitBuilder: CommitBuilder;
  private _subject: string;
  /** Memoized read cache derived from Loro. Rebuilt lazily when _cacheDirty. */
  private _cache: Record<string, JSONValue> = Object.create(null);
  /** True when Loro has been modified but _cache hasn't been rebuilt yet. */
  private _cacheDirty = false;
  private _auxValues: Map<string, AtomicValue> = new Map();
  /** Raw Loro snapshot bytes, kept separate from properties. Not a propval. */
  private _loroSnapshotBytes?: Uint8Array | string;

  /** Loro CRDT document backing this resource. Lazily initialized. */
  private _loroDoc?: LoroDoc;
  /** The "properties" map inside the LoroDoc. Typed as any because the LoroMap generic causes issues with set(). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _loroMap?: any;
  /** Version vector at the time of last save, used to export deltas */
  private _loroVersionAtLastSave?: VersionVector;

  /**
   * Queue of commits that have been signed locally but not yet pushed to the
   * server. `signChanges()` appends here; `push()` drains it.
   */
  private _pendingCommits: Commit[] = [];

  /**
   * Signature of the most recently locally-signed commit.  Used as
   * `previousCommit` when chaining multiple local commits before pushing.
   */
  private _lastLocalSignature: string | undefined;

  /**
   * The subject of the most recently applied commit. This is the source of truth
   * for the commit chain and is protected from being clobbered by remote merges.
   */
  private _lastCommit: string | undefined;

  private inProgressCommit: Promise<void> | undefined;
  private hasQueue = false;
  /**
   * Coalesces concurrent {@link pushCommits} invocations onto a single
   * in-flight drain. Two callers must NOT both POST the same queued
   * commit — under load the second POST hits the server's
   * lookup→genesis-check TOCTOU and 500s with
   * "is_genesis: true, but the resource already exists". Reproduced in
   * `tests/genesis-double-push.integration.test.ts`.
   */
  private inProgressPush: Promise<string | undefined> | undefined;

  private _store?: Store;
  private eventManager = new EventManager<
    ResourceEvents,
    ResourceEventHandlers
  >();

  private errorRetries = 0;

  public constructor(subject: string, newResource?: boolean) {
    if (typeof subject !== 'string') {
      // Check if the subject is an object with an @id property
      if (subject && typeof subject === 'object' && '@id' in subject) {
        throw new Error(
          'Found named nested resource instead of subjects, this probably means your server is outdated.',
        );
      }

      throw new Error(
        'Invalid subject given to resource, must be a string, found ' +
          typeof subject,
      );
    }

    this.new = !!newResource;
    this._subject = subject;
    this.commitBuilder = new CommitBuilder(subject);
  }

  public get __internalObject(): Resource<C> {
    return this;
  }

  /**
   * Is true when the Resource is currently being fetched, awaiting a response
   * from the Server.
   * Use `resource.on(ResourceEvents.LoadingChange, (loading) => {})` to listen for changes.
   */
  public get loading(): boolean {
    if (this._loading) return true;
    // A resource with buffered Loro snapshot bytes but no doc isn't actually
    // readable yet — `get(prop)` returns undefined until Loro WASM hydrates
    // the buffer. Treat that as still loading so consumers (e.g. useTitle)
    // show a loading indicator instead of falling back to a truncated DID.
    // This window is short (typically <1s on cold reloads, when SYNC_PUSH
    // beats the Loro WASM init) but visible. The flag flips back to false
    // automatically — `getLoroDoc()` lazily imports the buffer the first
    // time anything reads through, after which `_loroSnapshotBytes` is
    // moved into the doc and this getter falls through to `_loading`.
    if (!this._loroDoc) {
      const buf = this._loroSnapshotBytes;
      if (
        (buf instanceof Uint8Array && buf.length > 0) ||
        (typeof buf === 'string' && buf.length > 0)
      ) {
        return true;
      }
    }
    return false;
  }

  /** The subject URL of the resource */
  public get subject(): string {
    return this._subject;
  }

  /** Stable reference to the resource, even when the resource is proxied, for example when using @tomic/react or @tomic/svelte. */
  public get stable(): Resource<C> {
    return this.__internalObject;
  }

  /** A human readable title for the resource, returns first of either: name, shortname, filename or subject */
  public get title(): string {
    return (this.get(core.properties.name) ??
      this.get(core.properties.shortname) ??
      this.get(server.properties.filename) ??
      this.get(core.properties.description) ??
      this.subject) as string;
  }

  /**
   * Dynamic prop accessor, only works for known properties registered via an ontology.
   * @example const description = resource.props.description
   */
  public get props(): QuickAccessPropType<C> {
    const defaultProps = {
      parent: core.properties.parent,
      isA: core.properties.isA,
      write: core.properties.write,
      read: core.properties.read,
    };

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const innerThis = this;

    const defs = this.getClasses()
      .map(c => getKnownClassDefBySubject(c))
      .filter(def => def !== undefined);

    const getPropSubject = (name: string) => {
      // Check if the property is a default property
      if (name in defaultProps) {
        return defaultProps[name as keyof typeof defaultProps];
      }

      // Check if the property is defined in any of the classes
      for (const def of defs) {
        const value = def[name];

        if (value !== undefined) {
          return value;
        }
      }

      // Check if any known property on the resource matches the requested name.
      for (const [key] of this.getEntries()) {
        const propName = getKnownNameBySubject(key);

        if (propName === name) {
          return key;
        }
      }
    };

    return new Proxy({} as QuickAccessPropType<C>, {
      get(_target, propName) {
        const propSubject = getPropSubject(propName as string);

        return innerThis.get(propSubject ?? '');
      },

      set(_target, propName, value) {
        const propSubject = getPropSubject(propName as string);

        if (!propSubject) {
          throw new Error(
            `Unable to set property: ${propName.toString()} on ${innerThis.subject}. The property's subject could not be found.`,
          );
        }

        innerThis.set(propSubject, value, false);

        return true;
      },
    });
  }

  /** Returns `true` when there are locally-signed commits waiting to be pushed. */
  public get hasPendingCommits(): boolean {
    return this._pendingCommits.length > 0;
  }

  /**
   * Restore previously-signed commits onto this resource — used by the store
   * when a hydrated resource needs its offline-persisted commit queue
   * re-attached after a page reload.
   */
  public setPendingCommits(commits: Commit[]): void {
    this._pendingCommits = [...commits];
  }

  private get store(): Store {
    if (!this._store) {
      console.error(`Resource ${this.subject} has no store`);
      throw new Error('Resource has no store');
    }

    return this._store;
  }

  public set loading(loading: boolean) {
    if (this._loading === loading) return;

    this._loading = loading;
    this.eventManager.emit(ResourceEvents.LoadingChange, loading);
  }
  public on<T extends ResourceEvents>(
    event: T,
    callback: ResourceEventHandlers[T],
  ) {
    return this.eventManager.register(event, callback);
  }

  /** @internal */
  public setStore(store: Store): void {
    this._store = store;
  }

  /** Returns true if a LoroDoc has been initialized for this resource. */
  public hasLoroDoc(): boolean {
    return this._loroDoc !== undefined;
  }

  /**
   * Returns the LoroDoc backing this resource, creating one if needed.
   * Returns undefined if Loro is not loaded.
   */
  public getLoroDoc(): LoroDoc | undefined {
    if (!LoroLoader.isLoaded()) {
      return undefined;
    }

    if (!this._loroDoc) {
      const { LoroDoc: LoroDocClass } = LoroLoader.Loro;
      this._loroDoc = new LoroDocClass();
      this._loroMap = this._loroDoc.getMap('properties');

      // If the resource has a persisted Loro snapshot, import it.
      const existingSnapshot = this._loroSnapshotBytes;
      let initializedFromSnapshot = false;

      if (
        existingSnapshot instanceof Uint8Array &&
        existingSnapshot.length > 0
      ) {
        this._loroDoc.import(existingSnapshot);
        initializedFromSnapshot = true;
      } else if (
        typeof existingSnapshot === 'string' &&
        existingSnapshot.length > 0
      ) {
        // May arrive as a base64 string from JSON-AD parsing
        this._loroDoc.import(decodeB64(existingSnapshot));
        initializedFromSnapshot = true;
      } else {
        for (const [key, value] of Object.entries(this._cache)) {
          this.loroSetProperty(key, value);
        }
      }

      // Heal: a Loro snapshot may be stale relative to the JSON-AD propvals
      // that arrived alongside it (the server's index can include properties
      // — e.g. `parent`, `isA` — that the resource's own snapshot was
      // produced before, or that the snapshot author never wrote into Loro).
      // Without this pass, those propvals get silently dropped when
      // `rebuildCacheFromLoro` below overwrites `_cache` with the snapshot's
      // contents only, and consumers see `resource.get(parent)` as
      // `undefined` for resources whose hierarchy is fully discoverable from
      // the JSON-AD payload. Write any cache key absent from the imported
      // doc into Loro before the cache rebuild — only when we actually
      // initialised from a snapshot, so the no-snapshot path's prior
      // behaviour is unchanged.
      if (initializedFromSnapshot && this._loroMap) {
        for (const [key, value] of Object.entries(this._cache)) {
          if (this._loroMap.get(key) === undefined) {
            this.loroSetProperty(key, value);
          }
        }
      }

      this.rebuildCacheFromLoro();
      this._cacheDirty = false;
      this._loroVersionAtLastSave =
        initializedFromSnapshot || (!this.new && !this._dirty)
          ? this._loroDoc.oplogVersion()
          : undefined;

      // Drained the buffer — `loading` getter now returns false (assuming
      // `_loading` was false). Emit `LoadingChange(false)` so subscribers
      // (useResource → useTitle, etc.) re-render and pick up the
      // freshly-materialized data. Without this, a resource that arrived
      // via SYNC_PUSH before Loro was ready would stay stuck on its
      // loading indicator until some other event happens to fire.
      if (initializedFromSnapshot && !this._loading) {
        this.eventManager.emit(ResourceEvents.LoadingChange, false);
      }
    }

    return this._loroDoc;
  }

  /** Returns the Loro properties map, or undefined if Loro isn't loaded */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getLoroMap(): any {
    if (!this._loroMap) {
      this.getLoroDoc();
    }

    return this._loroMap;
  }

  private applyRawValue(prop: string, val: AtomicValue): void {
    if (prop === commits.properties.loroUpdate) {
      if (val === undefined) {
        this._loroSnapshotBytes = undefined;
        this.resetLoroState();
        return;
      }

      if (!(val instanceof Uint8Array) && typeof val !== 'string') {
        throw new Error('loroUpdate must be a Uint8Array or base64 string');
      }

      this._loroSnapshotBytes = val;

      // If a Loro doc already exists, merge the incoming snapshot INTO it.
      // Tearing the doc down and rebuilding would allocate a fresh peer on
      // the next getLoroDoc(), making subsequent local ops concurrent with
      // stored state (silent LWW drop). If no doc exists yet, do nothing —
      // getLoroDoc() will build one from _loroSnapshotBytes on first access.
      if (this._loroDoc) {
        const bytes =
          val instanceof Uint8Array ? val : decodeB64(val as string);
        try {
          this._loroDoc.import(bytes);
          this.rebuildCacheFromLoro();
          this._cacheDirty = false;
          this.markLoroSaved();
        } catch (e) {
          console.warn(
            `[Resource] Loro import on hydration failed for ${this.subject}:`,
            e,
          );
        }
      }

      return;
    }

    // Binary values go to auxValues (Loro can't store raw Uint8Array)
    if (val instanceof Uint8Array) {
      this._auxValues.set(prop, val);
      return;
    }

    // If Loro doc exists, write through it (canonical path)
    if (this._loroDoc) {
      if (val === undefined) {
        this.loroDeleteProperty(prop);
      } else {
        this.loroSetProperty(prop, val as JSONValue);
      }

      this._cacheDirty = true;

      return;
    }

    // No Loro doc yet (hydration) — write to cache as temporary buffer.
    // getLoroDoc() will seed Loro from cache when it's first called.
    if (val === undefined) {
      delete this._cache[prop];
    } else {
      this._cache[prop] = val as JSONValue;
    }
  }

  /** Returns all property entries (cache + binary aux values) as a flat array. */
  public getEntries(): [string, AtomicValue][] {
    if (this._cacheDirty && this._loroDoc) {
      this.rebuildCacheFromLoro();
      this._cacheDirty = false;
    }

    return [
      ...Object.entries(this._cache),
      ...Array.from(this._auxValues.entries()),
    ];
  }

  private rebuildCacheFromLoro(): void {
    const propsMap = this.getLoroMap();
    const json = propsMap?.toJSON();
    const nextCache: Record<string, JSONValue> = Object.create(null);

    if (json && typeof json === 'object') {
      for (const [key, value] of Object.entries(json)) {
        nextCache[key] = normalizeLoroValue(value);
      }
    }

    this._cache = nextCache;
  }

  private resetLoroState(): void {
    this._loroDoc = undefined;
    this._loroMap = undefined;
    this._loroVersionAtLastSave = undefined;
  }

  /**
   * Write a value to the Loro map. This is called internally by set().
   * Converts JSON values to Loro-compatible types.
   */
  private loroSetProperty(prop: string, value: JSONValue): void {
    const map = this.getLoroMap();

    if (!map) {
      // Loro not loaded yet — write to cache as fallback.
      // getLoroDoc() will seed Loro from cache when it initializes.
      if (value === undefined || value === null) {
        delete this._cache[prop];
      } else {
        this._cache[prop] = value;
      }

      return;
    }

    if (value === undefined || value === null) {
      map.delete(prop);

      return;
    }

    // Loro accepts primitives and containers directly
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      map.set(prop, value);
    } else if (Array.isArray(value)) {
      // Use native LoroList for arrays — enables per-element CRDT merge.
      const { LoroList: LoroListClass } = LoroLoader.Loro;
      const list: LoroList = map.setContainer(prop, new LoroListClass());

      for (const item of value) {
        list.push(item);
      }
    } else {
      // Objects: serialize to JSON string.
      map.set(prop, JSON.stringify(value));
    }
  }

  /**
   * Remove a property from the Loro map.
   */
  private loroDeleteProperty(prop: string): void {
    const map = this.getLoroMap();

    if (!map) {
      delete this._cache[prop];

      return;
    }

    map.delete(prop);
  }

  /**
   * Export the Loro state to attach to the next outgoing commit.
   *
   * We export a full snapshot rather than a delta. Snapshots are
   * self-contained and their LWW merge semantics are robust: the server
   * applies the incoming snapshot on top of stored state and LWW picks the
   * locally-latest value. Deltas depend on the client's Lamport clock being
   * correctly advanced past stored state — and any edge case that leaves the
   * client's delta ops at a lower Lamport than stored (e.g. a stale
   * `_loroVersionAtLastSave`) silently loses the write. The size cost of
   * sending a full snapshot per commit is trivial for a single resource,
   * and the correctness is worth far more.
   *
   * Returns undefined if there are no Loro changes or Loro isn't loaded.
   */
  private exportLoroDelta(): Uint8Array | undefined {
    if (!this._loroDoc) {
      return undefined;
    }

    const snapshot = this._loroDoc.export({ mode: 'snapshot' });

    // A header-only snapshot (no ops) means "no changes worth sending".
    if (snapshot.length <= 4) {
      return undefined;
    }

    // If we have a baseline, check there were actual new ops since.
    if (this._loroVersionAtLastSave) {
      const deltaProbe = this._loroDoc.export({
        mode: 'update',
        from: this._loroVersionAtLastSave,
      });

      if (deltaProbe.length <= 4) {
        return undefined;
      }
    }

    return snapshot;
  }

  /**
   * Mark the current Loro state as "saved" — subsequent deltas will be
   * computed from this point.
   */
  private markLoroSaved(): void {
    if (this._loroDoc) {
      this._loroVersionAtLastSave = this._loroDoc.oplogVersion();
    }
  }

  private cloneLoroStateFrom(resource: Resource): void {
    this.resetLoroState();

    if (!LoroLoader.isLoaded()) {
      return;
    }

    // Get snapshot bytes from the source: either from its live doc or stored bytes
    let snapshot: Uint8Array | undefined;

    if (resource._loroDoc) {
      snapshot = resource._loroDoc.export({ mode: 'snapshot' });
    } else if (resource._loroSnapshotBytes instanceof Uint8Array) {
      snapshot = resource._loroSnapshotBytes;
    } else if (
      typeof resource._loroSnapshotBytes === 'string' &&
      resource._loroSnapshotBytes.length > 0
    ) {
      snapshot = decodeB64(resource._loroSnapshotBytes);
    }

    if (!snapshot || snapshot.length === 0) {
      return;
    }

    const { LoroDoc: LoroDocClass } = LoroLoader.Loro;
    this._loroDoc = new LoroDocClass();
    this._loroDoc.import(snapshot);
    this._loroMap = this._loroDoc.getMap('properties');

    this._loroVersionAtLastSave = resource._loroVersionAtLastSave
      ? this._loroDoc.oplogVersion()
      : undefined;
  }

  /** Checks if the content of two Resource instances is equal */
  public equals(resourceB: Resource): boolean {
    if (this === resourceB.__internalObject) {
      return true;
    }

    if (this.subject !== resourceB.subject) {
      return false;
    }

    if (this.new !== resourceB.new) {
      return false;
    }

    if (this.error !== resourceB.error) {
      return false;
    }

    if (this.loading !== resourceB.loading) {
      return false;
    }

    if (
      JSON.stringify(this.getEntries()) !==
      JSON.stringify(resourceB.getEntries())
    ) {
      return false;
    }

    return true;
  }

  /** Checks if the agent has write rights by traversing the graph. Recursive function. */
  public async canWrite(
    agent?: string,
    child?: string,
  ): Promise<[boolean, string | undefined]> {
    if (!agent) {
      return [false, 'No agent given'];
    }

    // Agents can always edit their own resource (e.g. their profile)
    if (agent === this.subject) {
      return [true, undefined];
    }

    const writeArray = this.get(core.properties.write);

    if (writeArray && valToArray(writeArray).includes(agent)) {
      return [true, undefined];
    }

    if (writeArray && valToArray(writeArray).includes(instances.publicAgent)) {
      return [true, undefined];
    }

    const parentSubject = this.get(properties.parent) as string;

    if (!parentSubject) {
      return [false, `No write right or parent in ${this.subject}`];
    }

    // Agents can always edit themselves
    if (parentSubject === agent) {
      return [true, undefined];
    }

    // This should not happen, but it prevents an infinite loop
    if (child === parentSubject) {
      console.warn('Circular parent', child);

      return [true, `Circular parent in ${this.subject}`];
    }

    const parent: Resource = await this.store.getResource(parentSubject);

    // The recursive part
    return await parent.canWrite(agent, this.subject);
  }

  /**
   * Creates a clone of the Resource, which makes sure the reference is
   * different from the previous one. This can be useful when doing reference compares.
   */
  public clone(): Resource<C> {
    const res = new Resource(this.subject);

    res._cache = structuredClone(this._cache);
    res._auxValues = new Map(
      structuredClone(Array.from(this._auxValues.entries())),
    );
    res._loroSnapshotBytes = this._loroSnapshotBytes;

    res.loading = this.loading;
    res.new = this.new;
    res.error = structuredClone(this.error);
    res.commitError = this.commitError;
    res.commitBuilder = this.commitBuilder.clone();
    res._dirty = this._dirty;
    res.appliedCommitSignatures = this.appliedCommitSignatures;
    res._pendingCommits = [...this._pendingCommits];
    res._lastLocalSignature = this._lastLocalSignature;

    res.cloneLoroStateFrom(this);

    return res as Resource<C>;
  }

  /**
   * Merges a resource into this resource using Loro CRDT merge.
   *
   * Both sides' Loro state is imported into a single doc. Loro handles
   * conflict resolution automatically — both local offline edits and
   * remote server edits survive. The cache is then rebuilt from the
   * merged Loro state.
   */
  public merge(resourceB: Resource): void {
    if (this.subject !== resourceB.subject) {
      throw new Error('Cannot merge resources with different subjects');
    }

    // Get the incoming Loro bytes (from live doc or stored snapshot)
    let incomingSnapshot: Uint8Array | undefined;

    if (resourceB._loroDoc) {
      incomingSnapshot = resourceB._loroDoc.export({ mode: 'snapshot' });
    } else if (resourceB._loroSnapshotBytes instanceof Uint8Array) {
      incomingSnapshot = resourceB._loroSnapshotBytes;
    } else if (
      typeof resourceB._loroSnapshotBytes === 'string' &&
      resourceB._loroSnapshotBytes.length > 0
    ) {
      incomingSnapshot = decodeB64(resourceB._loroSnapshotBytes);
    }

    if (
      incomingSnapshot &&
      incomingSnapshot.length > 0 &&
      LoroLoader.isLoaded()
    ) {
      // Ensure we have a local Loro doc
      const localDoc = this.getLoroDoc();

      if (localDoc) {
        // Import the incoming state — Loro merges via CRDT
        try {
          localDoc.import(incomingSnapshot);
        } catch (e) {
          // Import can fail if the snapshot is from an incompatible version.
          // Fall back to replacing state entirely.
          console.warn(
            `[Resource] Loro merge failed for ${this.subject}, replacing:`,
            e,
          );
          this.resetLoroState();
          this._loroSnapshotBytes = resourceB._loroSnapshotBytes;
          this._cache = structuredClone(resourceB._cache);
          this._auxValues = new Map(
            structuredClone(Array.from(resourceB._auxValues.entries())),
          );
        }

        // Rebuild the read cache from the merged Loro doc
        this.rebuildCacheFromLoro();
        this._cacheDirty = false;
        this.markLoroSaved();
      } else {
        // No local Loro doc — just take the incoming state. `resourceB` is
        // discarded after merge (the store keeps `this`), so we can take
        // ownership of its cache and auxValues directly instead of paying
        // a `structuredClone` deep copy on every WS UPDATE. The shallow
        // Map copy keeps callers from accidentally mutating the source's
        // entries, which is the only invariant `structuredClone` was
        // protecting here.
        this._cache = resourceB._cache;
        this._auxValues = new Map(resourceB._auxValues);
        this._loroSnapshotBytes = resourceB._loroSnapshotBytes;
      }
    } else {
      // No Loro state on the incoming resource — use plain cache replacement.
      // Don't touch the local Loro doc (if any) — incoming has no Loro data
      // to contribute, so local Loro state should be preserved. Same
      // ownership-transfer rationale as the branch above.
      this._cache = resourceB._cache;
      this._auxValues = new Map(resourceB._auxValues);
    }

    this.new = resourceB.new;
    this.error = resourceB.error;
    this.commitError = resourceB.commitError;

    // Only update _lastCommit if the remote version has one and we don't have one,
    // or if they are different (assuming the remote one is newer if it comes from the store).
    const remoteLastCommit = resourceB
      .get(properties.commit.lastCommit)
      ?.toString();

    if (remoteLastCommit && remoteLastCommit !== this._lastCommit) {
      this._lastCommit = remoteLastCommit;
    }

    // We set this last because it will trigger a loading change event.
    this.loading = resourceB.loading;
  }

  /**
   * Marks the next commit as a DID genesis commit. Must be called before
   * {@link signChanges} when creating a brand-new DID resource. This is the
   * only way to produce a genesis commit — the old implicit detection based on
   * `_new:` subject prefixes has been removed to prevent accidental genesis.
   */
  public markNextCommitAsGenesis(): void {
    this.commitBuilder.setIsGenesis(true);
  }

  /** Checks if the resource is both loaded and free from errors */
  public isReady(): boolean {
    return !this.loading && this.error === undefined;
  }

  /** Get a Value by its property
   * @param propUrl The subject of the property
   * @example
   * import { core } from '@tomic/lib'
   * const description = resource.get(core.properties.description)
   * const publishedAt = resource.get('https://my-atomicserver.dev/properties/published-at')
   */
  public get<Prop extends string, Returns = InferTypeOfValueInTriple<C, Prop>>(
    propUrl: Prop,
  ): Returns {
    if (this._cacheDirty && this._loroDoc) {
      this.rebuildCacheFromLoro();
      this._cacheDirty = false;
    }

    return (this._auxValues.get(propUrl) ?? this._cache[propUrl]) as Returns;
  }

  /**
   * Get a Value by its property, returns as Array with subjects instead of the
   * full resource or throws error. Returns empty array if there is no value
   */
  public getSubjects(propUrl: string): string[] {
    return this.getArray(propUrl).map(item => {
      if (typeof item === 'string') return item;

      return (item as JSONObject)['@id'] as string;
    });
  }

  /**
   * Get a Value by its property, returns as Array or throws error. Returns
   * empty array if there is no value
   */
  public getArray(propUrl: string): JSONArray {
    const result = this.get(propUrl) ?? [];

    return valToArray(result);
  }

  /** Returns a list of classes of this resource */
  public getClasses(): string[] {
    return this.getSubjects(core.properties.isA);
  }

  /** Checks if the resource is all of the given classes */
  public hasClasses(...classSubjects: string[]): boolean {
    return classSubjects.every(classSubject =>
      this.getClasses().includes(classSubject),
    );
  }

  /**
   * `.matchClass()` takes an object that maps class subjects to values.
   * If the resource has a class that is a key in the object, the corresponding value is returned.
   * An optional fallback value can be provided as the second argument.
   * The order of the classes in the object is important, as the first match is returned.
   */
  public matchClass<T>(obj: Record<string, T>): T | undefined;
  public matchClass<T>(obj: Record<string, T>, fallback: T): T;
  public matchClass<T>(obj: Record<string, T>, fallback?: T): T | undefined {
    for (const [classSubject, value] of Object.entries(obj)) {
      if (this.hasClasses(classSubject)) {
        return value;
      }
    }

    return fallback;
  }

  /** Remove the given classes from the resource */
  public removeClasses(...classSubjects: string[]): void {
    // Using .set on this somehow has other typescript rules than using resource.set. Casting to Resource seems to fix this.
    (this as Resource).set(
      core.properties.isA,
      this.getClasses().filter(
        classSubject => !classSubjects.includes(classSubject),
      ),
      false,
    );
  }

  /** Adds the given classes to the resource */
  public addClasses(...classSubject: string[]): Promise<void> {
    const classesSet = new Set([...this.getClasses(), ...classSubject]);

    // Using .set on this somehow has other typescript rules than using resource.set. Casting to Resource seems to fix this.
    return (this as Resource).set(
      core.properties.isA as string,
      Array.from(classesSet),
    );
  }

  /** Returns true if the resource has unsaved local changes. */
  public hasUnsavedChanges(): boolean {
    return this.commitBuilder.hasUnsavedChanges() || this._dirty;
  }

  /** Mark the resource as having unsaved local changes.
   *  Use this when external code (e.g. Loro editor plugins) modifies the
   *  resource's LoroDoc directly without going through `set()`. */
  public markDirty(): void {
    this._dirty = true;
    this.eventManager.emit(ResourceEvents.LocalChange, '', undefined);
  }

  public getCommitsCollectionSubject(): string {
    // For DID subjects (or other non-HTTP URIs) we can't derive the server
    // origin from the subject itself — use the store's server URL instead.
    const base =
      this.subject.startsWith('did:') || this.subject.startsWith('_')
        ? this.store.getServerUrl()
        : this.subject;
    const url = new URL('/query', base);
    url.searchParams.append('property', commits.properties.subject);
    url.searchParams.append('value', this.subject);
    url.searchParams.append('sort_by', commits.properties.createdAt);
    url.searchParams.append('include_nested', 'true');
    url.searchParams.append('page_size', '9999');

    return url.toString();
  }

  /** Returns a Collection with all children of this resource
   * @param pageSize The amount of children per page (default: 100)
   */
  public async getChildrenCollection(pageSize = 100): Promise<Collection> {
    return await new CollectionBuilder(this.store)
      .setPageSize(pageSize)
      .setProperty(core.properties.parent)
      .setValue(this.subject)
      .buildAndFetch();
  }

  /**
   * Get the history of this resource from its Loro OpLog.
   * Returns an array of Versions, each with materialized property values
   * at that point in time. Uses Loro's `checkout()` for instant time-travel
   * — no network round-trips needed.
   */
  public getLoroHistory(): Version[] {
    const doc = this.getLoroDoc();

    if (!doc) {
      return [];
    }

    // Loro merges sequential same-peer ops into a single Change whose
    // `length` is the operation count. Iterating only over Changes therefore
    // collapses every edit between commits into one version. To recover one
    // version per *commit* we walk every op counter inside each Change and
    // group by `lastCommit` — the property the runtime writes when a commit
    // applies. The state captured for each lastCommit is the **last** op
    // counter that carried it, i.e. the state right before the next commit
    // overwrote `lastCommit`. That's the snapshot that was actually saved.
    type Step = {
      peer: string;
      counter: number;
      timestamp: number;
      message: string | undefined;
    };
    const steps: Step[] = [];

    for (const [peer, changes] of doc.getAllChanges().entries()) {
      for (const change of changes) {
        for (let i = 0; i < change.length; i++) {
          steps.push({
            peer,
            counter: change.counter + i,
            timestamp: change.timestamp,
            message: change.message,
          });
        }
      }
    }

    // Sort by timestamp (oldest first), then by counter. Loro often reports
    // timestamp=0 for offline edits, so the counter tiebreaker keeps things
    // monotonic per peer — but cross-peer order is best-effort.
    steps.sort((a, b) => a.timestamp - b.timestamp || a.counter - b.counter);

    const lastCommitProp = 'https://atomicdata.dev/properties/lastCommit';
    type GroupedVersion = {
      lastCommitKey: string;
      contentKey: string;
      step: Step;
      propvals: Map<string, JSONValue>;
    };
    const grouped: GroupedVersion[] = [];

    /** Stable signature of the propvals minus `lastCommit`, used to detect
     *  versions that represent the same observable state arrived at from
     *  different peers (e.g. the same snapshot reimported during sync). */
    const contentSignature = (pv: Map<string, JSONValue>): string => {
      const entries = Array.from(pv.entries())
        .filter(([k]) => k !== lastCommitProp)
        .sort(([a], [b]) => a.localeCompare(b));

      return JSON.stringify(entries);
    };

    for (const step of steps) {
      const frontiers = [
        { peer: step.peer as `${number}`, counter: step.counter },
      ];

      try {
        doc.checkout(frontiers);
      } catch {
        continue;
      }

      const propsMap = doc.getMap('properties');
      const propvals = new Map<string, JSONValue>();

      if (propsMap) {
        const json = propsMap.toJSON();

        if (json && typeof json === 'object') {
          for (const [key, value] of Object.entries(json)) {
            propvals.set(key, value as JSONValue);
          }
        }
      }

      // Bucket by lastCommit. An empty lastCommit (pre-genesis) is its own
      // bucket. The latest entry per bucket wins — that's the final saved
      // state under that commit.
      const lastCommitKey = String(propvals.get(lastCommitProp) ?? '');
      const cKey = contentSignature(propvals);

      const existing = grouped.find(g => g.lastCommitKey === lastCommitKey);

      if (existing) {
        existing.step = step;
        existing.propvals = propvals;
        existing.contentKey = cKey;
      } else {
        grouped.push({
          lastCommitKey,
          contentKey: cKey,
          step,
          propvals,
        });
      }
    }

    // Drop earlier buckets whose content signature matches a later one — they
    // represent the same observable state, just under a different lastCommit
    // (e.g. a snapshot reimported from a peer). Keeping only the freshest
    // entry per content gives one version per real saved state.
    const seenContent = new Set<string>();
    const dedupedReverse: GroupedVersion[] = [];

    for (let i = grouped.length - 1; i >= 0; i--) {
      const g = grouped[i];

      if (seenContent.has(g.contentKey)) continue;
      seenContent.add(g.contentKey);
      dedupedReverse.push(g);
    }

    const deduped = dedupedReverse.reverse();

    const versions: Version[] = deduped.map(g => ({
      peer: g.step.peer,
      timestamp: g.step.timestamp * 1000, // Loro uses seconds, we use ms
      frontiers: [
        { peer: g.step.peer as `${number}`, counter: g.step.counter },
      ],
      message: g.step.message,
      propvals: g.propvals,
    }));

    // Restore to latest version
    doc.checkoutToLatest();

    return versions;
  }

  /**
   * Sets the resource to the specified version and saves it.
   * @param version The version to set the resource to, you can get this using `resource.getHistory()`
   */
  public async setVersion(version: Version): Promise<void> {
    // Remove any prop that doesn't exist in this version
    for (const [prop] of this.getEntries()) {
      if (!version.propvals.has(prop)) {
        this.remove(prop);
      }
    }

    // Set all properties from the version
    for (const [key, value] of version.propvals.entries()) {
      if (value === undefined) continue;
      await this.set(key, value);
    }

    // TODO: We should let the user save, this is what we usually do.
    await this.save();
  }

  /**
   * @deprecated use resource.subject
   */
  public getSubject(): string {
    return this.subject;
  }

  /** Returns the subject URL of the Resource */
  public getSubjectNoParams(): string {
    // DID subjects (did:ad:...) don't have meaningful origin/pathname.
    if (this.subject.startsWith('did:') || this.subject.startsWith('_')) {
      return this.subject;
    }

    const url = new URL(this.subject);

    return url.origin + url.pathname;
  }

  /** Applies a batch of non-validating values during hydration or derived updates. */
  public applyHydratedValues(values: Iterable<[string, AtomicValue]>): void {
    for (const [key, value] of values) {
      this.applyRawValue(key, value);
    }
  }

  /** Returns a JSON-safe object view for storage and diagnostics. */
  public toObject(
    opts: { includeBinary?: boolean } = {},
  ): Record<string, unknown> | null {
    const { includeBinary = false } = opts;
    const obj: Record<string, unknown> = { '@id': this.subject };
    let count = 0;

    for (const [key, value] of this.getEntries()) {
      if (!includeBinary && value instanceof Uint8Array) {
        continue;
      }

      obj[key] = value;
      count++;
    }

    return count === 0 ? null : obj;
  }

  /** Compact debug representation for error messages. */
  public debugValueSummary(): string {
    const objectView = this.toObject({ includeBinary: false });

    return objectView ? JSON.stringify(objectView) : '{}';
  }

  /** Updates the cached lastCommit metadata without treating it as a user edit. */
  public setLastCommitValue(lastCommit: string): void {
    this._lastCommit = lastCommit;
    this.applyRawValue(properties.commit.lastCommit, lastCommit);
  }

  public setCreatedAtValue(createdAt: number): void {
    this.applyRawValue(commits.properties.createdAt, createdAt);
  }

  /**
   * Iterates over the parents of the resource, returns who has read / write
   * rights for this resource
   */
  public async getRights(): Promise<Right[]> {
    const rights: Right[] = [];
    const write: string[] = this.getSubjects(properties.write);
    write.forEach((subject: string) => {
      rights.push({
        for: subject,
        type: RightType.WRITE,
        setIn: this.subject,
      });
    });

    const read: string[] = this.getSubjects(properties.read);
    read.forEach((subject: string) => {
      rights.push({
        for: subject,
        type: RightType.READ,
        setIn: this.subject,
      });
    });
    const parentSubject = this.get(properties.parent) as string;

    if (parentSubject) {
      if (parentSubject === this.subject) {
        console.warn('Circular parent', parentSubject);

        return rights;
      }

      const parent = await this.store.getResource(parentSubject);
      const parentRights = await parent.getRights();
      rights.push(...parentRights);
    }

    return rights;
  }

  /** Returns true is the resource had an `Unauthorized` 401 response. */
  public isUnauthorized(): boolean {
    return !!this.error && isUnauthorized(this.error);
  }

  /** Removes the resource form both the server and locally */
  public async destroy(agent?: Agent): Promise<void> {
    if (this.new) {
      this.store.removeResource(this.subject);

      return;
    }

    const newCommitBuilder = new CommitBuilder(this.subject);
    newCommitBuilder.setDestroy(true);

    // The server rejects destroy commits without `previousCommit` for
    // non-genesis resources. If a fetch is in flight, wait for it.
    if (this.loading) {
      await this.store.getResource(this.subject).catch(() => undefined);
    }

    const lastCommit =
      this._lastCommit ?? this.get(properties.commit.lastCommit)?.toString();

    if (lastCommit) {
      newCommitBuilder.setPreviousCommit(lastCommit);
    }

    if (agent === undefined) {
      agent = this.store.getAgent();
    }

    if (agent?.subject === undefined) {
      throw new Error(
        'No agent has been set or passed, you cannot delete this.',
      );
    }

    const commit = await newCommitBuilder.sign(agent);
    // DIDs don't have an origin, so use the store's server URL
    const endpoint = this.subject.startsWith('did:')
      ? new URL('/commit', this.store.getServerUrl()).toString()
      : new URL(this.subject).origin + `/commit`;
    await this.store.postCommit(commit, endpoint);
    this.store.removeResource(this.subject);
  }

  /** @deprecated use `resource.push` */
  public pushPropVal(propUrl: string, values: JSONArray, unique?: boolean) {
    this.push(propUrl, values, unique);
  }

  /** Appends a Resource to a ResourceArray */
  public push(propUrl: string, values: JSONArray, unique?: boolean): void {
    const propVal = (this.get(propUrl) as JSONArray) ?? [];

    if (unique) {
      values = values
        .filter(value => !propVal.includes(value))
        .filter((value, index, self) => self.indexOf(value) === index);
    }

    // Build a new array so that the reference changes. This is needed in most UI frameworks.
    const newArray = [...propVal, ...values];
    this.loroSetProperty(propUrl, newArray);
    this._cacheDirty = true;
    this._dirty = true;
  }

  /** @deprecated use `resource.remove()` */
  public removePropVal(propertyUrl: string): void {
    this.remove(propertyUrl);
  }

  /** Removes a property value combination from the resource */
  public remove(propertyUrl: string): void {
    this.removeUnsafe(propertyUrl);
    this._dirty = true;
  }

  /**
   * Sign pending changes into a {@link Commit} and queue it locally.
   *
   * - For DID genesis commits the subject is replaced with `did:ad:<signature>`.
   * - Locally-queued commits are chained via their signatures so that
   *   `previousCommit` stays consistent even before pushing.
   * - Call {@link pushCommits} (or {@link save}) to send the queued commits to
   *   the server.
   *
   * @returns The signed {@link Commit}.
   */
  public async signChanges(differentAgent?: Agent): Promise<Commit> {
    const agent = this.store.getAgent() ?? differentAgent;

    if (!agent) {
      console.error('[signChanges] No agent set');
      throw new Error('No agent has been set or passed, you cannot sign.');
    }

    // Ensure all cached properties are in the Loro doc before signing.
    // This catches properties set via cache hydration that haven't been
    // written to Loro yet (e.g. write/read permissions during creation).
    if (LoroLoader.isLoaded()) {
      this.getLoroDoc();
      this.rebuildCacheFromLoro();
      this._cacheDirty = false;
    }

    // Chain: use last locally-signed commit, or the server-known lastCommit.
    if (this._lastLocalSignature) {
      // Construct the full commit URL that the server will use.  This ensures
      // the serialization signed here matches what the server will produce when
      // it verifies the signature.  The server stores commit resources at
      // `{origin}/commits/{signature}`.
      const commitUrl = `did:ad:commit:${this._lastLocalSignature}`;
      this.commitBuilder.setPreviousCommit(commitUrl);
    } else {
      const lastCommit =
        this._lastCommit ?? this.get(properties.commit.lastCommit)?.toString();

      if (lastCommit) {
        this.commitBuilder.setPreviousCommit(lastCommit);
      }
    }

    // Export Loro delta — this is the sole carrier of property changes.
    const loroDelta = this.exportLoroDelta();

    if (!this.commitBuilder.hasUnsavedChanges() && !loroDelta) {
      this._dirty = false;
      this.markLoroSaved();
      console.error('[signChanges] No changes to sign');
      throw new Error(`No changes to sign for ${this.subject}`);
    }

    if (loroDelta) {
      this.commitBuilder.setLoroUpdate(loroDelta);
    }

    // Auto-detect genesis: no previousCommit means this is a new resource.
    // The server requires is_genesis=true for DID resources without a previous commit.
    // Only for DID-eligible subjects (_new: or did:ad:) — HTTP URLs use server-assigned subjects.
    // Agents are excluded: their identity is fixed by their public key
    // (did:ad:agent:<pubkey>), not derived from a genesis-commit signature.
    // Marking an agent commit as genesis triggers `delete subject` below,
    // which makes the server's parser derive the resource subject as
    // `did:ad:<signature>` and silently store the agent's data under a
    // commit-id key instead of the agent DID — subsequent fetches of the
    // agent then 404 in `get_propvals` and fall through to a synthetic
    // 4-property view (createdAt, isA, publicKey, read).
    const isDIDEligible =
      this.subject.startsWith('_new:') || this.subject.startsWith('did:ad:');
    const isAgent = this.subject.startsWith('did:ad:agent:');

    if (
      isDIDEligible &&
      !isAgent &&
      !this.commitBuilder.previousCommit &&
      !this._lastLocalSignature
    ) {
      this.commitBuilder.setIsGenesis(true);
    }

    // Clone the builder so new changes after this call go into a fresh one.
    const builder = this.commitBuilder.clone();
    this.commitBuilder = new CommitBuilder(this.subject);
    this._dirty = false;
    this.markLoroSaved();
    const commit = await builder.sign(agent);

    // DID genesis: the real subject is derived from the signature.
    if (commit.subject !== this.subject) {
      const oldSubject = this.subject;
      this._subject = commit.subject;
      // Update the fresh commitBuilder to use the real subject.
      this.commitBuilder = new CommitBuilder(commit.subject);

      if (this._store) {
        // Silently move the resource in the store map — don't use removeResource()
        // which emits events that trigger cascading fetches (sideBarHandler etc.)
        this.store.resources.delete(oldSubject);
        // Keep an alias so children that reference the old _new: subject can still find it.
        this.store.applyIncoming({
          subject: oldSubject,
          resource: this,
          source: 'local-pre-push',
        });
      }
    }

    this.appliedCommitSignatures.add(commit.signature);
    this._lastLocalSignature = commit.signature;
    this._pendingCommits.push(commit);
    this.loading = false;
    this.new = false;

    // Surface the queued commit in the Sync page's commit log immediately,
    // so users can see what's pending without waiting for the push. The same
    // log entry transitions in place to `sent` / `failed` when pushCommits
    // resolves.
    this.store.logPendingCommit(commit);

    return commit;
  }

  /**
   * Push all locally-queued commits to the server, in order.
   *
   * After a successful push the resource's `lastCommit` is updated from the
   * server response and the local queue is cleared.
   *
   * Concurrent invocations (e.g. two `syncDirtyResources` calls fired by a
   * fast WS reconnect flap) are coalesced onto the same in-flight drain via
   * {@link inProgressPush} — the second caller observes the first's POST
   * result instead of double-POSTing the queued commits. Without that
   * guard the dagger CI runner reproducibly hits
   * "Commit for did:ad:… has is_genesis: true, but the resource already
   * exists" when both pushes race the server's lookup→apply window.
   */
  public async pushCommits(): Promise<string | undefined> {
    if (this._pendingCommits.length === 0) {
      return undefined;
    }

    if (this.inProgressPush) {
      return this.inProgressPush;
    }

    const drain = this._drainPendingCommits();
    this.inProgressPush = drain;
    try {
      return await drain;
    } finally {
      // Clear AFTER await so a concurrent caller arriving mid-drain still
      // joins this same promise; only post-resolution does the next call
      // start a fresh drain.
      this.inProgressPush = undefined;
    }
  }

  private async _drainPendingCommits(): Promise<string | undefined> {
    const endpoint = this.getCommitEndpoint();
    const wasNew =
      this._pendingCommits.length > 0 &&
      this._pendingCommits[0].previousCommit === undefined;

    let lastCommitId: string | undefined;

    try {
      this.commitError = undefined;
      // Pre-push: surface in-flight state to subscribers.
      this.store.applyIncoming({
        subject: this.subject,
        resource: this,
        source: 'local-pre-push',
      });

      while (this._pendingCommits.length > 0) {
        const commit = this._pendingCommits[0];
        const created = await this.store.postCommit(commit, endpoint);
        lastCommitId =
          (created.id as string | undefined) ??
          (created.signature
            ? `did:ad:commit:${created.signature}`
            : undefined);
        this._pendingCommits.shift();
      }

      this._lastLocalSignature = undefined;
      if (lastCommitId) this.setLastCommitValue(lastCommitId);
      this.store.notifyResourceSaved(this);

      // Post-ack re-add: triggers the OPFS persist gate (which
      // skips when `hasPendingCommits` is true).
      this.store.applyIncoming({
        subject: this.subject,
        resource: this,
        source: 'local-acked',
        commitId: lastCommitId,
      });

      // Push referenced blobs. Awaited so a follow-up commit
      // referencing the blob doesn't race the server-side extender.
      await this.store.maybePushBlobForResource(this).catch(() => undefined);

      if (wasNew) {
        // First SUBSCRIBE wouldn't have worked pre-create. #486.
        this.store.subscribeWebSocket(this.subject);
        await this.store.saveBatchForParent(this.subject);
      }

      return lastCommitId;
    } catch (e) {
      this.commitError = e;
      throw e;
    }
  }

  /**
   * Saves the resource as a new DID-native resource.
   * The subject will be set to `did:ad:{genesis_signature}`.
   */
  public async saveAsGenesis(): Promise<string> {
    const agent = this.store.getAgent();

    if (!agent) {
      throw new Error('No agent set, cannot sign genesis commit');
    }

    // Explicitly mark as genesis so signChanges derives the DID subject from
    // the signature rather than relying on implicit subject-pattern detection.
    this.markNextCommitAsGenesis();

    await this.signChanges(agent);
    // signChanges has already updated this._subject to did:ad:{signature}.

    const result = await this.pushCommits();

    return result as string;
  }

  /**
   * Commits the changes and sends the Commit to the resource's `/commit`
   * endpoint. Returns the Url of the created Commit. If you don't pass an Agent
   * explicitly, the default Agent of the Store is used.
   * When there are no changes no commit is made and the function returns Promise<undefined>.
   *
   * This is equivalent to calling {@link signChanges} followed by {@link pushCommits}.
   */
  public async save(differentAgent?: Agent): Promise<string | undefined> {
    const hasChanges = this.hasUnsavedChanges();

    if (!hasChanges && this._pendingCommits.length === 0) {
      // Save called on a clean resource (typical on blur with no edits) — not
      // an error worth surfacing to the console.
      return undefined;
    }

    const agent = this.store.getAgent() ?? differentAgent;

    if (!agent) {
      throw new Error('No agent has been set or passed, you cannot save.');
    }

    if (this.hasQueue) {
      return;
    }

    if (!this._lastCommit) {
      this._lastCommit = this.get(properties.commit.lastCommit)?.toString();
    }

    // If the parent of this resource is new we can't save yet so we add it to a batched that gets saved when the parent does.
    if (this.isParentNew()) {
      this.store.batchResource(this.subject);

      return;
    }

    if (this.inProgressCommit) {
      this.hasQueue = true;
      await this.inProgressCommit;
      this.hasQueue = false;
      this.inProgressCommit = undefined;

      return this.save(differentAgent);
    }

    let reportDone: () => void = () => undefined;

    this.inProgressCommit = new Promise(resolve => {
      reportDone = () => {
        resolve();
      };
    });

    // Keep a backup of the commit builder in case push fails.
    const oldCommitBuilder = hasChanges
      ? this.commitBuilder.clone()
      : undefined;
    const wasNew = this.new;

    try {
      // Sign any unsaved changes into the local queue.
      if (hasChanges) {
        try {
          await this.signChanges(agent);
        } catch (e) {
          if (
            e instanceof Error &&
            e.message.startsWith('No changes to sign')
          ) {
            reportDone();

            return undefined;
          }

          throw e;
        }
      }

      // If the server is not connected, save locally and queue for sync.
      if (!this.store.serverConnected) {
        await this.applyPendingCommitsLocally();
        this.commitError = undefined;
        this.loading = false;
        // Notify subscribers so the UI updates (e.g. sidebar sees new subResources)
        this.store.applyIncoming({
          subject: this.subject,
          resource: this,
          source: 'offline-replay',
        });
        this.store.notifyResourceSaved(this);
        reportDone();

        return undefined;
      }

      // Push all queued commits to the server.
      const result = await this.pushCommits();

      reportDone();

      return result;
    } catch (e) {
      // Network error (server went down mid-request) — apply locally and queue for sync.
      if (isNetworkError(e)) {
        this.store.setServerConnected(false);
        await this.applyPendingCommitsLocally();
        this.commitError = undefined;
        this.loading = false;
        this.store.applyIncoming({
          subject: this.subject,
          resource: this,
          source: 'offline-replay',
        });
        this.store.notifyResourceSaved(this);
        reportDone();

        return undefined;
      }

      // Logic for handling error if the previousCommit is wrong.
      if (e.message?.includes('previousCommit')) {
        if (this.errorRetries > 3) {
          this.errorRetries = 0;
          throw e;
        }

        this.errorRetries++;

        console.warn('previousCommit missing or mismatch, retrying...');
        const resourceFetched = await this.store.fetchResourceFromServer(
          this.subject,
        );

        if (resourceFetched.error) {
          throw resourceFetched.error;
        }

        const fixedLastCommit = resourceFetched!
          .get(properties.commit.lastCommit)
          ?.toString();

        if (fixedLastCommit) {
          this.setLastCommitValue(fixedLastCommit);
        }

        reportDone();

        return await this.save(agent);
      }

      // Revert the commit builder on failure.
      if (oldCommitBuilder) {
        this.commitBuilder = oldCommitBuilder;
      }

      this.commitError = e;
      this.new = wasNew;
      this.store.applyIncoming({
        subject: this.subject,
        resource: this,
        source: 'local-pre-push',
      });
      reportDone();
      throw e;
    }
  }

  /** Persist the current resource state offline: each pending
   * commit becomes a CommitDetail-renderable resource, the
   * resource itself is persisted atomically (JSON-AD + Loro
   * snapshot), and the outbox is updated so the queue survives
   * a reload. `_pendingCommits` stays in-memory until drain. */
  private async applyPendingCommitsLocally(): Promise<void> {
    // Server sets createdAt on apply; we need it locally for sort.
    if (this.get(commits.properties.createdAt) === undefined) {
      this.setCreatedAtValue(Date.now());
    }

    let lastCommitSubject: string | undefined;
    for (const commit of this._pendingCommits) {
      const commitSubject = `did:ad:commit:${commit.signature}`;
      lastCommitSubject = commitSubject;
      const commitResource = new Resource(commitSubject);
      commitResource.applyHydratedValues(
        Object.entries(commitToJsonADObject(commit)) as [string, AtomicValue][],
      );
      commitResource.loading = false;
      commitResource.new = false;
      this.store.applyIncoming({
        subject: commitSubject,
        resource: commitResource,
        source: 'offline-replay',
      });
    }
    if (lastCommitSubject) this.setLastCommitValue(lastCommitSubject);

    const clientDb = this.store.getClientDb();
    if (clientDb) {
      const obj: Record<string, unknown> = { '@id': this.subject };
      for (const [k, v] of this.getEntries()) {
        if (!(v instanceof Uint8Array)) obj[k] = v;
      }
      const snapshot = this._loroDoc?.export({ mode: 'snapshot' });
      clientDb
        .putResourceWithSnapshot(this.subject, JSON.stringify(obj), snapshot)
        .catch(e => console.error('[Offline] persist failed:', e));
    }

    this.store.applyIncoming({
      subject: this.subject,
      resource: this,
      source: 'offline-replay',
    });

    // Outbox is durable — survives reload so reconnect drain
    // sees the queued commits even after the in-memory store
    // is wiped.
    if (this._pendingCommits.length) {
      this.store.outbox.setEntry(this.subject, this._pendingCommits);
    }
  }

  /**
   * Set a Property, Value combination and perform a validation. Will throw if
   * property is not valid for the datatype. Will fetch the datatype if it's not
   * available. Updates the cache and Loro doc.
   *
   * When undefined is passed as value, the property is removed from the resource.
   */
  public async set<
    Prop extends string,
    Value extends InferTypeOfValueInTriple<C, Prop>,
  >(
    prop: Prop,
    value: Value,
    /**
     * Disable validation if you don't need it. It might cause a fetch if the
     * Property is not present when set is called
     */
    validate = true,
  ): Promise<void> {
    // if (this.store.isOffline() && validate) {
    //   console.warn('Offline, not validating');
    //   validate = false;
    // }

    if (value instanceof Uint8Array) {
      throw new Error('Binary values (Uint8Array) cannot be set via set().');
    }

    if (validate) {
      const fullProp = await this.store.getProperty(prop);

      try {
        validateDatatype(value, fullProp.datatype);
      } catch (e) {
        if (e instanceof Error) {
          e.message = `Error validating ${fullProp.shortname} with value ${value} for ${this.subject}: ${e.message}`;
        }

        throw e;
      }
    }

    if (value === undefined) {
      this.remove(prop);
      this.eventManager.emit(ResourceEvents.LocalChange, prop, value);

      return;
    }

    // Write to Loro only — cache is rebuilt lazily on next get()
    this.loroSetProperty(prop, value as JSONValue);
    this._cacheDirty = true;

    this._dirty = true;
    this.eventManager.emit(
      ResourceEvents.LocalChange,
      prop,
      value as JSONValue,
    );
  }

  public removeUnsafe(prop: string): void {
    if (prop === commits.properties.loroUpdate) {
      this._loroSnapshotBytes = undefined;
      this.resetLoroState();

      return;
    }

    this.loroDeleteProperty(prop);
    this._auxValues.delete(prop);
    this._cacheDirty = true;
  }

  public clearUnsafe(): void {
    this._cache = Object.create(null);
    this._cacheDirty = false;
    this._auxValues.clear();
    this._loroSnapshotBytes = undefined;
    this.resetLoroState();
  }

  public importLoroUpdate(loroUpdate: Uint8Array): void {
    // Ensure the LoroDoc exists, then import the update into it.
    const doc = this.getLoroDoc();

    if (!doc) {
      // Loro WASM not loaded — buffer the bytes for `getLoroDoc()` to
      // import once Loro initializes. The `loading` getter sees the
      // buffered bytes and keeps reporting `true` until then, so
      // consumers don't fall back to the truncated DID.
      this._loroSnapshotBytes = loroUpdate;

      return;
    }

    try {
      doc.import(loroUpdate);
      this.rebuildCacheFromLoro();
      this._cacheDirty = false;
      this.markLoroSaved();
    } catch (e) {
      console.warn('Failed to import Loro update:', e);
    }
  }

  /** Sets the error on the Resource. Does not Throw. */
  public setError(e: Error): void {
    this.error = e;
  }

  /** Set the Subject / ID URL of the Resource. Does not update the Store. */
  public setSubject(subject: string): void {
    const normalized = this._store?.normalizeSubject(subject) ?? subject;
    Client.tryValidSubject(normalized);
    this.commitBuilder.setSubject(normalized);
    this._subject = normalized;
  }

  /** Refetches the resource from the server. Will reset all changes to the latest saved version */
  public async refresh(): Promise<void> {
    await this.store.fetchResourceFromServer(this.subject, {
      noWebSocket: true,
    });
  }

  /** Resolves the `/commit` endpoint for this resource. */
  private getCommitEndpoint(): string {
    const serverUrl = this.store.getServerUrl();

    if (!serverUrl || serverUrl === 'null') {
      console.warn(
        `Resource ${this.subject} has an invalid server URL: ${serverUrl}. Falling back to origin.`,
      );
    }

    const base = !serverUrl || serverUrl === 'null' ? '' : serverUrl;
    const fallbackBase = base || window.location.origin;

    if (
      this.subject.startsWith('did:') ||
      this.subject.startsWith('internal:')
    ) {
      return new URL('/commit', fallbackBase).toString();
    }

    try {
      const url = new URL(this.subject);

      if (url.origin && url.origin !== 'null') {
        return url.origin + `/commit`;
      }
    } catch {
      // ignore
    }

    return new URL('/commit', fallbackBase).toString();
  }

  private isParentNew() {
    const parentSubject = this.get(core.properties.parent) as string;

    if (!parentSubject) {
      return false;
    }

    const parent = this.store.getResourceLoading(parentSubject);

    return parent.new;
  }
}

function normalizeLoroValue(value: unknown): JSONValue {
  // LoroList.toJSON() returns a native JS array — pass through directly.
  if (Array.isArray(value)) {
    return value as JSONValue;
  }

  // Legacy: JSON-stringified arrays/objects from older Loro docs.
  if (
    typeof value === 'string' &&
    (value.startsWith('[') || value.startsWith('{'))
  ) {
    try {
      return JSON.parse(value) as JSONValue;
    } catch {
      return value;
    }
  }

  return value as JSONValue;
}

/** Type of Rights (e.g. read or write) */
export enum RightType {
  /** Open a resource or its children */
  READ = 'read',
  /** Edit or delete a resource or its children */
  WRITE = 'write',
}

/** A grant / permission that is set somewhere */
export interface Right {
  /** Subject of the Agent who the right is for */
  for: string;
  /** The resource that has set the Right */
  setIn: string;
  /** Type of right (e.g. read / write) */
  type: RightType;
}

/** A point in the resource's history, derived from the Loro OpLog. */
export interface Version {
  /** Peer that authored this change */
  peer: string;
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Loro frontiers — pass to doc.checkout() to materialize this version */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  frontiers: any[];
  /** Human-readable commit message, if set */
  message?: string;
  /** Materialized property values at this version */
  propvals: Map<string, JSONValue>;
}

/** @deprecated Use Version instead. Kept for backward compat during migration. */
export interface LegacyVersion {
  commit: Commit;
  resource: Resource;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function proxyResource<C extends OptionalClass = any>(
  resource: Resource<C>,
): Resource<C> {
  if (resource.__internalObject !== resource) {
    console.warn('Attempted to proxy a proxy for ' + resource.subject);
  }

  return new Proxy(resource.__internalObject, {});
}

const WaitForImmediate = () => new Promise(resolve => setTimeout(resolve));

/** Returns true if the error is a network/fetch failure (server unreachable). */
function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError && e.message.includes('Failed to fetch')) {
    return true;
  }

  if (e instanceof Error && e.message.includes('Failed to fetch')) {
    return true;
  }

  // AtomicError wrapping a fetch failure
  if (
    e instanceof Error &&
    e.message.includes('Posting Commit') &&
    e.message.includes('Failed to fetch')
  ) {
    return true;
  }

  return false;
}
