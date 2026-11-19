// @wc-ignore-file
import type { BoundCollection, CollectionNavigation } from 'syncables/browser';
import { isHttpsOrLoopback } from '@helpers/runtimeSetting';
import {
  collectionIdentity,
  principalIdentity,
  sourceKey,
  type SyncablePrincipal,
} from './builtinSyncIdentity.js';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 65_536;
const stringMap = (value: unknown): value is Record<string, string> =>
  record(value) &&
  Object.values(value).every(entry => typeof entry === 'string');

export interface SyncableSourceConfig {
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
}
export interface SyncableSourceKey {
  version: 2;
  proxyOrigin: string;
  platform: string;
  kind: 'principal' | 'collection' | 'record';
  principal: SyncablePrincipal;
  collection?: Record<string, unknown>;
  parentSourceKey?: string;
  remoteId?: string | number;
}
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
  if (!record(raw) || raw.version !== 2)
    throw new Error('Invalid Sync source configuration');
  const identity = principal(raw.principal);
  if (
    identity.kind === 'public'
      ? raw.connectionId !== undefined
      : typeof raw.connectionId !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(raw.connectionId)
  )
    throw new Error('Invalid Sync connection binding');
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

  if (
    !record(value) ||
    value.version !== 2 ||
    !['principal', 'collection', 'record'].includes(String(value.kind)) ||
    (value.collection !== undefined && !record(value.collection)) ||
    (value.parentSourceKey !== undefined && !text(value.parentSourceKey)) ||
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
