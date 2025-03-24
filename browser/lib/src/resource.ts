import type * as Y from 'yjs';
import { YLoader } from './yjs.js';
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
  isYDoc,
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

  private commitBuilder: CommitBuilder;
  private _subject: string;
  private propvals: PropVals = new Map();

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

    // Filter out YDoc instances before cloning
    if (YLoader.isLoaded()) {
      const Y = YLoader.Y;

      const nonYdocPropvals = new Map<string, AtomicValue>();
      const ydocPropvals = new Map<string, Y.Doc>();

      for (const [key, value] of this.propvals.entries()) {
        if (!isYDoc(value)) {
          // Property is not a YDoc so we can just clone it.
          nonYdocPropvals.set(key, value);
          continue;
        }

        // Property is a YDoc so we need to make a new Y.Doc instance and apply the state of the existing YDoc.
        const newDoc = new Y.Doc();
        Y.applyUpdateV2(newDoc, Y.encodeStateAsUpdateV2(value));
        ydocPropvals.set(key, newDoc);
      }

      res.propvals = structuredClone(nonYdocPropvals);

      // Set the YDoc instances using setUnsafe to setup any event listeners.
      for (const [key, value] of ydocPropvals.entries()) {
        res.setUnsafe(key, value);
      }
    } else {
      // Yjs is not loaded, so the propvals can't contain YDoc instances.
      res.propvals = structuredClone(this.propvals);
    }

    res.loading = this.loading;
    res.new = this.new;
    res.error = structuredClone(this.error);
    res.commitError = this.commitError;
    res.commitBuilder = this.commitBuilder.clone();
    res.appliedCommitSignatures = this.appliedCommitSignatures;
    res._pendingCommits = [...this._pendingCommits];
    res._lastLocalSignature = this._lastLocalSignature;

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
      // We handle YDoc instances separately because they need to be stable references.
      if (YLoader.isLoaded() && isYDoc(value)) {
        const Y = YLoader.Y;
        const localDoc = this.propvals.get(key) as Y.Doc | undefined;

        if (!localDoc) {
          this.setUnsafe(key, value);
        } else {
          const remoteState = Y.encodeStateAsUpdateV2(value);
          Y.applyUpdateV2(localDoc, remoteState);
        }

        continue;
      }

      this.propvals.set(key, value);
    }

    this.new = resourceB.new;
    this.error = resourceB.error;
    this.commitError = resourceB.commitError;

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

  /** Returns true if the resource has changes in it's commit builder that are not yet saved to the server. */
  public hasUnsavedChanges(): boolean {
    return this.commitBuilder.hasUnsavedChanges();
  }

  public getCommitsCollectionSubject(): string {
    // For DID subjects (or other non-HTTP URIs) we can't derive the server
    // origin from the subject itself — use the store's server URL instead.
    const base = this.subject.startsWith('did:') || this.subject.startsWith('_')
      ? this.store.getServerUrl()
      : this.subject;
    const url = new URL('/commits', base);
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

  /** Gets a YDoc from the resource, or creates a new one if it doesn't exist */
  public getYDoc(property: string): Y.Doc {
    YLoader.loadCheck();
    const Y = YLoader.Y;

    const value = this.get(property);

    if (value instanceof Y.Doc) {
      return value;
    }

    if (value !== undefined) {
      throw new Error(`Value of property ${property} is not a YDoc`);
    }

    const doc = new Y.Doc();
    this.setUnsafe(property, doc);

    return doc;
  }

  /** builds all versions using the Commits */
  public async getHistory(
    progressCallback?: (percentage: number) => void,
  ): Promise<Version[]> {
    const commitsCollection = await this.store.fetchResourceFromServer(
      this.getCommitsCollectionSubject(),
    );
    const commitList = (commitsCollection.get(
      collections.properties.members,
    ) ?? []) as string[];

    const builtVersions: Version[] = [];

    let previousResource = new Resource(this.subject);

    for (let i = 0; i < commitList.length; i++) {
      const commitResource = await this.store.getResource(commitList[i]);
      const parsedCommit = parseCommitResource(commitResource);
      const builtResource = applyCommitToResource(
        previousResource.clone(),
        parsedCommit,
      );

      builtResource.setStore(this.store);

      builtVersions.push({
        commit: parsedCommit,
        resource: builtResource,
      });

      previousResource = builtResource;

      // Every 30 cycles we report the progress
      if (progressCallback && i % 30 === 0) {
        progressCallback(Math.round((i / commitList.length) * 100));
        await WaitForImmediate();
      }
    }

    return builtVersions;
  }

  /**
   * Sets the resource to the specified version and saves it.
   * @param version The version to set the resource to, you can get this using `resource.getHistory()`
   */
  public async setVersion(version: Version): Promise<void> {
    const versionPropvals = version.resource.getPropVals();

    // Remove any prop that doesn't exist in the version
    for (const prop of this.propvals.keys()) {
      if (!versionPropvals.has(prop)) {
        this.remove(prop);
      }
    }

    for (const [key, value] of versionPropvals.entries()) {
      if (YLoader.isLoaded() && isYDoc(value)) {
        // YDocs can't just be set so we need to handle them separately.
        const Y = YLoader.Y;

        const undoUpdate = this.createUndoUpdateFromVersion(key, value);
        const currentDoc = this.getYDoc(key);

        Y.applyUpdateV2(currentDoc, undoUpdate);
        this.commitBuilder.addYUpdateAction(key, undoUpdate);

        continue;
      }

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

    this.commitBuilder.addPushAction(propUrl, ...values);
    // Build a new array so that the reference changes. This is needed in most UI frameworks.
    this.propvals.set(propUrl, [...propVal, ...values]);
  }

  /** @deprecated use `resource.remove()` */
  public removePropVal(propertyUrl: string): void {
    this.remove(propertyUrl);
  }

  /** Removes a property value combination from the resource and adds it to the next Commit */
  public remove(propertyUrl: string): void {
    // Delete from this resource
    this.propvals.delete(propertyUrl);

    // Add it to the array of items that the server might need to remove after posting.
    this.commitBuilder.addRemoveAction(propertyUrl);
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

    if (!this.commitBuilder.hasUnsavedChanges()) {
      console.error('[signChanges] No changes to sign');
      throw new Error(`No changes to sign for ${this.subject}`);
    }

    // Chain: use last locally-signed commit, or the server-known lastCommit.
    if (this._lastLocalSignature) {
      // Construct the full commit URL that the server will use.  This ensures
      // the serialization signed here matches what the server will produce when
      // it verifies the signature.  The server stores commit resources at
      // `{origin}/commits/{signature}`.
      const commitUrl = `${this.store.getServerUrl()}/commits/${this._lastLocalSignature}`;
      this.commitBuilder.setPreviousCommit(commitUrl);
    } else {
      const lastCommit = this.get(properties.commit.lastCommit)?.toString();

      if (lastCommit) {
        this.commitBuilder.setPreviousCommit(lastCommit);
      }
    }

    // Clone the builder so new changes after this call go into a fresh one.
    const builder = this.commitBuilder.clone();
    this.commitBuilder = new CommitBuilder(this.subject);
    const commit = await builder.sign(agent);

    // DID genesis: the real subject is derived from the signature.
    if (commit.subject !== this.subject) {
      const oldSubject = this.subject;
      this._subject = commit.subject;
      // Update the fresh commitBuilder to use the real subject.
      this.commitBuilder = new CommitBuilder(commit.subject);

      if (this._store) {
        this.store.removeResource(oldSubject);
        this.store.addResources(this, { skipCommitCompare: true });
      }
    }

    this.appliedCommitSignatures.add(commit.signature);
    this._lastLocalSignature = commit.signature;
    this._pendingCommits.push(commit);
    this.loading = false;
    this.new = false;

    return commit;
  }

  /** Returns `true` when there are locally-signed commits waiting to be pushed. */
  public get hasPendingCommits(): boolean {
    return this._pendingCommits.length > 0;
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
    const wasNew = this._pendingCommits.length > 0 && this._pendingCommits[0].previousCommit === undefined;

    let lastCommitId: string | undefined;

    try {
      this.commitError = undefined;
      this.store.addResources(this, { skipCommitCompare: true });

      while (this._pendingCommits.length > 0) {
        const commit = this._pendingCommits[0];

        const createdCommit = await this.store.postCommit(commit, endpoint);
        lastCommitId = createdCommit.id as string;
        this._pendingCommits.shift();
      }

      // All commits pushed successfully.
      this._lastLocalSignature = undefined;

      if (lastCommitId) {
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
      this.store.addResources(this, { skipCommitCompare: true });
      throw e;
    }
  }

  /** Resolves the `/commit` endpoint for this resource. */
  private getCommitEndpoint(): string {
    if (this.subject.startsWith('did:')) {
      return new URL('/commit', this.store.getServerUrl()).toString();
    }

    try {
      return new URL(this.subject).origin + `/commit`;
    } catch {
      return new URL('/commit', this.store.getServerUrl()).toString();
    }
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
    const hasChanges = this.commitBuilder.hasUnsavedChanges();

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
    const oldCommitBuilder = hasChanges ? this.commitBuilder.clone() : undefined;
    const wasNew = this.new;

    try {
      // Sign any unsaved changes into the local queue.
      if (hasChanges) {
        await this.signChanges(agent);
      }

      // Push all queued commits to the server.
      const result = await this.pushCommits();

      reportDone();

      return result;
    } catch (e) {
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

    // YDocs can not be set, sadly we can't really remove them from the value type so we have to throw an error.
    if (isYDoc(value)) {
      throw new Error(
        'YDoc values can not be set, you should edit the YDoc value directly.',
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
    // Add the change to the Commit Builder, so we can commit our changes later
    this.commitBuilder.addSetAction(prop, value);
    this.eventManager.emit(ResourceEvents.LocalChange, prop, value);
  }

  /**
   * Set a Property, Value combination without performing validations or adding
   * it to the CommitBuilder.
   */
  public setUnsafe(prop: string, val: AtomicValue): void {
    this.propvals.set(prop, val);

    if (isYDoc(val)) {
      val.on('updateV2', this.buildYDocCallback(prop));
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

  private isParentNew() {
    const parentSubject = this.propvals.get(core.properties.parent) as string;

    if (!parentSubject) {
      return false;
    }

    const parent = this.store.getResourceLoading(parentSubject);

    return parent.new;
  }

  private createUndoUpdateFromVersion(key: string, oldDoc: Y.Doc): Uint8Array {
    const Y = YLoader.Y;
    YLoader.loadCheck();

    const currentDoc = this.propvals.get(key) as Y.Doc | undefined;

    // If the current value does not exist anymore we just return the old state as there is nothing to undo.
    if (currentDoc === undefined) {
      return Y.encodeStateAsUpdateV2(oldDoc);
    }

    const oldStateVector = Y.encodeStateVector(oldDoc);

    // Get an update of all changes after the old document.
    const diffUpdate = Y.encodeStateAsUpdateV2(currentDoc, oldStateVector);
    const undoManager = new Y.UndoManager(oldDoc);

    Y.applyUpdateV2(oldDoc, diffUpdate);
    // The two docs are now in sync but the undo manager tracked the change to the old doc.
    undoManager.undo();

    // The undo manager created a new update that removes all the changes we just made effectively reverting all changes made since the old document.
    return Y.encodeStateAsUpdateV2(oldDoc, Y.encodeStateVector(currentDoc));
  }

  private buildYDocCallback(
    property: string,
  ): (
    update: Uint8Array,
    _origin: unknown,
    _doc: unknown,
    transaction: Y.Transaction,
  ) => void {
    return (update, _origin, _doc, transaction) => {
      if (transaction.local) {
        this.commitBuilder.addYUpdateAction(property, update);
      }
    };
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

export interface Version {
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
