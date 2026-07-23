import { describe, it, expect } from 'vitest';
import {
  agentDbFingerprint,
  deriveKek,
  generateDbKey,
  unwrapDbKey,
  wrapDbKey,
} from './localDbKey';

/**
 * Only the pure crypto core is tested here (node's global WebCrypto); the IDB
 * persistence layer is a thin wrapper that would need a fake IndexedDB.
 */

function toBase64(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function toBase64url(bytes: Uint8Array): string {
  return toBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Two fixed 32-byte Ed25519-shaped private keys, base64url without padding.
const PRIVATE_KEY_A = toBase64url(
  new Uint8Array(Array.from({ length: 32 }, (_, i) => i)),
);
const PRIVATE_KEY_B = toBase64url(
  new Uint8Array(Array.from({ length: 32 }, (_, i) => 31 - i)),
);

const AGENT_SUBJECT = 'did:ad:agent:test-agent';

describe('agentDbFingerprint', () => {
  it('is deterministic and 16 lowercase hex chars', async () => {
    const first = await agentDbFingerprint(AGENT_SUBJECT);
    const second = await agentDbFingerprint(AGENT_SUBJECT);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs between subjects', async () => {
    const first = await agentDbFingerprint('did:ad:agent:one');
    const second = await agentDbFingerprint('did:ad:agent:two');

    expect(first).not.toBe(second);
  });
});

describe('generateDbKey', () => {
  it('returns 32 non-zero random bytes', () => {
    const key = generateDbKey();

    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
    expect(key.some(byte => byte !== 0)).toBe(true);
  });

  it('returns a different key each call', () => {
    expect(generateDbKey()).not.toEqual(generateDbKey());
  });
});

describe('wrapDbKey / unwrapDbKey', () => {
  it('roundtrips a DbKey through a wrapped record', async () => {
    const kek = await deriveKek(PRIVATE_KEY_A, AGENT_SUBJECT);
    const dbKey = generateDbKey();

    const record = await wrapDbKey(kek, dbKey);

    expect(record.version).toBe(1);
    expect(typeof record.iv).toBe('string');
    expect(typeof record.wrapped).toBe('string');

    const unwrapped = await unwrapDbKey(kek, record);

    expect(unwrapped).toEqual(dbKey);
  });

  it('throws when unwrapping with a KEK from a different private key', async () => {
    const kek = await deriveKek(PRIVATE_KEY_A, AGENT_SUBJECT);
    const wrongKek = await deriveKek(PRIVATE_KEY_B, AGENT_SUBJECT);

    const record = await wrapDbKey(kek, generateDbKey());

    await expect(unwrapDbKey(wrongKek, record)).rejects.toThrow();
  });

  it('throws when the ciphertext is tampered with', async () => {
    const kek = await deriveKek(PRIVATE_KEY_A, AGENT_SUBJECT);
    const record = await wrapDbKey(kek, generateDbKey());

    const bytes = fromBase64(record.wrapped);
    bytes[0] ^= 0xff;
    const tampered = { ...record, wrapped: toBase64(bytes) };

    await expect(unwrapDbKey(kek, tampered)).rejects.toThrow();
  });
});

describe('deriveKek', () => {
  it('accepts unpadded base64url containing - and _', async () => {
    // 0xfb 0xef opens with base64url `--`, the 0xff tail yields `_` runs.
    const keyBytes = new Uint8Array(32).fill(0xff);
    keyBytes[0] = 0xfb;
    keyBytes[1] = 0xef;
    const privateKey = toBase64url(keyBytes);

    expect(privateKey).toMatch(/-/);
    expect(privateKey).toMatch(/_/);
    expect(privateKey).not.toMatch(/=/);

    const kek = await deriveKek(privateKey, AGENT_SUBJECT);
    const dbKey = generateDbKey();
    const record = await wrapDbKey(kek, dbKey);

    expect(await unwrapDbKey(kek, record)).toEqual(dbKey);
  });
});
