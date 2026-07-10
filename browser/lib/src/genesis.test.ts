import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { getPublicKey } from '@noble/ed25519';
import { decodeB64 } from './base64.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import {
  encodeGenesisCert,
  decodeGenesisCert,
  signGenesisCert,
  verifyGenesisCert,
  subjectForSignature,
  genesisSignerDid,
  type GenesisCert,
} from './genesis.js';

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

const unhex = (s: string): Uint8Array =>
  new Uint8Array(s.match(/../g)?.map(byte => parseInt(byte, 16)) ?? []);

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

// The single cross-language source of truth. The SAME file is asserted by the
// Rust side (`lib/src/genesis.rs::matches_the_golden_vectors`), so Rust and TS
// can only ever agree or both fail — no duplicated, drift-prone hand-copied
// vectors. If this fails after an intentional layout change, regenerate the
// fixture (the Rust generator) AND bump the version; a signed layout can never
// change silently.
describe('GenesisCert golden vectors (shared fixture)', () => {
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../../lib/src/genesis_test_vectors.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as {
    vectors: Array<{
      seedByte: number;
      privateKeyBase64: string;
      pubKeyHex: string;
      createdAt: number;
      nonceHex: string;
      stateHashHex: string | null;
      parent: string;
      drive: string;
      certBytesHex: string;
      signature: string;
      did: string;
      signerDid: string;
    }>;
  };

  for (const v of fixture.vectors) {
    it(`reproduces vector for seed ${v.seedByte}`, async ({ expect }) => {
      const cert: GenesisCert = {
        signerPubkey: unhex(v.pubKeyHex),
        createdAt: v.createdAt,
        nonce: unhex(v.nonceHex),
        stateHash: v.stateHashHex ? unhex(v.stateHashHex) : undefined,
        parent: v.parent,
        drive: v.drive,
      };

      // Byte-identical encoding is the load-bearing contract.
      expect(hex(encodeGenesisCert(cert))).toBe(v.certBytesHex);

      // Same key + cert → the exact same signature, DID, and signer DID.
      const signature = await signGenesisCert(cert, decodeB64(v.privateKeyBase64));
      expect(signature).toBe(v.signature);

      // The production signing path (a CryptoProvider signing raw bytes) must
      // produce the same signature — this is what actually mints the DID.
      const provider = new JSCryptoProvider(v.privateKeyBase64);
      expect(await provider.signBytes(encodeGenesisCert(cert))).toBe(v.signature);
      expect(subjectForSignature(signature)).toBe(v.did);
      expect(genesisSignerDid(cert)).toBe(v.signerDid);

      // The fixture bytes decode back to the same cert.
      expect(hex(encodeGenesisCert(decodeGenesisCert(unhex(v.certBytesHex))))).toBe(
        v.certBytesHex,
      );
    });
  }
});
