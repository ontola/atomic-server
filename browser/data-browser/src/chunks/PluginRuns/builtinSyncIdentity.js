// @wc-ignore-file
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Deterministic source identities contain JSON values, never display names or Atomic paths. */
export function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter(key => value[key] !== undefined)
        .map(key => [key, canonicalValue(value[key])]),
    );

  return value;
}

export function sourceConfigFingerprint(value) {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify(canonicalValue(value)) ?? 'undefined',
      ),
    ),
  );
}

export function principalIdentity(principal) {
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
}) {
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
export function collectionIdentity(bound, navigation) {
  if (navigation)
    return {
      name: navigation.collection,
      resource: navigation.resource,
      reference: navigation.reference,
      link: navigation.link,
    };

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
}) {
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

export function entityTableKey({ resource, proxyOrigin, platform, principal }) {
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
export function ruleSourceKey(tableKey, ruleKey) {
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
