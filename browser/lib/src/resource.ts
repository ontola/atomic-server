import type { LoroDoc, VersionVector } from 'loro-crdt';
import { LoroLoader } from './loro-loader.js';
import { decodeB64, encodeB64 } from './base64.js';
import { EventManager } from './EventManager.js';
import type { Agent } from './agent.js';
import { Client } from './client.js';
import type { Collection } from './collection.js';
import { CollectionBuilder } from './collectionBuilder.js';
import {
  CommitBuilder,
  Commit,
  applyCommitToResource,
  parseCommitResource,
} from './commit.js';
import { validateDatatype } from './datatypes.js';
import { isUnauthorized } from './error.js';
import { collections } from './ontologies/collections.js';
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

/** Contains the PropertyURL / Value combinations */
export type PropVals = Map<string, AtomicValue>;

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
  private propvals: PropVals = new Map();

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
    return this._loading;
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

      // Check if any of its propvals have the name
      for (const key of this.propvals.keys()) {
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

      // If the resource has a persisted Loro snapshot, import it.
      const existingSnapshot = this.propvals.get(
        commits.properties.loroUpdate,
      );

      if (existingSnapshot instanceof Uint8Array && existingSnapshot.length > 0) {
        this._loroDoc.import(existingSnapshot);
      } else if (typeof existingSnapshot === 'string' && existingSnapshot.length > 0) {
        // May arrive as a base64 string from JSON-AD parsing
        this._loroDoc.import(decodeB64(existingSnapshot));
      }

      this._loroMap = this._loroDoc.getMap('properties');
      this._loroVersionAtLastSave = this._loroDoc.oplogVersion();
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

  /**
   * Write a value to the Loro map. This is called internally by set().
   * Converts JSON values to Loro-compatible types.
   */
  private loroSetProperty(prop: string, value: JSONValue): void {
    const map = this.getLoroMap();

    if (!map) return;

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
    } else {
      // Arrays and objects: serialize to JSON string for now.
      // We'll optimize with native Loro List/Map containers later.
      map.set(prop, JSON.stringify(value));
    }
  }

  /**
   * Remove a property from the Loro map.
   */
  private loroDeleteProperty(prop: string): void {
    const map = this.getLoroMap();

    if (!map) return;

    map.delete(prop);
  }

  /**
   * Export the Loro delta since the last save.
   * Returns undefined if there are no Loro changes or Loro isn't loaded.
   */
  private exportLoroDelta(): Uint8Array | undefined {
    if (!this._loroDoc || !this._loroVersionAtLastSave) {
      return undefined;
    }

    const updates = this._loroDoc.export({
      mode: 'update',
      from: this._loroVersionAtLastSave,
    });

    // Check if the update is empty (no real changes)
    if (updates.length <= 4) {
      return undefined;
    }

    return updates;
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
      JSON.stringify(Array.from(this.propvals.entries())) !==
      JSON.stringify(Array.from(resourceB.propvals.entries()))
    ) {
      return false;
    }

    if (
      JSON.stringify(Array.from(this.commitBuilder.set.entries())) !==
      JSON.stringify(Array.from(resourceB.commitBuilder.set.entries()))
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

    // Clone propvals — Uint8Array values (Loro snapshots) need special handling
    // since structuredClone handles them correctly.
    res.propvals = structuredClone(this.propvals);

    res.loading = this.loading;
    res.new = this.new;
    res.error = structuredClone(this.error);
    res.commitError = this.commitError;
    res.commitBuilder = this.commitBuilder.clone();
    res._dirty = this._dirty;
    res.appliedCommitSignatures = this.appliedCommitSignatures;
    res._pendingCommits = [...this._pendingCommits];
    res._lastLocalSignature = this._lastLocalSignature;

    // Clone the Loro document if present
    if (this._loroDoc && LoroLoader.isLoaded()) {
      const { LoroDoc: LoroDocClass } = LoroLoader.Loro;
      const snapshot = this._loroDoc.export({ mode: 'snapshot' });
      res._loroDoc = new LoroDocClass();
      res._loroDoc.import(snapshot);
      res._loroMap = res._loroDoc.getMap('properties');
      res._loroVersionAtLastSave = this._loroVersionAtLastSave
        ? res._loroDoc.oplogVersion()
        : undefined;
    }

    return res as Resource<C>;
  }

  /** Merges a resource into this resource. If this resource has uncommited changes those changes will be applied on top of the new propvals.
   * Any unsaved changes on the incoming resource will not be merged.
   */
  public merge(resourceB: Resource): void {
    if (this.subject !== resourceB.subject) {
      throw new Error('Cannot merge resources with different subjects');
    }

    const remoteProps = resourceB.getPropVals();

    // Remove any propvals that are not present in the remote resource.
    for (const [key] of this.propvals.entries()) {
      if (!remoteProps.has(key)) {
        this.propvals.delete(key);
      }
    }

    // Merge the remote propvals into this resource.
    for (const [key, value] of remoteProps.entries()) {
      this.propvals.set(key, value);
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

    if (this.commitBuilder.hasUnsavedChanges()) {
      // We have changes so we want to apply those on top of the propvals we just got.
      const changes: Commit = {
        ...this.commitBuilder.toPlainObject(),
        signature: '',
        signer: '',
        createdAt: 0,
      };

      applyCommitToResource(this, changes);
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
    return this.propvals.get(propUrl) as Returns;
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
    const result = this.propvals.get(propUrl) ?? [];

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
    return this._dirty || this.commitBuilder.hasUnsavedChanges();
  }

  /** Mark the resource as having unsaved local changes.
   *  Use this when external code (e.g. Loro editor plugins) modifies the
   *  resource's LoroDoc directly without going through `set()`. */
  public markDirty(): void {
    this._dirty = true;
    this.eventManager.emit(ResourceEvents.LocalChange, undefined, undefined);
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

    // Get all changes from the OpLog, grouped by peer
    const allChanges = doc.getAllChanges();

    // Flatten into a single chronological list
    type ChangeEntry = {
      peer: string;
      counter: number;
      timestamp: number;
      message: string | undefined;
      length: number;
    };
    const flatChanges: ChangeEntry[] = [];

    for (const [peer, changes] of allChanges.entries()) {
      for (const change of changes) {
        flatChanges.push({
          peer,
          counter: change.counter + change.length - 1,
          timestamp: change.timestamp,
          message: change.message,
          length: change.length,
        });
      }
    }

    // Sort by timestamp (oldest first)
    flatChanges.sort((a, b) => a.timestamp - b.timestamp);

    // Build versions by checking out each point in time
    const versions: Version[] = [];

    for (const change of flatChanges) {
      const frontiers = [{ peer: change.peer as `${number}`, counter: change.counter }];

      try {
        doc.checkout(frontiers);

        // Read the properties map at this version
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

        versions.push({
          peer: change.peer,
          timestamp: change.timestamp * 1000, // Loro uses seconds, we use ms
          frontiers,
          message: change.message,
          propvals,
        });
      } catch {
        // Some frontiers might not be valid for checkout, skip
        continue;
      }
    }

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
    for (const prop of this.propvals.keys()) {
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

  /** Returns the internal Map of Property-Values */
  public getPropVals(): PropVals {
    return this.propvals;
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

    // Include previousCommit so DID-based resources can be destroyed without a signature mismatch.
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
        .filter(value => !this.commitBuilder.push.get(propUrl)?.has(value))
        .filter((value, index, self) => self.indexOf(value) === index);
    }

    // Build a new array so that the reference changes. This is needed in most UI frameworks.
    const newArray = [...propVal, ...values];
    this.propvals.set(propUrl, newArray);
    this.loroSetProperty(propUrl, newArray);
    this._dirty = true;
  }

  /** @deprecated use `resource.remove()` */
  public removePropVal(propertyUrl: string): void {
    this.remove(propertyUrl);
  }

  /** Removes a property value combination from the resource */
  public remove(propertyUrl: string): void {
    this.propvals.delete(propertyUrl);
    this.loroDeleteProperty(propertyUrl);
    this._dirty = true;
  }

  /**
   * Removes a property value combination from this resource, does not store the
   * remove action in Commit
   */
  public removePropValLocally(propertyUrl: string): void {
    this.propvals.delete(propertyUrl);
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

    if (!this.hasUnsavedChanges()) {
      console.error('[signChanges] No changes to sign');
      throw new Error(`No changes to sign for ${this.subject}`);
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

    if (loroDelta) {
      this.commitBuilder.setLoroUpdate(loroDelta);
    }

    // Auto-detect genesis: no previousCommit means this is a new resource.
    // The server requires is_genesis=true for DID resources without a previous commit.
    // Only for DID-eligible subjects (_new: or did:ad:) — HTTP URLs use server-assigned subjects.
    const isDIDEligible =
      this.subject.startsWith('_new:') || this.subject.startsWith('did:ad:');

    if (
      isDIDEligible &&
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
        this.store.addResources(this, { skipCommitCompare: true, alias: oldSubject });
      }
    }

    this.appliedCommitSignatures.add(commit.signature);
    this._lastLocalSignature = commit.signature;
    this._pendingCommits.push(commit);
    this.loading = false;
    this.new = false;

    return commit;
  }

  /**
   * Push all locally-queued commits to the server, in order.
   *
   * After a successful push the resource's `lastCommit` is updated from the
   * server response and the local queue is cleared.
   */
  public async pushCommits(): Promise<string | undefined> {
    if (this._pendingCommits.length === 0) {
      return undefined;
    }

    const endpoint = this.getCommitEndpoint();
    const wasNew =
      this._pendingCommits.length > 0 &&
      this._pendingCommits[0].previousCommit === undefined;

    let lastCommitId: string | undefined;

    try {
      this.commitError = undefined;
      this.store.addResources(this, { skipCommitCompare: true });

      while (this._pendingCommits.length > 0) {
        const commit = this._pendingCommits[0];

        const createdCommit = await this.store.postCommit(commit, endpoint);
        lastCommitId = createdCommit.id as string;
        // Server omits @id for did:ad:commit: subjects, so derive it from the signature.
        if (!lastCommitId && createdCommit.signature) {
          lastCommitId = `did:ad:commit:${createdCommit.signature}`;
        }

        this._pendingCommits.shift();
      }

      // All commits pushed successfully.
      this._lastLocalSignature = undefined;

      if (lastCommitId) {
        this._lastCommit = lastCommitId;
        this.setUnsafe(properties.commit.lastCommit, lastCommitId);
      }

      this.store.notifyResourceSaved(this);

      if (wasNew) {
        // The first `SUBSCRIBE` message will not have worked, because the resource didn't exist yet.
        // https://github.com/atomicdata-dev/atomic-data-rust/issues/486
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
      console.warn(`No changes to ${this.subject}, not saving`);

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
        await this.signChanges(agent);
      }

      // If the server is not connected, save locally and queue for sync.
      if (!this.store.serverConnected) {
        await this.applyPendingCommitsLocally();
        this.store.markDirtyForSync(this.subject);
        this.commitError = undefined;
        this.loading = false;
        // Notify subscribers so the UI updates (e.g. sidebar sees new subResources)
        this.store.addResources(this, { skipCommitCompare: true });
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
        this.store.markDirtyForSync(this.subject);
        this.commitError = undefined;
        this.loading = false;
        this.store.addResources(this, { skipCommitCompare: true });
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
          this.setUnsafe(properties.commit.lastCommit, fixedLastCommit);
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
      this.store.addResources(this, { skipCommitCompare: true });
      reportDone();
      throw e;
    }
  }

  /**
   * Persist the current resource state locally.
   * Uses a simple JSON blob in localStorage — bypasses the WASM DB parser
   * which can silently drop binary properties like loroUpdate.
   * On reconnect, a fresh commit will be created from the Loro snapshot.
   */
  private async applyPendingCommitsLocally(): Promise<void> {
    // Ensure createdAt is set — the server normally sets this when applying
    // a commit, but offline we need to do it ourselves for sorting to work.
    if (!this.propvals.has(commits.properties.createdAt)) {
      this.propvals.set(commits.properties.createdAt, Date.now());
    }

    // Build a JSON-AD representation with proper serialization.
    const obj: Record<string, unknown> = { '@id': this.subject };

    for (const [key, value] of this.propvals) {
      if (value instanceof Uint8Array) {
        obj[key] = encodeB64(value);
      } else {
        obj[key] = value;
      }
    }

    // Export the live Loro doc snapshot (contains document content).
    if (this._loroDoc) {
      const snapshot = this._loroDoc.export({ mode: 'snapshot' });
      obj[commits.properties.loroUpdate] = encodeB64(snapshot);
    }

    // Persist the last local signature so followup saves after reload
    // can chain correctly (without it, every reload triggers a new DID genesis).
    if (this._lastLocalSignature) {
      obj['_lastLocalSignature'] = this._lastLocalSignature;
    }

    // Store in localStorage under a known prefix.
    // This is simple, reliable, and survives page reload.
    const storageKey = `atomic.offline.${this.subject}`;

    try {
      const json = JSON.stringify(obj);

      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(storageKey, json);
      }
    } catch (e) {
      console.error('[Offline] Failed to persist resource:', e);
    }

    // Also forward to WASM DB for indexing (best-effort, may lose loroUpdate).
    const clientDb = this.store.getClientDb();

    if (clientDb) {
      clientDb.putResource(JSON.stringify(obj)).catch(() => {});
    }

    // Clear pending commits — they've been incorporated into the resource state.
    // Keep _lastLocalSignature so followup commits can chain correctly.
    this._pendingCommits = [];
  }

  /**
   * Set a Property, Value combination and perform a validation. Will throw if
   * property is not valid for the datatype. Will fetch the datatype if it's not
   * available. Adds the property to the commitbuilder.
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
    if (this.store.isOffline() && validate) {
      console.warn('Offline, not validating');
      validate = false;
    }

    // Binary values (e.g. Loro updates) must go through setUnsafe, not set.
    if (value instanceof Uint8Array) {
      throw new Error(
        'Binary values (Uint8Array) cannot be set via set(). Use setUnsafe() instead.',
      );
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

    this.propvals.set(prop, value);
    this.loroSetProperty(prop, value as JSONValue);
    this._dirty = true;
    this.eventManager.emit(ResourceEvents.LocalChange, prop, value as JSONValue);
  }

  /**
   * Set a Property, Value combination without performing validations or adding
   * it to the CommitBuilder.
   */
  public setUnsafe(prop: string, val: AtomicValue): void {
    this.propvals.set(prop, val);
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
    const parentSubject = this.propvals.get(core.properties.parent) as string;

    if (!parentSubject) {
      return false;
    }

    const parent = this.store.getResourceLoading(parentSubject);

    return parent.new;
  }

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
