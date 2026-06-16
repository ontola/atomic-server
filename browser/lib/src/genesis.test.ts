import { describe, it } from 'vitest';
import { getPublicKey } from '@noble/ed25519';
import {
  encodeGenesisCert,
  decodeGenesisCert,
  signGenesisCert,
  verifyGenesisCert,
  subjectForSignature,
  type GenesisCert,
} from './genesis.js';

describe('GenesisCert', () => {
  // This exact vector is pinned identically in `lib/src/genesis.rs`
  // (`known_byte_vector_v1`). If either side drifts, a browser-minted DID stops
  // verifying server-side. Do not change without changing both + the version.
  it('known byte vector v1 — must match the Rust layout', ({ expect }) => {
    const cert: GenesisCert = {
      signerPubkey: new Uint8Array(32).fill(1),
      createdAt: 1,
      nonce: new Uint8Array(16).fill(2),
      parent: 'x',
      drive: 'd',
    };
    const expected = [
      0x01,
      0x00, // version, flags (no stateHash)
      ...Array(32).fill(1), // signer pubkey
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // createdAt = 1, i64 LE
      ...Array(16).fill(2), // nonce
      1,
      0, // parent length = 1, u16 LE
      0x78, // "x"
      1,
      0, // drive length = 1, u16 LE
      0x64, // "d"
    ];
    expect(Array.from(encodeGenesisCert(cert))).toEqual(expected);
  });

  it('encode/decode roundtrip (with and without stateHash)', ({ expect }) => {
    const base: GenesisCert = {
      signerPubkey: new Uint8Array(32).fill(3),
      createdAt: 1_780_000_123_456,
      nonce: new Uint8Array(16).fill(7),
      parent: 'https://example.com/parent',
      drive: 'https://example.com/drive',
    };
    expect(decodeGenesisCert(encodeGenesisCert(base))).toEqual(base);

    const withHash: GenesisCert = {
      ...base,
      stateHash: new Uint8Array(32).fill(9),
    };
    expect(decodeGenesisCert(encodeGenesisCert(withHash))).toEqual(withHash);
  });

  it('cross-language signature vector v1 — must match Rust', async ({
    expect,
  }) => {
    // Ed25519 is deterministic, so signing the SAME cert with the SAME seed
    // yields the EXACT signature/DID in both TS and Rust
    // (`lib/src/genesis.rs::cross_lang_signature_vector_v1`). This byte-for-byte
    // match is what lets a browser-minted DID verify server-side.
    const seed = new Uint8Array(32).fill(7);
    const pub = await getPublicKey(seed);
    const cert: GenesisCert = {
      signerPubkey: pub,
      createdAt: 1,
      nonce: new Uint8Array(16).fill(2),
      parent: 'x',
      drive: 'd',
    };
    const sig = await signGenesisCert(cert, seed);
    expect(sig).toBe(
      '71Igt-CKD2nhZZn4aKCe8tetVUTCgMMqJ67d97Wrb3pT3LFazyP1lGJjAw2Gg9KY0daGHhHPXj3xFMWEmYVdCw',
    );
    expect(subjectForSignature(sig)).toBe(
      'did:ad:71Igt-CKD2nhZZn4aKCe8tetVUTCgMMqJ67d97Wrb3pT3LFazyP1lGJjAw2Gg9KY0daGHhHPXj3xFMWEmYVdCw',
    );
    expect(await verifyGenesisCert(cert, sig)).toBe(true);
  });

  it('sign then verify; a tampered field fails', async ({ expect }) => {
    const priv = new Uint8Array(32).fill(5);
    const pub = await getPublicKey(priv);
    const cert: GenesisCert = {
      signerPubkey: pub,
      createdAt: 1_780_000_000_000,
      nonce: new Uint8Array(16).fill(8),
      stateHash: new Uint8Array(32).fill(1),
      parent: 'https://example.com/p',
      drive: 'https://example.com/d',
    };

    const sig = await signGenesisCert(cert, priv);
    expect(await verifyGenesisCert(cert, sig)).toBe(true);
    expect(subjectForSignature(sig).startsWith('did:ad:')).toBe(true);

    const tampered: GenesisCert = { ...cert, createdAt: cert.createdAt + 1 };
    expect(await verifyGenesisCert(tampered, sig)).toBe(false);
  });

  it('decode rejects bad version, truncation, and trailing bytes', ({
    expect,
  }) => {
    const cert: GenesisCert = {
      signerPubkey: new Uint8Array(32).fill(1),
      createdAt: 1,
      nonce: new Uint8Array(16).fill(2),
      parent: 'x',
      drive: 'd',
    };
    const bytes = encodeGenesisCert(cert);

    const badVersion = bytes.slice();
    badVersion[0] = 0xff;
    expect(() => decodeGenesisCert(badVersion)).toThrow();

    expect(() => decodeGenesisCert(bytes.slice(0, bytes.length - 2))).toThrow();

    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => decodeGenesisCert(trailing)).toThrow();
  });
});
