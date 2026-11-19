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
  remoteId,
}) {
  return JSON.stringify(
    canonicalValue({
      version: 2,
      proxyOrigin,
      platform,
      kind,
      principal: principalIdentity(principal),
      collection,
      parentSourceKey,
      remoteId,
    }),
  );
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
