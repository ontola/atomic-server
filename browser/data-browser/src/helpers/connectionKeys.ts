// @wc-ignore-file
/**
 * Client-held connection keys for the integration proxy
 * (ontola/atomic-plugins#730).
 *
 * The proxy keeps each connection's provider credential sealed under a
 * 256-bit key it does not store. This page derives that key, sends it once
 * at redeem, and hands everyone else that uses the connection (an app's
 * frame) a **key grant** instead: the key encrypted to the proxy, which the
 * holder cannot read.
 *
 * - **Derivation.** HKDF-SHA256 over the agent's vault proof (the
 *   deterministic signature the agent computes from its raw key at sign-in;
 *   see `managed/vault.ts`), with an info string naming the proxy origin and
 *   the connection id. Every device holding the agent derives the same key,
 *   nothing is stored, and the label keeps it apart from every other key
 *   derived from the same proof.
 * - **Grant.** HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256),
 *   HKDF-SHA256, AES-256-GCM, `info` = {@link GRANT_INFO}, empty `aad`,
 *   encrypted to the public key the proxy publishes at
 *   `GET /connection-key-grants/key`. Header form: `s1.` + base64url(enc ||
 *   ciphertext).
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const CONNECTION_KEY_HEADER = 'x-connection-key';
export const GRANT_INFO = 'integration-proxy-connection-key-grant-v1';
const DERIVATION_LABEL = 'atomic-integration-proxy-connection-key-v1';

const utf8 = (text: string) => new TextEncoder().encode(text);

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

export function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Not base64url');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');

  return Uint8Array.from(
    atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)),
    c => c.charCodeAt(0),
  );
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
};

/** A fresh connection id: 32 random bytes, base64url, unpadded. */
export const newConnectionId = () =>
  base64url(crypto.getRandomValues(new Uint8Array(32)));

/**
 * The key of `connectionId` at the proxy `origin`, derived from the agent's
 * vault proof (64 bytes).
 */
export function deriveConnectionKey(
  vaultProof: Uint8Array,
  origin: string,
  connectionId: string,
): Uint8Array {
  if (vaultProof.length !== 64) throw new Error('Vault proof must be 64 bytes');

  return hkdf(
    sha256,
    vaultProof,
    undefined,
    utf8(`${DERIVATION_LABEL}\n${origin}\n${connectionId}`),
    32,
  );
}

/** The `k1.` form of a key: for redeem, and for this page's own requests. */
export const rawConnectionKey = (key: Uint8Array) => `k1.${base64url(key)}`;

// RFC 9180 with this one suite. HKDF-Expand is used only for lengths up to
// 32 bytes (one SHA-256 block).
const KEM_SUITE = concat(utf8('KEM'), new Uint8Array([0x00, 0x20]));
const HPKE_SUITE = concat(
  utf8('HPKE'),
  new Uint8Array([0x00, 0x20, 0x00, 0x01, 0x00, 0x02]),
);

const extract = (salt: Uint8Array, ikm: Uint8Array) =>
  hmac(sha256, salt.length ? salt : new Uint8Array(32), ikm);

const expand = (prk: Uint8Array, info: Uint8Array, length: number) =>
  hmac(sha256, prk, concat(info, new Uint8Array([1]))).slice(0, length);

const labeledExtract = (
  suite: Uint8Array,
  salt: Uint8Array,
  label: string,
  ikm: Uint8Array,
) => extract(salt, concat(utf8('HPKE-v1'), suite, utf8(label), ikm));

const labeledExpand = (
  suite: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
) =>
  expand(
    prk,
    concat(
      new Uint8Array([length >> 8, length & 0xff]),
      utf8('HPKE-v1'),
      suite,
      utf8(label),
      info,
    ),
    length,
  );

/** PKCS #8 wrapping of a raw X25519 private key (RFC 8410). */
const PKCS8_X25519 = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04,
  0x22, 0x04, 0x20,
]);

/** An X25519 key pair from WebCrypto: fresh, or from fixed bytes (tests). */
async function ephemeral(fixed?: Uint8Array) {
  const algorithm = { name: 'X25519' };
  let privateKey: CryptoKey;
  let publicKey: Uint8Array;

  if (fixed) {
    privateKey = await crypto.subtle.importKey(
      'pkcs8',
      concat(PKCS8_X25519, fixed),
      algorithm,
      true,
      ['deriveBits'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', privateKey);
    publicKey = fromBase64url(jwk.x ?? '');
  } else {
    const pair = (await crypto.subtle.generateKey(algorithm, false, [
      'deriveBits',
    ])) as CryptoKeyPair;
    privateKey = pair.privateKey;
    publicKey = new Uint8Array(
      await crypto.subtle.exportKey('raw', pair.publicKey),
    );
  }

  return { privateKey, publicKey };
}

/**
 * HPKE base-mode `SealBase` for this suite. Returns `enc || ciphertext`.
 * `ephemeralPrivateKey` is for test vectors only.
 */
export async function hpkeSeal(
  recipientPublicKey: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  ephemeralPrivateKey?: Uint8Array,
): Promise<Uint8Array> {
  if (recipientPublicKey.length !== 32)
    throw new Error('An X25519 public key is 32 bytes');
  const { privateKey, publicKey: enc } = await ephemeral(ephemeralPrivateKey);
  const recipient = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(recipientPublicKey),
    { name: 'X25519' },
    false,
    [],
  );
  const dh = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'X25519', public: recipient },
      privateKey,
      256,
    ),
  );
  const eaePrk = labeledExtract(KEM_SUITE, new Uint8Array(), 'eae_prk', dh);
  const sharedSecret = labeledExpand(
    KEM_SUITE,
    eaePrk,
    'shared_secret',
    concat(enc, recipientPublicKey),
    32,
  );
  const empty = new Uint8Array();
  const context = concat(
    new Uint8Array([0x00]),
    labeledExtract(HPKE_SUITE, empty, 'psk_id_hash', empty),
    labeledExtract(HPKE_SUITE, empty, 'info_hash', info),
  );
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, 'secret', empty);
  const key = labeledExpand(HPKE_SUITE, secret, 'key', context, 32);
  const nonce = labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, 12);
  const aesKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: new Uint8Array(aad) },
      aesKey,
      new Uint8Array(plaintext),
    ),
  );

  return concat(enc, ciphertext);
}

/**
 * A key grant: `key` for `connectionId`, which only `sub` (an agent id, in
 * the canonical form the proxy compares) may present, until `exp` (Unix
 * seconds) if given. `proxyPublicKey` is the base64url key from
 * `GET /connection-key-grants/key`.
 */
export async function sealGrant(grant: {
  proxyPublicKey: string;
  connectionId: string;
  sub: string;
  key: Uint8Array;
  exp?: number;
}): Promise<string> {
  const plaintext = utf8(
    JSON.stringify({
      v: 1,
      connection_id: grant.connectionId,
      sub: grant.sub,
      key: base64url(grant.key),
      ...(grant.exp === undefined ? {} : { exp: grant.exp }),
    }),
  );
  const sealed = await hpkeSeal(
    fromBase64url(grant.proxyPublicKey),
    utf8(GRANT_INFO),
    new Uint8Array(),
    plaintext,
  );

  return `s1.${base64url(sealed)}`;
}

/**
 * The lines a v2 request signature covers when the request presents
 * `x-connection-key`: Atomic's five, plus the header value's SHA-256 (hex).
 */
export function connectionKeyLine(headerValue: string): string {
  return Array.from(sha256(utf8(headerValue)), b =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
