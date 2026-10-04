import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Resource } from './resource.js';

export type SchemaValue =
  | null
  | boolean
  | number
  | string
  | SchemaValue[]
  | { [key: string]: SchemaValue };
export const FROZEN_PREFIX = 'atomic:frozen:';
export const APP_SHAPE = 'urn:atomic:schema:shape';
export const APP_SCOPE = 'urn:atomic:schema:scope';

export function isFrozenSchema(subject: string): boolean {
  return (
    subject.startsWith(FROZEN_PREFIX) || subject.startsWith('did:ad:frozen:')
  );
}

/** RFC 8785: UTF-16 key order and ECMAScript number serialization. */
export function canonicalSchemaJson(value: SchemaValue, depth = 0): string {
  if (depth > 64) throw new Error('Definition nesting exceeds 64 levels');
  if (value === null || typeof value === 'boolean')
    return JSON.stringify(value);

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Nonfinite schema number');

    return JSON.stringify(value);
  }

  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff))
          throw new Error('Invalid Unicode');
      } else if (code >= 0xdc00 && code <= 0xdfff)
        throw new Error('Invalid Unicode');
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value))
    return `[${Array.from(value, v => canonicalSchemaJson(v, depth + 1)).join(',')}]`;

  if (
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error('Expected plain JSON');
  }

  return `{${Object.keys(value)
    .sort()
    .map(
      key =>
        `${canonicalSchemaJson(key)}:${canonicalSchemaJson(value[key], depth + 1)}`,
    )
    .join(',')}}`;
}

export function frozenSchemaId(body: SchemaValue): string {
  if (!body || Array.isArray(body) || typeof body !== 'object')
    throw new Error('Expected definition object');

  for (const key of [
    '@id',
    'https://atomicdata.dev/properties/loroUpdate',
    'https://atomicdata.dev/properties/lastCommit',
  ]) {
    if (Object.hasOwn(body, key))
      throw new Error(`Frozen definition cannot contain ${key}`);
  }

  const bytes = new TextEncoder().encode(canonicalSchemaJson(body));
  if (bytes.length > 256 * 1024)
    throw new Error('Frozen definition exceeds 256 KiB');

  return `${FROZEN_PREFIX}${bytesToHex(blake3(bytes))}`;
}

export function verifyFrozenSchema(resource: Resource): void {
  if (!isFrozenSchema(resource.subject)) return;
  const canonicalId = resource.subject
    .replace(/^did:ad:/, 'atomic:')
    .split(/[?#]/)[0];
  if (frozenSchemaId(resource.getPropVals() as SchemaValue) !== canonicalId)
    throw new Error('Frozen definition hash mismatch');
}
