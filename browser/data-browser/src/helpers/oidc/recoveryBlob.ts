// @wc-ignore-file
/**
 * The recovery blob of an OIDC-linked identity: the agent secret, encrypted in
 * this browser under a passphrase the server never sees.
 *
 * PBKDF2-SHA256 into an AES-256-GCM key (WebCrypto, so it works on every
 * browser and in Tauri). The format is self-describing so the cost can be
 * raised later: `v1.<iterations>.<salt>.<iv>.<ciphertext>`, base64url parts.
 * The iterations are bounded when read, because the blob comes from a server.
 */

const VERSION = 'v1';
const ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 2_000_000;
const AAD = new TextEncoder().encode('atomic-oidc-recovery:v1');

export const MIN_PASSPHRASE_LENGTH = 10;

export class WrongPassphraseError extends Error {
  constructor() {
    super('That recovery passphrase is not right.');
    this.name = 'WrongPassphraseError';
  }
}

const toB64 = (bytes: Uint8Array): string => {
  let bin = '';

  for (const b of bytes) bin += String.fromCharCode(b);

  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64 = (s: string): Uint8Array<ArrayBuffer> => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);

  return out;
};

async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function encryptSecret(
  secret: string,
  passphrase: string,
  iterations = ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations, 'encrypt');
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: AAD },
      key,
      new TextEncoder().encode(secret),
    ),
  );

  return [VERSION, iterations, toB64(salt), toB64(iv), toB64(ct)].join('.');
}

export async function decryptSecret(
  blob: string,
  passphrase: string,
): Promise<string> {
  const [version, iters, salt, iv, ct, ...rest] = blob.split('.');
  const iterations = Number(iters);

  if (
    version !== VERSION ||
    !salt ||
    !iv ||
    !ct ||
    rest.length > 0 ||
    !Number.isInteger(iterations) ||
    iterations < MIN_ITERATIONS ||
    iterations > MAX_ITERATIONS
  ) {
    throw new Error('The recovery data from the server is not valid.');
  }

  const key = await deriveKey(passphrase, fromB64(salt), iterations, 'decrypt');

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(iv), additionalData: AAD },
      key,
      fromB64(ct),
    );

    return new TextDecoder().decode(plain);
  } catch {
    // The auth tag failed: the passphrase is wrong (or the blob was altered).
    throw new WrongPassphraseError();
  }
}
