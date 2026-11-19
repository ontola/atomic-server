// @wc-ignore-file
import type { BoundCollection, CollectionNavigation } from 'syncables/browser';
import { isHttpsOrLoopback } from '@helpers/runtimeSetting';
import {
  collectionIdentity,
  principalIdentity,
  sourceKey,
  sourceConfigFingerprint,
  type CanonicalEntityIdentity,
  type SyncablePrincipal,
} from './builtinSyncIdentity.js';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 65_536;
const stringMap = (value: unknown): value is Record<string, string> =>
  record(value) &&
  Object.values(value).every(entry => typeof entry === 'string');

export interface SyncableSourceConfigV2 {
  version: 2;
  proxyOrigin: string;
  platform: string;
  principal: SyncablePrincipal;
  connectionId?: string;
  collection?: BoundCollection;
  navigation?: CollectionNavigation;
  parentSourceKey?: string;
  record?: Record<string, unknown>;
  resource?: string;
  context?: Record<string, string>;
  managedProperties?: string[];
  kind?: never;
  entityIdentity?: never;
  read?: never;
}
export interface SyncableSourceConfigV3 {
  version: 3;
  kind: 'collection' | 'record';
  proxyOrigin: string;
  platform: string;
  principal: SyncablePrincipal;
  connectionId?: string;
  resource: string;
  entityIdentity?: CanonicalEntityIdentity;
  record?: Record<string, unknown>;
  context?: Record<string, string | number>;
  managedProperties?: string[];
  read?: BoundCollection;
  collection?: never;
  navigation?: never;
  parentSourceKey?: never;
}
export type SyncableSourceConfig =
  | SyncableSourceConfigV2
  | SyncableSourceConfigV3;
export interface SyncableSourceKeyV2 {
  version: 2;
  proxyOrigin: string;
  platform: string;
  kind: 'principal' | 'collection' | 'record';
  principal: SyncablePrincipal;
  collection?: Record<string, unknown>;
  parentSourceKeyHash?: string;
  remoteId?: string | number;
  resource?: never;
  entityIdentityHash?: never;
}
export interface SyncableSourceKeyV3 {
  version: 3;
  proxyOrigin: string;
  platform: string;
  kind: 'collection' | 'record';
  principal: SyncablePrincipal;
  resource: string;
  entityIdentityHash?: string;
  collection?: never;
  parentSourceKeyHash?: never;
  remoteId?: never;
}
export type SyncableSourceKey = SyncableSourceKeyV2 | SyncableSourceKeyV3;
export interface LegacySyncableSourceKey {
  version: 1;
  proxyOrigin: string;
  platform: string;
  kind: string;
  identity: string;
  collection: string;
  connectionId?: string;
}

function origin(value: unknown): string {
  if (!text(value)) throw new Error('Invalid Sync proxy origin');
  const url = new URL(value);
  if (url.origin !== value || !isHttpsOrLoopback(url))
    throw new Error('Invalid Sync proxy origin');

  return value;
}

function platform(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,80}$/.test(value))
    throw new Error('Invalid Sync platform');

  return value;
}

function principal(value: unknown): SyncablePrincipal {
  if (
    !record(value) ||
    !['public', 'authenticated'].includes(String(value.kind))
  )
    throw new Error('Invalid Sync principal');

  if (value.kind === 'public') {
    if (Object.keys(value).some(key => key !== 'kind'))
      throw new Error('Invalid Public principal');

    return { kind: 'public' };
  }

  if (value.clientContext !== undefined && !text(value.clientContext))
    throw new Error('Invalid Sync client context');
  const identity = principalIdentity(value);
  const namespace = new URL((identity as { namespace: string }).namespace);
  if (
    namespace.protocol !== 'https:' ||
    namespace.username ||
    namespace.password ||
    namespace.search ||
    namespace.hash
  )
    throw new Error('Invalid principal namespace');

  return identity;
}

function bound(value: unknown): BoundCollection {
  if (
    !record(value) ||
    !text(value.collection) ||
    !text(value.resource) ||
    !text(value.path) ||
    !value.path.startsWith('/') ||
    !['GET', 'POST'].includes(String(value.method)) ||
    !stringMap(value.pathParams) ||
    !stringMap(value.query) ||
    !record(value.body)
  )
    throw new Error('Invalid saved collection binding');

  return structuredClone(value) as unknown as BoundCollection;
}

function navigation(value: unknown): CollectionNavigation {
  if (
    !record(value) ||
    !text(value.collection) ||
    !text(value.resource) ||
    !text(value.parentResource)
  )
    throw new Error('Invalid saved collection navigation');

  if (value.kind === 'direct') {
    return {
      ...value,
      bound: bound(value.bound),
    } as unknown as CollectionNavigation;
  }

  const source = value.source;
  if (
    value.kind !== 'responseLink' ||
    !text(value.reference) ||
    !text(value.link) ||
    !record(source) ||
    source.method !== 'GET' ||
    !text(source.path) ||
    !text(source.template) ||
    !text(source.operationId) ||
    !stringMap(source.pathParams)
  )
    throw new Error('Invalid saved collection navigation');

  return structuredClone(value) as unknown as CollectionNavigation;
}

export function parseSyncableSourceConfig(raw: unknown): SyncableSourceConfig {
  if (!record(raw) || (raw.version !== 2 && raw.version !== 3))
    throw new Error('Invalid Sync source configuration');
  const identity = principal(raw.principal);
  if (
    identity.kind === 'public'
      ? raw.connectionId !== undefined
      : (raw.version === 2 ||
          raw.kind === 'collection' ||
          raw.connectionId !== undefined) &&
        (typeof raw.connectionId !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(raw.connectionId))
  )
    throw new Error('Invalid Sync connection binding');

  if (raw.version === 3) {
    const allowed = new Set([
      'version',
      'kind',
      'proxyOrigin',
      'platform',
      'principal',
      'connectionId',
      'resource',
      ...(raw.kind === 'record'
        ? ['entityIdentity', 'record', 'context', 'managedProperties', 'read']
        : []),
    ]);
    if (
      !['collection', 'record'].includes(String(raw.kind)) ||
      !text(raw.resource) ||
      Object.keys(raw).some(key => !allowed.has(key)) ||
      (raw.kind === 'record' &&
        (!record(raw.record) || !record(raw.entityIdentity))) ||
      (raw.context !== undefined &&
        (!record(raw.context) ||
          !Object.values(raw.context).every(
            value =>
              typeof value === 'string' ||
              (typeof value === 'number' && Number.isFinite(value)),
          ))) ||
      (raw.managedProperties !== undefined &&
        (!Array.isArray(raw.managedProperties) ||
          !raw.managedProperties.every(text)))
    )
      throw new Error('Invalid flat Sync source configuration');
    const entityIdentity =
      raw.kind === 'record'
        ? parseSyncableEntityIdentity(raw.entityIdentity)
        : undefined;
    if (entityIdentity && entityIdentity.resource !== raw.resource)
      throw new Error('The entity identity has a different resource type');

    return {
      ...structuredClone(raw),
      version: 3,
      kind: raw.kind,
      proxyOrigin: origin(raw.proxyOrigin),
      platform: platform(raw.platform),
      principal: identity,
      ...(entityIdentity ? { entityIdentity } : {}),
      ...(raw.read === undefined ? {} : { read: bound(raw.read) }),
    } as SyncableSourceConfigV3;
  }

  if (
    (raw.collection !== undefined && raw.navigation !== undefined) ||
    (raw.parentSourceKey !== undefined && !text(raw.parentSourceKey)) ||
    (raw.record !== undefined && !record(raw.record)) ||
    (raw.resource !== undefined && !text(raw.resource)) ||
    (raw.context !== undefined && !stringMap(raw.context)) ||
    (raw.managedProperties !== undefined &&
      (!Array.isArray(raw.managedProperties) ||
        !raw.managedProperties.every(text)))
  )
    throw new Error('Invalid Sync source configuration');

  return {
    version: 2,
    proxyOrigin: origin(raw.proxyOrigin),
    platform: platform(raw.platform),
    principal: identity,
    ...(raw.connectionId === undefined
      ? {}
      : { connectionId: raw.connectionId as string }),
    ...(raw.collection === undefined
      ? {}
      : { collection: bound(raw.collection) }),
    ...(raw.navigation === undefined
      ? {}
      : { navigation: navigation(raw.navigation) }),
    ...(raw.parentSourceKey === undefined
      ? {}
      : { parentSourceKey: raw.parentSourceKey as string }),
    ...(raw.record === undefined
      ? {}
      : { record: structuredClone(raw.record) as Record<string, unknown> }),
    ...(raw.resource === undefined ? {} : { resource: raw.resource as string }),
    ...(raw.context === undefined
      ? {}
      : { context: { ...(raw.context as Record<string, string>) } }),
    ...(raw.managedProperties === undefined
      ? {}
      : { managedProperties: [...(raw.managedProperties as string[])] }),
  };
}

export function parseSyncableEntityIdentity(
  raw: unknown,
): CanonicalEntityIdentity {
  if (
    !record(raw) ||
    Object.keys(raw).some(
      key => !['resource', 'template', 'values', 'path', 'key'].includes(key),
    ) ||
    !text(raw.resource) ||
    !text(raw.template) ||
    !text(raw.path) ||
    !raw.path.startsWith('/') ||
    !text(raw.key) ||
    !Array.isArray(raw.values) ||
    raw.values.length === 0 ||
    raw.values.length > 64 ||
    !raw.values.every(
      pair =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        text(pair[0]) &&
        (text(pair[1]) ||
          (typeof pair[1] === 'number' && Number.isSafeInteger(pair[1]))),
    ) ||
    new Set(raw.values.map(pair => pair[0])).size !== raw.values.length
  )
    throw new Error('Invalid canonical Sync entity identity');

  return structuredClone(raw) as unknown as CanonicalEntityIdentity;
}

export function parseSyncableSourceKey(
  raw: unknown,
): SyncableSourceKey | LegacySyncableSourceKey {
  if (!text(raw)) throw new Error('Invalid Sync source binding');
  const value: unknown = JSON.parse(raw);

  if (Array.isArray(value)) {
    if (
      ![5, 6].includes(value.length) ||
      !value.every((entry, index) =>
        index === 4 ? typeof entry === 'string' : text(entry),
      )
    )
      throw new Error('Invalid legacy Sync source binding');

    return {
      version: 1,
      proxyOrigin: origin(value[0]),
      platform: platform(value[1]),
      kind: value[2],
      identity: value[3],
      collection: value[4],
      ...(value[5] ? { connectionId: value[5] } : {}),
    };
  }

  if (record(value) && value.version === 3) {
    const hash = value.entityIdentityHash;
    if (
      !['collection', 'record'].includes(String(value.kind)) ||
      !text(value.resource) ||
      (value.kind === 'record'
        ? typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)
        : hash !== undefined)
    )
      throw new Error('Invalid flat Sync source binding');
    const result = {
      version: 3 as const,
      proxyOrigin: origin(value.proxyOrigin),
      platform: platform(value.platform),
      principal: principal(value.principal),
      kind: value.kind,
      resource: value.resource,
      ...(hash === undefined ? {} : { entityIdentityHash: hash }),
    } as SyncableSourceKeyV3;
    if (sourceKey(result) !== raw)
      throw new Error('Invalid canonical flat Sync source binding');

    return result;
  }

  if (
    !record(value) ||
    value.version !== 2 ||
    !['principal', 'collection', 'record'].includes(String(value.kind)) ||
    (value.collection !== undefined && !record(value.collection)) ||
    value.parentSourceKey !== undefined ||
    (value.parentSourceKeyHash !== undefined &&
      (typeof value.parentSourceKeyHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.parentSourceKeyHash))) ||
    (value.remoteId !== undefined &&
      !(
        text(value.remoteId) ||
        (typeof value.remoteId === 'number' &&
          Number.isSafeInteger(value.remoteId))
      ))
  )
    throw new Error('Invalid Sync source binding');
  const result = {
    ...value,
    proxyOrigin: origin(value.proxyOrigin),
    platform: platform(value.platform),
    principal: principal(value.principal),
  } as unknown as SyncableSourceKey;
  if (sourceKey(result) !== raw)
    throw new Error('Invalid canonical Sync source binding');

  return result;
}

export function sourceConfigMatchesKey(
  config: SyncableSourceConfig,
  key: SyncableSourceKey,
  raw: string,
): boolean {
  if (config.version !== key.version) return false;

  if (config.version === 3 && key.version === 3) {
    if (config.kind !== key.kind || config.resource !== key.resource)
      return false;

    return (
      sourceKey({
        version: 3,
        proxyOrigin: config.proxyOrigin,
        platform: config.platform,
        principal: config.principal,
        kind: config.kind,
        resource: config.resource,
        ...(config.kind === 'record' && config.entityIdentity
          ? {
              entityIdentityHash: sourceConfigFingerprint(
                config.entityIdentity.key,
              ),
            }
          : {}),
      }) === raw
    );
  }

  if (config.version !== 2 || key.version !== 2) return false;
  if (key.kind === 'record' && config.resource !== key.collection?.resource)
    return false;

  return (
    sourceKey({
      proxyOrigin: config.proxyOrigin,
      platform: config.platform,
      principal: config.principal,
      kind: key.kind,
      ...(key.kind === 'record' ? { collection: key.collection } : {}),
      ...(config.collection || config.navigation
        ? {
            collection: collectionIdentity(
              config.collection,
              config.navigation,
            ),
          }
        : {}),
      ...(config.parentSourceKey
        ? { parentSourceKey: config.parentSourceKey }
        : {}),
      ...(key.remoteId === undefined ? {} : { remoteId: key.remoteId }),
    }) === raw
  );
}
