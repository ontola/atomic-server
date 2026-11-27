// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  GRANT_INFO,
  deriveConnectionKey,
  hpkeSeal,
  sealGrant,
} from './connectionKeys';

const hex = (value: string) =>
  Uint8Array.from(value.match(/../g)!, b => parseInt(b, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

describe('hpkeSeal', () => {
  /**
   * RFC 9180 test vector: base mode, DHKEM(X25519, HKDF-SHA256),
   * HKDF-SHA256, AES-256-GCM (kem 0x20, kdf 1, aead 2), first encryption.
   * From the CFRG test-vectors file (commit 5f503c5) that the Rust `hpke`
   * crate the proxy uses also tests against.
   */
  it('matches the RFC 9180 vector for this suite', async () => {
    const sealed = await hpkeSeal(
      hex('430f4b9859665145a6b1ba274024487bd66f03a2dd577d7753c68d7d7d00c00c'),
      hex('4f6465206f6e2061204772656369616e2055726e'),
      hex('436f756e742d30'),
      hex('4265617574792069732074727574682c20747275746820626561757479'),
      hex('179d4b53b6365c45b600c4163b61d95cbc2f4d9e36f1695558dce265ab8bab11'),
    );
    expect(toHex(sealed.slice(0, 32))).toBe(
      '6c93e09869df3402d7bf231bf540fadd35cd56be14f97178f0954db94b7fc256',
    );
    expect(toHex(sealed.slice(32))).toBe(
      'e5d84cd531cfb583096e7cfa9641bd3079cf3a91cda813c52deb5f512be9931980a41de125a925cdad859d5b7a',
    );
  });

  it('uses a fresh ephemeral key each time', async () => {
    const recipient = hex(
      '430f4b9859665145a6b1ba274024487bd66f03a2dd577d7753c68d7d7d00c00c',
    );
    const message = new TextEncoder().encode('same');
    const [a, b] = await Promise.all([
      hpkeSeal(recipient, new Uint8Array(), new Uint8Array(), message),
      hpkeSeal(recipient, new Uint8Array(), new Uint8Array(), message),
    ]);
    expect(toHex(a)).not.toBe(toHex(b));
  });
});

describe('sealGrant', () => {
  it('is s1. plus enc and the sealed JSON', async () => {
    const grant = await sealGrant({
      proxyPublicKey: 'Qw9LmFlmUUWmsbonQCRIe9ZvA6LdV313U8aNfX0AwAw',
      connectionId: 'c'.repeat(43),
      sub: `atomic:agent:${'A'.repeat(42)}E`,
      key: new Uint8Array(32),
      exp: 1_790_000_600,
    });
    expect(grant.startsWith('s1.')).toBe(true);
    expect(GRANT_INFO).toBe('integration-proxy-connection-key-grant-v1');
  });
});

describe('deriveConnectionKey', () => {
  it('is HKDF-SHA256 over the vault proof, per proxy and connection', () => {
    const proof = new Uint8Array(64).fill(7);
    const key = deriveConnectionKey(proof, 'https://proxy.example', 'c1');
    expect(key.length).toBe(32);
    expect(toHex(key)).toBe(
      toHex(deriveConnectionKey(proof, 'https://proxy.example', 'c1')),
    );
    expect(toHex(key)).not.toBe(
      toHex(deriveConnectionKey(proof, 'https://proxy.example', 'c2')),
    );
    expect(() => deriveConnectionKey(new Uint8Array(32), 'x', 'c1')).toThrow();
  });
});
