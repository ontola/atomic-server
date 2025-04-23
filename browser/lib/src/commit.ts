import { sign, getPublicKey, utils } from '@noble/ed25519';
import stringify from 'fast-json-stable-stringify';
// https://github.com/paulmillr/noble-ed25519/issues/38
import { sha512 } from '@noble/hashes/sha512';

import { YLoader } from './yjs.js';
import { Client } from './client.js';
import { Resource } from './resource.js';
import type { Store } from './store.js';
import {
  type JSONValue,
  type JSONArray,
  isSerializedYUpdate,
  isJSONObject,
} from './value.js';
import { decodeB64, encodeB64 } from './base64.js';
import { commits } from './ontologies/commits.js';
import { core } from './ontologies/core.js';

utils.sha512 = msg => Promise.resolve(sha512(msg));

/** A {@link Commit} without its signature, signer and timestamp */
export interface CommitBuilderI {
  /** The resource being edited */
  subject: string;
  /** The property-value combinations being edited https://atomicdata.dev/properties/set */
  set?: Record<string, JSONValue>;
  /**
   * The property-value combinations for which one or more ResourceArrays will
   * be appended. https://atomicdata.dev/properties/push
   */
  push?: Record<string, JSONArray>;
  yUpdate?: Record<string, Uint8Array>;
  /** The properties that need to be removed. https://atomicdata.dev/properties/remove */
  remove?: string[];
  /** If true, the resource must be deleted. https://atomicdata.dev/properties/destroy */
  destroy?: boolean;
  /**
   * URL of the previous Commit, used by the receiver to make sure that we're
   * having the same current version.
   */
  previousCommit?: string;
}

interface CommitBuilderBase {
  set?: Map<string, JSONValue>;
  push?: Map<string, Set<JSONValue>>;
  yUpdate?: Map<string, Uint8Array>;
  remove?: Set<string>;
  destroy?: boolean;
  previousCommit?: string;
}

type JSONADObject = Record<string, JSONValue>;

/** Return the current time as Atomic Data timestamp. Milliseconds since unix epoch. */
export function getTimestampNow(): number {
  return Math.round(new Date().getTime());
}

/** A {@link Commit} without its signature, signer and timestamp */
export class CommitBuilder {
  // WARNING
  // If you add stuff here, add it to `.clone()!` too!
  private _subject: string;
  private _set: Map<string, JSONValue>;
  private _push: Map<string, Set<JSONValue>>;
  private _yUpdate: Map<string, Uint8Array>;
  private _remove: Set<string>;
  private _destroy?: boolean;
  private _previousCommit?: string;

  /** Removes any query parameters from the Subject */
  public constructor(subject: string, base: CommitBuilderBase = {}) {
    this._subject = Client.removeQueryParamsFromURL(subject);
    this._set = base.set ?? new Map();
    this._push = base.push ?? new Map();
    this._yUpdate = base.yUpdate ?? new Map();
    this._remove = base.remove ?? new Set();
    this._destroy = base.destroy;
    this._previousCommit = base.previousCommit;
  }

  public get subject(): string {
    return this._subject;
  }

  public get set() {
    return this._set;
  }

  public get push() {
    return this._push;
  }

  public get yUpdate() {
    return this._yUpdate;
  }

  public get remove() {
    return this._remove;
  }

  public get destroy() {
    return this._destroy;
  }

  public get previousCommit() {
    return this._previousCommit;
  }

  public addSetAction(property: string, value: JSONValue): CommitBuilder {
    this.removeRemoveAction(property);
    this._set.set(property, value);

    return this;
  }

  public addPushAction(property: string, ...values: JSONArray): CommitBuilder {
    const pushSet = this._push.get(property) ?? new Set();

    for (const value of values) {
      pushSet.add(value);
    }

    this._push.set(property, pushSet);

    return this;
  }

  public addRemoveAction(property: string): CommitBuilder {
    this._set.delete(property);
    this._push.delete(property);
    this._yUpdate.delete(property);
    this._remove.add(property);

    return this;
  }

  public addYUpdateAction(property: string, update: Uint8Array): CommitBuilder {
    YLoader.loadCheck();
    const Y = YLoader.Y;

    this.removeRemoveAction(property);
    const existingUpdate = this._yUpdate.get(property);

    if (existingUpdate) {
      this._yUpdate.set(property, Y.mergeUpdatesV2([existingUpdate, update]));
    } else {
      this._yUpdate.set(property, update);
    }

    return this;
  }

  public removeRemoveAction(property: string): CommitBuilder {
    this._remove.delete(property);

    return this;
  }

  public setDestroy(destroy: boolean): CommitBuilder {
    this._destroy = destroy;

    return this;
  }

  /**
   * Set the URL of the Commit that was previously (last) applied. The value of
   * this should probably be the `lastCommit` of the Resource.
   */
  public setPreviousCommit(prev: string): CommitBuilder {
    this._previousCommit = prev;

    return this;
  }

  public setSubject(subject: string): CommitBuilder {
    this._subject = subject;

    return this;
  }

  /**
   * Signs the commit using the privateKey of the Agent, and returns a full
   * Commit which is ready to be sent to an Atomic-Server `/commit` endpoint.
   */
  public async sign(privateKey: string, agentSubject: string): Promise<Commit> {
    const commit = await this.signAt(
      agentSubject,
      privateKey,
      getTimestampNow(),
    );

    return commit;
  }

  /** Returns true if the CommitBuilder has non-empty changes (set, remove, destroy) */
  public hasUnsavedChanges(): boolean {
    return (
      this.set.size > 0 ||
      this.push.size > 0 ||
      this.destroy ||
      this.remove.size > 0 ||
      this.yUpdate.size > 0
    );
  }

  /**
   * Creates a clone of the CommitBuilder. This is required, because I want to
   * prevent any adjustments to the CommitBuilder while signing, as this could
   * cause race conditions with wrong signatures
   */
  // Warning: I'm not sure whether this actually solves the issue. Might be a good idea to remove this.
  public clone(): CommitBuilder {
    const base = {
      set: this.set,
      push: this.push,
      yUpdate: this.yUpdate,
      remove: this.remove,
      destroy: this.destroy,
      previousCommit: this.previousCommit,
    };

    return new CommitBuilder(this.subject, structuredClone(base));
  }

  public toPlainObject(): CommitBuilderI {
    return {
      subject: this.subject,
      set: Object.fromEntries(this.set.entries()),
      push: Object.fromEntries(
        Array.from(this.push.entries()).map(([k, v]) => [k, Array.from(v)]),
      ),
      remove: Array.from(this.remove),
      destroy: this.destroy,
      previousCommit: this.previousCommit,
      yUpdate: Object.fromEntries(this.yUpdate.entries()),
    };
  }

  /** Creates a signature for a Commit using the private Key of some Agent. */
  public async signAt(
    /** Subject URL of the Agent signing the Commit */
    agent: string,
    /** Base64 serialized private key matching the public key of the agent */
    privateKey: string,
    /** Time of signing in millisecons since unix epoch */
    createdAt: number,
  ): Promise<Commit> {
    if (agent === undefined) {
      throw new Error('No agent passed to sign commit');
    }

    if (!this.hasUnsavedChanges()) {
      throw new Error(`No changes to commit in ${this.subject}`);
    }

    const commitPreSigned: UnsignedCommit = {
      ...this.clone().toPlainObject(),
      createdAt,
      signer: agent,
    };
    const serializedCommit = serializeDeterministically({ ...commitPreSigned });
    const signature = await signToBase64(serializedCommit, privateKey);
    const commitPostSigned: Commit = {
      ...commitPreSigned,
      signature,
    };

    return commitPostSigned;
  }
}

/** A {@link Commit} without its signature, but with a signer and timestamp */
interface UnsignedCommit extends CommitBuilderI {
  /** https://atomicdata.dev/properties/signer */
  signer: string;
  /** Unix timestamp in milliseconds, see https://atomicdata.dev/properties/createdAt */
  createdAt: number;
}

/**
 * A Commit represents a (set of) changes to one specific Resource. See
 * https://atomicdata.dev/classes/Commit If you want to create a Commit, you
 * should probably use the {@link CommitBuilder} and call `.sign()` on it.
 */
export interface Commit extends UnsignedCommit {
  /** https://atomicdata.dev/properties/signature */
  signature: string;
  /**
   * Subject of created Commit. Will only be present after it was accepted and
   * applied by the Server.
   */
  id?: string;
}

const serializeMap = {
  subject: commits.properties.subject,
  set: commits.properties.set,
  push: commits.properties.push,
  remove: commits.properties.remove,
  destroy: commits.properties.destroy,
  previousCommit: commits.properties.previousCommit,
  createdAt: commits.properties.createdAt,
  signer: commits.properties.signer,
  signature: commits.properties.signature,
  yUpdate: commits.properties.yUpdate,
  id: 'id',
};

/** Replaces the keys of a Commit object with their respective json-ad key */
function commitToJsonADObject(commit: UnsignedCommit | Commit): JSONADObject {
  const jsonAdObj: JSONADObject = {
    [core.properties.isA]: [commits.classes.commit],
  };

  for (const kv of Object.entries(commit)) {
    const [key, value] = kv as [keyof Commit, Commit[keyof Commit]];
    const serializedKey = serializeMap[key];
    jsonAdObj[serializedKey] = serializeCommitValue(key, value);
  }

  return jsonAdObj;
}

function serializeCommitValue<K extends keyof Commit>(
  key: K,
  value: Commit[K],
): JSONValue {
  // The value for yUpdate needs to be encoded to base64 before it is valid JSON-AD
  if (key === 'yUpdate') {
    const castValue = value as Commit['yUpdate'];

    if (castValue !== undefined) {
      return Object.fromEntries(
        Object.entries(castValue).map(([k, v]) => [
          k,
          { type: 'ydoc', data: encodeB64(v) },
        ]),
      );
    }

    return undefined;
  }

  // The rest of the values can just be returned as is
  return value as JSONValue;
}

/**
 * Takes a commit and serializes it deterministically (canonicilaization). Is
 * used both for signing Commits as well as serializing them.
 * https://docs.atomicdata.dev/core/json-ad.html#canonicalized-json-ad
 */
export function serializeDeterministically(
  commit: UnsignedCommit | Commit,
): string {
  // Remove empty arrays, objects, false values from root
  if (commit.remove && Object.keys(commit.remove).length === 0) {
    delete commit.remove;
  }

  if (commit.set && Object.keys(commit.set).length === 0) {
    delete commit.set;
  }

  if (commit.push && Object.keys(commit.push).length === 0) {
    delete commit.push;
  }

  if (commit.destroy === false) {
    delete commit.destroy;
  }

  if (commit.yUpdate && Object.keys(commit.yUpdate).length === 0) {
    delete commit.yUpdate;
  }

  const jsonadCommit = commitToJsonADObject(commit);

  return stringify(jsonadCommit);
}

// /** Checks whether the commit signature is correct */
// function verifyCommit(commit: Commit, publicKey: string): boolean {
//   delete commit.signature;
//   const serializedCommit = serializeDeterministically(commit);
//   verify();
// }

/**
 * Signs a string using a base64 encoded ed25519 private key. Outputs a base64
 * encoded ed25519 signature
 */
export const signToBase64 = async (
  message: string,
  privateKeyBase64: string,
): Promise<string> => {
  const privateKeyArrayBuffer = decodeB64(privateKeyBase64);
  const privateKeyBytes: Uint8Array = new Uint8Array(privateKeyArrayBuffer);
  const utf8Encode = new TextEncoder();
  const messageBytes: Uint8Array = utf8Encode.encode(message);
  const signatureHex = await sign(messageBytes, privateKeyBytes);
  const signatureBase64 = encodeB64(signatureHex);

  return signatureBase64;
};

/** From base64 encoded private key */
export const generatePublicKeyFromPrivate = async (
  privateKey: string,
): Promise<string> => {
  const privateKeyArrayBuffer = decodeB64(privateKey);
  const privateKeyBytes: Uint8Array = new Uint8Array(privateKeyArrayBuffer);
  const publickey = await getPublicKey(privateKeyBytes);
  const publicBase64 = encodeB64(publickey);

  return publicBase64;
};

interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const privateBytes = utils.randomPrivateKey();
  const publicBytes = await getPublicKey(privateBytes);
  const privateKey = encodeB64(privateBytes);
  const publicKey = encodeB64(publicBytes);

  return {
    publicKey,
    privateKey,
  };
}

export function parseCommitResource(resource: Resource): Commit {
  const commit: Commit = {
    id: resource.subject,
    subject: resource.get(commits.properties.subject),
    set: resource.get(commits.properties.set),
    push: resource.get(commits.properties.push),
    yUpdate: parseYUpdateValue(resource.get(commits.properties.yUpdate)),
    signer: resource.get(commits.properties.signer),
    createdAt: resource.get(commits.properties.createdAt),
    remove: resource.get(commits.properties.remove),
    destroy: resource.get(commits.properties.destroy),
    signature: resource.get(commits.properties.signature),
  };

  return commit;
}

export function parseCommitJSON(str: string): Commit {
  try {
    const jsonAdObj = JSON.parse(str);

    // Check if it's an object
    if (typeof jsonAdObj !== 'object') {
      throw new Error(`Commit is not an object`);
    }

    const subject = jsonAdObj[commits.properties.subject];
    const set = jsonAdObj[commits.properties.set];
    const push = jsonAdObj[commits.properties.push];
    const yUpdate = parseYUpdateValue(jsonAdObj[commits.properties.yUpdate]);
    const signer = jsonAdObj[commits.properties.signer];
    const createdAt = jsonAdObj[commits.properties.createdAt];
    const remove: string[] | undefined = jsonAdObj[commits.properties.remove];
    const destroy: boolean | undefined = jsonAdObj[commits.properties.destroy];
    const signature: string = jsonAdObj[commits.properties.signature];
    const id: undefined | string = jsonAdObj['@id'];
    const previousCommit: undefined | string =
      jsonAdObj[commits.properties.previousCommit];

    if (!signature) {
      throw new Error(`Commit has no signature`);
    }

    return {
      subject,
      set,
      push,
      yUpdate,
      signer,
      createdAt,
      remove,
      destroy,
      signature,
      id,
      previousCommit,
    };
  } catch (e) {
    throw new Error(`Could not parse commit: ${e}, Commit: ${str}`);
  }
}

/** Applies a commit, but does not modify the store */
export function applyCommitToResource(
  resource: Resource,
  commit: Commit,
): Resource {
  const { set, remove, push, destroy, yUpdate } = commit;

  if (set) {
    execSetCommit(set, resource);
  }

  if (remove) {
    execRemoveCommit(remove, resource);
  }

  if (push) {
    execPushCommit(push, resource);
  }

  if (yUpdate) {
    execYUpdateCommit(yUpdate, resource);
  }

  if (destroy) {
    for (const [key] of resource.getPropVals()) {
      resource.setUnsafe(key, undefined);
    }
  }

  return resource;
}

/** Parses a JSON-AD Commit, applies it and adds it (and nested resources) to the store. */
export function parseAndApplyCommit(jsonAdObjStr: string, store: Store) {
  const commit = parseCommitJSON(jsonAdObjStr);
  const { subject, id, destroy, signature } = commit;

  let resource = store.resources.get(subject) as Resource;

  // If the resource doesn't exist in the store, create the resource
  if (!resource) {
    resource = new Resource(subject);
  } else {
    // Commit has already been applied here, ignore the commit
    if (resource.appliedCommitSignatures.has(signature)) {
      return;
    }
  }

  resource = applyCommitToResource(resource, commit);

  if (id) {
    // This is something that the server does, too.
    resource.setUnsafe(commits.properties.lastCommit, id);
  }

  if (destroy) {
    store.removeResource(subject);

    return;
  } else {
    resource.appliedCommitSignatures.add(signature);

    store.addResources(resource, { skipCommitCompare: true });
  }
}

function parseYUpdateValue(
  value: JSONValue,
): Record<string, Uint8Array> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isJSONObject(value)) {
    throw new Error(`YUpdate value is not an object: ${value}`);
  }

  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => {
      if (isSerializedYUpdate(v)) {
        return [k, decodeB64(v.data)];
      } else {
        throw new Error(`YUpdate contains invalid update: ${k}`);
      }
    }),
  );
}

function execSetCommit(
  set: Record<string, JSONValue>,
  resource: Resource,
  store?: Store,
) {
  const parsedResources: Resource[] = [];

  for (const [key, value] of Object.entries(set)) {
    resource.setUnsafe(key, value);
  }

  store && store.addResources(parsedResources);
}

function execRemoveCommit(remove: string[], resource: Resource) {
  for (const prop of remove) {
    resource.removePropValLocally(prop);
  }
}

function execPushCommit(push: Record<string, JSONArray>, resource: Resource) {
  for (const [key, value] of Object.entries(push)) {
    const current = (resource.get(key) as JSONArray) || [];
    const newArr = value as JSONArray;
    // Merge both the old and new items
    const new_arr = [...current, ...newArr];
    // Save it!
    resource.setUnsafe(key, new_arr);
  }
}

function execYUpdateCommit(
  yUpdate: Record<string, Uint8Array>,
  resource: Resource,
) {
  if (!YLoader.isLoaded()) {
    console.warn(
      'Commit contains yUpdate but Yjs is not loaded. Skipping applying yjs updates',
    );

    return;
  }

  const Y = YLoader.Y;

  for (const [key, value] of Object.entries(yUpdate)) {
    const doc = resource.get(key);

    if (!doc) {
      try {
        const newDoc = new Y.Doc();
        Y.applyUpdateV2(newDoc, value);
        resource.setUnsafe(key, newDoc);
      } catch (e) {
        console.error(e);
        throw new Error(`Error applying yUpdate to new document: ${key}: ${e}`);
      }
    } else {
      if (!(doc instanceof Y.Doc)) {
        throw new Error(`Property ${key} is not a YDoc`);
      }

      try {
        Y.applyUpdateV2(doc, value);
      } catch (e) {
        console.error(e);
        throw new Error(
          `Error applying yUpdate to existing document: ${key}: ${e}`,
        );
      }
    }
  }
}
