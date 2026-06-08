/**
 * Self-verifying genesis certificate — TypeScript mirror of
 * `lib/src/genesis.rs` (Rust). The two MUST produce byte-identical `encode`
 * output: a DID minted in the browser is verified by the server / WASM DB and
 * vice-versa. The fixed binary layout (deliberately NOT JSON, so there is no
 * canonicalization ambiguity in the trust path) is what makes that reliable —
 * the `known byte vector` test is pinned identically on both sides.
 *
 * The resource subject is `did:ad:<base64url(signature)>`, where the signature
 * is an Ed25519 signature over {@link encodeGenesisCert}'s output by the
 * creating agent. The signature is therefore NOT stored in the certificate.
 *
 * See `planning/genesis-self-verifying.md`.
 */
import { sha512 } from '@noble/hashes/sha2.js';
import { hashes, sign, verify } from '@noble/ed25519';
import { decodeB64, encodeB64Url } from './base64.js';

// Match `CryptoProvider.ts`: the synchronous noble API needs sha512 installed.
hashes.sha512 = sha512;

export const GENESIS_VERSION_V1 = 0x01;
/** `flags` bit 0: a 32-byte `stateHash` is present after the nonce. */
const FLAG_HAS_STATE_HASH = 0b0000_0001;

export interface GenesisCert {
  /** Ed25519 public key of the creating agent (raw 32 bytes). */
  signerPubkey: Uint8Array;
  /** Creation time, Unix milliseconds. */
  createdAt: number;
  /** CSPRNG uniqueness salt (16 bytes) — guarantees a distinct DID even for the
   *  same agent + parent + millisecond (Ed25519 is deterministic). */
  nonce: Uint8Array;
  /** Optional Blake3 of the canonical genesis projection (32 bytes) — binds the
   *  initial content. */
  stateHash?: Uint8Array;
  /** The ORIGINAL parent subject (immutable provenance — distinct from the
   *  resource's current, mutable `parent` propval). */
  parent: string;
  /** The resource's drive DID. Immutable — enables race-free, drive-first
   *  rights checks and drive-scoped query indexing for did: subjects. */
  drive: string;
}

/** Serialize to the canonical v1 binary layout (little-endian integers). These
 *  bytes are exactly what gets signed/verified. */
export function encodeGenesisCert(cert: GenesisCert): Uint8Array {
  if (cert.signerPubkey.length !== 32) {
    throw new Error('genesis signerPubkey must be 32 bytes');
  }

  if (cert.nonce.length !== 16) {
    throw new Error('genesis nonce must be 16 bytes');
  }

  if (cert.stateHash && cert.stateHash.length !== 32) {
    throw new Error('genesis stateHash must be 32 bytes');
  }

  const parentBytes = new TextEncoder().encode(cert.parent);

  if (parentBytes.length > 0xffff) {
    throw new Error('genesis parent subject exceeds 65535 bytes');
  }

  const driveBytes = new TextEncoder().encode(cert.drive);

  if (driveBytes.length > 0xffff) {
    throw new Error('genesis drive subject exceeds 65535 bytes');
  }

  const hasHash = cert.stateHash !== undefined;

  const out = new Uint8Array(
    2 +
      32 +
      8 +
      16 +
      (hasHash ? 32 : 0) +
      2 +
      parentBytes.length +
      2 +
      driveBytes.length,
  );
  const view = new DataView(out.buffer);
  let o = 0;

  out[o++] = GENESIS_VERSION_V1;
  out[o++] = hasHash ? FLAG_HAS_STATE_HASH : 0;
  out.set(cert.signerPubkey, o);
  o += 32;
  view.setBigInt64(o, BigInt(cert.createdAt), true);
  o += 8;
  out.set(cert.nonce, o);
  o += 16;

  if (hasHash) {
    out.set(cert.stateHash!, o);
    o += 32;
  }

  view.setUint16(o, parentBytes.length, true);
  o += 2;
  out.set(parentBytes, o);
  o += parentBytes.length;

  view.setUint16(o, driveBytes.length, true);
  o += 2;
  out.set(driveBytes, o);

  return out;
}

/** Parse the canonical binary layout. Throws on unknown version, truncation, or
 *  trailing bytes. */
export function decodeGenesisCert(bytes: Uint8Array): GenesisCert {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;

  const need = (n: number) => {
    if (o + n > bytes.length) {
      throw new Error('Genesis certificate is truncated');
    }
  };

  need(2);
  const version = bytes[o++];

  if (version !== GENESIS_VERSION_V1) {
    throw new Error(`Unsupported genesis certificate version ${version}`);
  }

  const flags = bytes[o++];

  need(32);
  const signerPubkey = bytes.slice(o, o + 32);
  o += 32;

  need(8);
  const createdAt = Number(view.getBigInt64(o, true));
  o += 8;

  need(16);
  const nonce = bytes.slice(o, o + 16);
  o += 16;

  let stateHash: Uint8Array | undefined;

  if (flags & FLAG_HAS_STATE_HASH) {
    need(32);
    stateHash = bytes.slice(o, o + 32);
    o += 32;
  }

  need(2);
  const parentLen = view.getUint16(o, true);
  o += 2;

  need(parentLen);
  const parent = new TextDecoder().decode(bytes.slice(o, o + parentLen));
  o += parentLen;

  need(2);
  const driveLen = view.getUint16(o, true);
  o += 2;

  need(driveLen);
  const drive = new TextDecoder().decode(bytes.slice(o, o + driveLen));
  o += driveLen;

  if (o !== bytes.length) {
    throw new Error('Genesis certificate has trailing bytes');
  }

  return { signerPubkey, createdAt, nonce, stateHash, parent, drive };
}

/** The signing agent's DID (`did:ad:agent:<pubkey>`). */
export function genesisSignerDid(cert: GenesisCert): string {
  return `did:ad:agent:${encodeB64Url(cert.signerPubkey)}`;
}

/** The resource subject implied by a signature. */
export function subjectForSignature(signature: string): string {
  return `did:ad:${signature}`;
}

/** Sign the certificate with a raw 32-byte Ed25519 private key. Returns the
 *  base64url signature; the resource subject is `did:ad:<signature>`. */
export async function signGenesisCert(
  cert: GenesisCert,
  privateKey: Uint8Array,
): Promise<string> {
  const signature = await sign(encodeGenesisCert(cert), privateKey);

  return encodeB64Url(signature);
}

/** Verify a base64 `signature` against the certificate's signer pubkey. The
 *  caller separately confirms `subjectForSignature(signature)` equals the
 *  resource subject, and that the signer matches `createdBy`. */
export async function verifyGenesisCert(
  cert: GenesisCert,
  signature: string,
): Promise<boolean> {
  return verify(
    decodeB64(signature),
    encodeGenesisCert(cert),
    cert.signerPubkey,
  );
}
