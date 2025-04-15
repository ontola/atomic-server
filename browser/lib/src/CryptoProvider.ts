import { sha512 } from '@noble/hashes/sha512';
import { decodeB64, encodeB64 } from './base64.js';
import { sign, getPublicKey, utils } from '@noble/ed25519';

export interface CryptoProvider {
  type: string;
  sign(data: string): Promise<string>;
  getPublicKey(): Promise<string>;
}

interface DecodedSecret {
  privateKey: string;
  subject: string;
  initialDrive?: string;
}

/**
 * CryptoProvider implemented in javascript.
 * Only use this provider if your environment does not support the SubtleCrypto API.
 */
export class JSCryptoProvider implements CryptoProvider {
  #privateKey: Uint8Array;
  constructor(privateKey: string) {
    utils.sha512 = msg => Promise.resolve(sha512(msg));
    this.#privateKey = new Uint8Array(decodeB64(privateKey));
  }

  public get type(): string {
    return 'js';
  }

  static fromSecret(
    secret: string,
  ): [provider: JSCryptoProvider, subject: string, initialDrive?: string] {
    const { privateKey, subject, initialDrive } = decodeSecret(secret);

    return [new JSCryptoProvider(privateKey), subject, initialDrive];
  }

  async sign(message: string): Promise<string> {
    const utf8Encode = new TextEncoder();
    const messageBytes: Uint8Array = utf8Encode.encode(message);
    const signatureHex = await sign(messageBytes, this.#privateKey);
    const signatureBase64 = encodeB64(signatureHex);

    return signatureBase64;
  }

  async getPublicKey(): Promise<string> {
    const publickey = await getPublicKey(this.#privateKey);
    const publicBase64 = encodeB64(publickey);

    return publicBase64;
  }
}

interface CryptoKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

/**
 * A CryptoProvider that uses the browser's SubtleCrypto API. This means that the private key can not be extracted from javascript.
 * This makes it more secure against XSS attacks.
 */
export class SubtleCryptoProvider implements CryptoProvider {
  #privateKey: CryptoKey;
  #publicKey: CryptoKey;

  constructor(keyPair: CryptoKeyPair) {
    this.#privateKey = keyPair.privateKey;
    this.#publicKey = keyPair.publicKey;
  }
  public get type(): string {
    return 'subtle';
  }

  static async createKeysFromSecret(
    secret: string,
  ): Promise<
    [keyPair: CryptoKeyPair, subject: string, initialDrive?: string]
  > {
    const { privateKey, subject, initialDrive } = decodeSecret(secret);
    const rawKey = decodeB64(privateKey);
    const privateCryptoKey =
      await SubtleCryptoProvider.importPrivateKey(rawKey);

    const publicKey = (await getPublicKey(rawKey)) as Uint8Array<ArrayBuffer>;

    const publicCryptoKey =
      await SubtleCryptoProvider.importPublicKey(publicKey);

    return [
      { privateKey: privateCryptoKey, publicKey: publicCryptoKey },
      subject,
      initialDrive,
    ];
  }

  static async createKeysFromKeyPair(keyPair: KeyPair): Promise<CryptoKeyPair> {
    const privateKey = decodeB64(keyPair.privateKey);
    const publicKey = decodeB64(keyPair.publicKey);

    return {
      privateKey: await SubtleCryptoProvider.importPrivateKey(privateKey),
      publicKey: await SubtleCryptoProvider.importPublicKey(
        new Uint8Array(publicKey),
      ),
    };
  }

  private static async importPrivateKey(
    privateKey: Uint8Array<ArrayBufferLike>,
  ): Promise<CryptoKey> {
    // Not all browsers support importing raw private keys so we convert it to PKCS#8 instead
    // Ed25519 PKCS#8 prefix (16 bytes)
    const prefix = new Uint8Array([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
      0x04, 0x22, 0x04, 0x20,
    ]);

    // Combine prefix with the key
    const pkcs8Key = new Uint8Array(prefix.length + privateKey.length);
    pkcs8Key.set(prefix);
    pkcs8Key.set(privateKey, prefix.length);

    return globalThis.crypto.subtle.importKey(
      'pkcs8',
      pkcs8Key,
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
  }

  private static async importPublicKey(
    publicKey: Uint8Array<ArrayBuffer>,
  ): Promise<CryptoKey> {
    return globalThis.crypto.subtle.importKey(
      'raw',
      publicKey,
      { name: 'Ed25519' },
      true,
      ['verify'],
    );
  }

  public async sign(message: string): Promise<string> {
    const utf8Encode = new TextEncoder();
    const signature = await globalThis.crypto.subtle.sign(
      { name: 'Ed25519' },
      this.#privateKey,
      utf8Encode.encode(message),
    );
    const signatureBase64 = encodeB64(new Uint8Array(signature));

    return signatureBase64;
  }

  public async getPublicKey(): Promise<string> {
    const publicKey = await globalThis.crypto.subtle.exportKey(
      'raw',
      this.#publicKey,
    );
    const publicBase64 = encodeB64(new Uint8Array(publicKey));

    return publicBase64;
  }
}

const decodeSecret = (secret: string): DecodedSecret => {
  const agentBytes = atob(secret);
  let parsed: DecodedSecret;

  try {
    parsed = JSON.parse(agentBytes);
  } catch (e) {
    throw new Error('Invalid Secret, not a valid encoded JSON object');
  }

  const { privateKey } = parsed;
  let { subject } = parsed;

  if (!privateKey) {
    throw new Error('Invalid Secret, no private key found');
  }

  if (!subject) {
    throw new Error('Invalid Secret, no subject found');
  }

  // Migrate legacy HTTP agent subjects (https://server/agents/{pubkey}) to did:ad:agent:{pubkey}
  const httpAgentMatch = subject.match(/^https?:\/\/[^/]+\/agents\/(.+)$/);

  if (httpAgentMatch) {
    subject = `did:ad:agent:${httpAgentMatch[1]}`;
  }

  return { privateKey, subject, initialDrive: parsed.initialDrive };
};

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const privateBytes = utils.randomPrivateKey();
  const publicBytes = await getPublicKey(privateBytes);
  const privateKey = encodeB64(privateBytes);
  const publicKey = encodeB64(publicBytes);

  return {
    publicKey,
    privateKey,
  };
}
