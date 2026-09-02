// Standard base64 (`+` `/`, padded) is used for binary *values* (Loro
// blobs in commits, version-vector cursors) — these are decoded server-side as
// standard base64, so they must stay standard.
//
// Cryptographic identifiers that end up inside `did:ad:` subjects (signatures,
// public keys) instead use {@link encodeB64Url}: URL-safe, unpadded base64
// (RFC 4648 §5, `-` `_`, no `=`). Standard base64's `+` becomes a space under
// form-decoding and `/`/`=` are URL-significant, which silently corrupts a
// subject on a URL round-trip. This mirrors the Rust `encode_base64`.
//
// {@link decodeB64} accepts BOTH alphabets (padded or not), so it decodes
// values, url-safe identifiers, and any legacy standard-encoded data alike.

/** Decode base64, accepting both the URL-safe (`-` `_`) and standard (`+` `/`)
 * alphabets, with or without `=` padding. */
export function decodeB64(base64: string): Uint8Array {
  // Normalise to the standard alphabet and restore padding so a single
  // standard decoder handles every variant.
  let normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;

  if (remainder === 2) {
    normalized += '==';
  } else if (remainder === 3) {
    normalized += '=';
  }

  // 1. Node.js (via Buffer)
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    // Buffer.from returns a Buffer, which extends Uint8Array.
    return Buffer.from(normalized, 'base64');
  }

  // 2. Browser (via atob)
  if (typeof atob === 'function') {
    const binaryString = atob(normalized);
    const bytes = new Uint8Array(binaryString.length);

    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return bytes;
  }

  throw new Error('Base64 decoding not supported in this environment.');
}

/** Standard base64 (`+` `/`, padded). For binary *values*, not identifiers. */
export function encodeB64(bytes: Uint8Array): string {
  // 1. Node.js (via Buffer)
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes).toString('base64');
  }

  // 2. Browser (via btoa)
  if (typeof btoa === 'function') {
    // Convert Uint8Array to binary string
    let binaryString = '';

    for (let i = 0; i < bytes.length; i++) {
      binaryString += String.fromCharCode(bytes[i]);
    }

    return btoa(binaryString);
  }

  throw new Error('Base64 encoding not supported in this environment.');
}

/** URL-safe, unpadded base64 (`-` `_`, no `=`). For cryptographic identifiers
 * (signatures, public keys) that appear inside `did:ad:` subjects, so they
 * survive a URL round-trip verbatim. Matches the Rust `encode_base64`. */
export function encodeB64Url(bytes: Uint8Array): string {
  return encodeB64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
