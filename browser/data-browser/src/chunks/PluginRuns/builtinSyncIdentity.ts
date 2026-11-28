// @wc-ignore-file
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type {
  BoundCollection,
  CollectionNavigation,
  EntityIdentity,
} from 'syncables/browser';

export type SyncablePrincipal =
  | { kind: 'public' }
  | {
      kind: 'authenticated';
      namespace: string;
      subject: string | number;
      clientContext?: string;
    };
export interface SourceKeyInput {
  version?: 2 | 3;
  proxyOrigin: string;
  platform: string;
  kind: string;
  resource?: string;
  entityIdentityHash?: string;
  principal: SyncablePrincipal;
  collection?: Record<string, unknown>;
  parentSourceKey?: string;
  parentSourceKeyHash?: string;
  remoteId?: string | number;
}

export type CanonicalEntityIdentity = EntityIdentity;
type Scope = Pick<SourceKeyInput, 'proxyOrigin' | 'platform' | 'principal'>;

export interface FlatIdentityAlias {
  canonicalSourceKey: string;
  canonicalConfig?: Record<string, unknown>;
  entityTableSourceKey?: string;
  subject: string;
  previousSourceKey?: string;
  localId?: string;
  sourceConfigFingerprint?: string;
  previousParent?: string;
  reparentToLogicalParent?: boolean;
}

/** Deterministic source identities contain JSON values, never display names or Atomic paths. */
export function canonicalValue<T>(value: T): T;
export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter(key => record[key] !== undefined)
        .map(key => [key, canonicalValue(record[key])]),
    );
  }

  return value;
}

export function sourceConfigFingerprint(value: unknown): string {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify(canonicalValue(value)) ?? 'undefined',
      ),
    ),
  );
}

export function principalIdentity(value: unknown): SyncablePrincipal {
  const principal = value as
    | {
        kind?: unknown;
        namespace?: unknown;
        subject?: unknown;
        clientContext?: unknown;
      }
    | null
    | undefined;

  if (principal?.kind === 'public') return { kind: 'public' };
  if (
    !principal ||
    typeof principal.namespace !== 'string' ||
    !principal.namespace ||
    (principal.clientContext !== undefined &&
      (typeof principal.clientContext !== 'string' ||
        !principal.clientContext)) ||
    !(
      (typeof principal.subject === 'string' && principal.subject.length) ||
      (typeof principal.subject === 'number' &&
        Number.isSafeInteger(principal.subject))
    )
  )
    throw new Error('The source has no durable principal identity');

  return {
    kind: 'authenticated',
    namespace: principal.namespace,
    subject: principal.subject,
    ...(principal.clientContext
      ? { clientContext: principal.clientContext }
      : {}),
  };
}

export function sourceKey({
  proxyOrigin,
  platform,
  kind,
  principal,
  collection,
  parentSourceKey,
  parentSourceKeyHash,
  remoteId,
  version = 2,
  resource,
  entityIdentityHash,
}: SourceKeyInput): string {
  if (version === 3) {
    if (
      !['collection', 'record'].includes(kind) ||
      typeof resource !== 'string' ||
      !resource ||
      collection !== undefined ||
      parentSourceKey !== undefined ||
      parentSourceKeyHash !== undefined ||
      remoteId !== undefined ||
      (kind === 'collection' && entityIdentityHash !== undefined) ||
      (kind === 'record' &&
        (typeof entityIdentityHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entityIdentityHash)))
    )
      throw new Error('Invalid canonical entity source identity');
    const serialized = JSON.stringify(
      canonicalValue({
        version: 3,
        proxyOrigin,
        platform,
        kind,
        principal: principalIdentity(principal),
        resource,
        ...(entityIdentityHash ? { entityIdentityHash } : {}),
      }),
    );
    if (serialized.length > 2000)
      throw new Error(
        'The source identity exceeds the 2000 character query limit',
      );

    return serialized;
  }

  if (version !== 2) throw new Error('Unknown source identity version');
  if (parentSourceKey !== undefined && parentSourceKeyHash !== undefined)
    throw new Error('Supply a parent source key or its hash, not both');
  if (
    parentSourceKey !== undefined &&
    (typeof parentSourceKey !== 'string' || !parentSourceKey)
  )
    throw new Error('The parent source key must be nonempty text');
  if (
    parentSourceKeyHash !== undefined &&
    (typeof parentSourceKeyHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parentSourceKeyHash))
  )
    throw new Error(
      'The parent source hash must be 64 lowercase hexadecimal characters',
    );
  const serialized = JSON.stringify(
    canonicalValue({
      version: 2,
      proxyOrigin,
      platform,
      kind,
      principal: principalIdentity(principal),
      collection,
      parentSourceKeyHash:
        parentSourceKey === undefined
          ? parentSourceKeyHash
          : sourceConfigFingerprint(parentSourceKey),
      remoteId,
    }),
  );
  if (serialized.length > 2000)
    throw new Error(
      'The source identity exceeds the 2000 character query limit',
    );

  return serialized;
}

/** A nested collection's transport address may change; its declared relationship does not. */
export function collectionIdentity(
  bound?: Pick<BoundCollection, 'collection' | 'resource' | 'pathParams'>,
  navigation?: Pick<CollectionNavigation, 'collection' | 'resource'> & {
    reference?: string;
    link?: string;
  },
): Record<string, unknown> {
  if (navigation)
    return {
      name: navigation.collection,
      resource: navigation.resource,
      reference: navigation.reference,
      link: navigation.link,
    };

  if (!bound) throw new Error('The collection has no source binding');

  return {
    name: bound.collection,
    resource: bound.resource,
    context: bound.pathParams,
  };
}

/** The library key contains only declared canonical identity context and preserves JSON types. */
export function entitySourceKey({
  entityIdentity,
  proxyOrigin,
  platform,
  principal,
}: Scope & { entityIdentity: EntityIdentity }): string {
  if (
    !entityIdentity ||
    typeof entityIdentity.key !== 'string' ||
    !entityIdentity.key ||
    typeof entityIdentity.resource !== 'string' ||
    !entityIdentity.resource
  )
    throw new Error('The record has no canonical entity identity');

  return sourceKey({
    proxyOrigin,
    platform,
    principal,
    version: 3,
    kind: 'record',
    resource: entityIdentity.resource,
    entityIdentityHash: sourceConfigFingerprint(entityIdentity.key),
  });
}

export function entityTableKey({
  resource,
  proxyOrigin,
  platform,
  principal,
}: Scope & { resource: string }): string {
  return sourceKey({
    proxyOrigin,
    platform,
    principal,
    version: 3,
    kind: 'collection',
    resource,
  });
}

/** A saved View's identity remains bounded even for a deep fanout definition. */
export function ruleSourceKey(tableKey: string, ruleKey: string): string {
  if (
    typeof tableKey !== 'string' ||
    !tableKey ||
    typeof ruleKey !== 'string' ||
    !ruleKey
  )
    throw new Error('The saved filter has no durable source identity');

  return JSON.stringify(
    canonicalValue({
      version: 3,
      kind: 'rule',
      tableKeyHash: sourceConfigFingerprint(tableKey),
      ruleKeyHash: sourceConfigFingerprint(ruleKey),
    }),
  );
}
