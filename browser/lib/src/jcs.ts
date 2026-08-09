/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Produces the canonical serialization used for all content-addressed
 * `did:ad:frozen` hashing, so the same value hashes identically here and in any
 * other conformant implementation — notably the `serde_jcs` crate on the Rust
 * side. Using a named standard (rather than an ad-hoc stable stringify) is what
 * makes cross-language frozen ids byte-for-byte reproducible.
 *
 * Covers the JSON value space we hash:
 * - objects: keys sorted by UTF-16 code unit (`Array.prototype.sort` default,
 *   which RFC 8785 §3.2.3 mandates)
 * - arrays: order preserved
 * - strings and finite numbers: ECMAScript `JSON.stringify` semantics, which
 *   RFC 8785 §3.2.2.2/§3.2.2.3 reference directly
 * - booleans and null
 *
 * Non-finite numbers are rejected (JSON has no representation for them).
 */
export type JcsValue =
  | string
  | number
  | boolean
  | null
  | JcsValue[]
  | { [key: string]: JcsValue };

export function jcsCanonicalize(value: JcsValue): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`JCS cannot serialize a non-finite number: ${value}`);
    }

    return JSON.stringify(value);
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(jcsCanonicalize).join(',')}]`;
  }

  const keys = Object.keys(value).sort();

  return `{${keys
    .map(key => `${JSON.stringify(key)}:${jcsCanonicalize(value[key])}`)
    .join(',')}}`;
}
