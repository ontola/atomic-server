import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { getPublicKey } from '@noble/ed25519';
import { decodeB64 } from './base64.js';
import {
  SESSION_CERT_LEN,
  SESSION_CERT_VERSION_V1,
  decodeSessionCert,
  decodeSessionCertB64,
  encodeSessionCert,
  encodeSessionCertB64,
  encodeSessionCertClaims,
  sessionCertNeedsRefresh,
  sessionCertRootDid,
  sessionCertSessionDid,
  signSessionCert,
  verifySessionCert,
  type SessionCertClaims,
} from './session-cert.js';
import { GENESIS_VERSION_V1, encodeGenesisCert } from './genesis.js';

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

const unhex = (s: string): Uint8Array =>
  new Uint8Array(s.match(/../g)?.map(byte => parseInt(byte, 16)) ?? []);

const seed = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

async function certFor(
  rootSeed: number,
  sessionSeed: number,
  notBefore = 1_700_000_000_000,
  notAfter = 1_700_086_400_000,
) {
  const rootPrivate = seed(rootSeed);
  const sessionPrivate = seed(sessionSeed);
  const claims: SessionCertClaims = {
    sessionPubkey: await getPublicKey(sessionPrivate),
    notBefore,
    notAfter,
    rootPubkey: await getPublicKey(rootPrivate),
  };

  return {
    claims,
    rootPrivate,
    cert: await signSessionCert(claims, rootPrivate),
  };
}

describe('SessionCert', () => {
  // Pinned identically in `lib/src/session_cert.rs`. If either side drifts, a
  // commit signed in this browser stops verifying on the node.
  it('known byte layout — must match the Rust layout', async ({ expect }) => {
    const claims: SessionCertClaims = {
      sessionPubkey: new Uint8Array(32).fill(1),
      notBefore: 1,
      notAfter: 2,
      rootPubkey: new Uint8Array(32).fill(3),
    };
    const expected = [
      SESSION_CERT_VERSION_V1,
      ...Array(32).fill(1), // session pubkey
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // notBefore = 1, i64 LE
      2,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // notAfter = 2, i64 LE
      ...Array(32).fill(3), // root pubkey
    ];
    expect(Array.from(encodeSessionCertClaims(claims))).toEqual(expected);
    expect(encodeSessionCertClaims(claims).length).toBe(81);
  });

  it('encodes a negative bound as two-s complement', async ({ expect }) => {
    const { cert } = await certFor(3, 4, 0, -1);
    expect(hex(encodeSessionCertClaims(cert)).slice(82, 98)).toBe(
      'ffffffffffffffff',
    );
    expect(decodeSessionCert(encodeSessionCert(cert)).notAfter).toBe(-1);
  });

  it('round trips through bytes and base64', async ({ expect }) => {
    const { cert } = await certFor(5, 6);
    expect(encodeSessionCert(cert).length).toBe(SESSION_CERT_LEN);
    expect(decodeSessionCert(encodeSessionCert(cert))).toEqual(cert);
    // Compare bytes, not objects: `decodeB64` hands back a Node Buffer here,
    // which is a Uint8Array with a different constructor tag.
    expect(
      hex(encodeSessionCert(decodeSessionCertB64(encodeSessionCertB64(cert)))),
    ).toBe(hex(encodeSessionCert(cert)));
  });

  it('verifies inside the window and names the root, not the session', async ({
    expect,
  }) => {
    const { cert } = await certFor(7, 8);
    const did = await verifySessionCert(
      cert,
      cert.sessionPubkey,
      cert.notBefore + 1,
    );
    expect(did).toBe(sessionCertRootDid(cert));
    expect(did).not.toBe(sessionCertSessionDid(cert));
    expect(did.startsWith('did:ad:agent:')).toBe(true);
  });

  it('rejects a key the certificate was not issued for', async ({ expect }) => {
    const { cert } = await certFor(9, 10);
    const stranger = await getPublicKey(seed(11));
    await expect(
      verifySessionCert(cert, stranger, cert.notBefore + 1),
    ).rejects.toThrow('issued for a different key');
  });

  it('rejects a timestamp outside the window, inclusive at both bounds', async ({
    expect,
  }) => {
    const { cert } = await certFor(12, 13);
    await expect(
      verifySessionCert(cert, cert.sessionPubkey, cert.notBefore - 1),
    ).rejects.toThrow('not valid yet');
    await expect(
      verifySessionCert(cert, cert.sessionPubkey, cert.notAfter + 1),
    ).rejects.toThrow('expired');
    await expect(
      verifySessionCert(cert, cert.sessionPubkey, cert.notBefore),
    ).resolves.toBeTypeOf('string');
    await expect(
      verifySessionCert(cert, cert.sessionPubkey, cert.notAfter),
    ).resolves.toBeTypeOf('string');
  });

  it('rejects a tampered signature and an extended window', async ({
    expect,
  }) => {
    const { cert } = await certFor(14, 15);

    const flipped = { ...cert, signature: Uint8Array.from(cert.signature) };
    flipped.signature[0] ^= 0xff;
    await expect(
      verifySessionCert(flipped, cert.sessionPubkey, cert.notBefore),
    ).rejects.toThrow('signature is invalid');

    // Extending the window is the attack the signature exists to stop.
    const extended = { ...cert, notAfter: cert.notAfter + 86_400_000 };
    await expect(
      verifySessionCert(extended, cert.sessionPubkey, extended.notAfter),
    ).rejects.toThrow('signature is invalid');
  });

  it('refuses to sign with a key that is not the named root', async ({
    expect,
  }) => {
    const { claims } = await certFor(16, 17);
    await expect(signSessionCert(claims, seed(18))).rejects.toThrow(
      'does not match the signing key',
    );
  });

  it('rejects truncation, trailing bytes and a foreign version', async ({
    expect,
  }) => {
    const { cert } = await certFor(19, 20);
    const encoded = encodeSessionCert(cert);

    expect(() => decodeSessionCert(encoded.slice(0, -1))).toThrow('truncated');
    expect(() => decodeSessionCert(new Uint8Array([...encoded, 0]))).toThrow(
      'trailing bytes',
    );

    const wrongVersion = Uint8Array.from(encoded);
    wrongVersion[0] = GENESIS_VERSION_V1;
    expect(() => decodeSessionCert(wrongVersion)).toThrow('Unsupported');
  });

  // The reason the version byte is not 0x01: a genesis certificate's signed
  // payload must never be readable as a session certificate's.
  it('cannot be confused with a genesis payload of the same length', ({
    expect,
  }) => {
    const genesis = encodeGenesisCert({
      signerPubkey: new Uint8Array(32).fill(1),
      createdAt: 0,
      nonce: new Uint8Array(16),
      // 58 + (2 + 9) + (2 + 10) = 81 bytes, exactly a session cert's signed
      // length, so length alone would not separate them.
      parent: 'did:ad:pa',
      drive: 'did:ad:dri',
    });
    expect(genesis.length).toBe(81);
    expect(genesis[0]).not.toBe(SESSION_CERT_VERSION_V1);
  });

  it('asks for a refresh once half the window has gone', async ({ expect }) => {
    const { cert } = await certFor(21, 22, 1000, 3000);
    expect(sessionCertNeedsRefresh(cert, 1999)).toBe(false);
    expect(sessionCertNeedsRefresh(cert, 2000)).toBe(true);
    expect(sessionCertNeedsRefresh(cert, 5000)).toBe(true);
  });
});

// The fixture below is GENERATED BY AND CHECKED AGAINST the Rust side
// (`lib/src/session_cert.rs::golden::matches_the_golden_vectors`), so Rust and
// TS can only ever agree or both fail — no hand-copied, drift-prone vectors.
// If this fails after an intentional layout change, regenerate the fixture AND
// bump the version; a signed layout can never change silently.
describe('SessionCert golden vectors (shared fixture)', () => {
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          '../../../lib/src/session_cert_test_vectors.json',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  ) as {
    vectors: Array<{
      rootSeedByte: number;
      sessionSeedByte: number;
      rootPrivateKeyBase64: string;
      rootPubKeyHex: string;
      sessionPubKeyHex: string;
      notBefore: number;
      notAfter: number;
      signedBytesHex: string;
      certBytesHex: string;
      certBase64: string;
      rootDid: string;
      sessionDid: string;
    }>;
  };

  for (const v of fixture.vectors) {
    it(`reproduces vector for root seed ${v.rootSeedByte}`, async ({
      expect,
    }) => {
      const claims: SessionCertClaims = {
        sessionPubkey: unhex(v.sessionPubKeyHex),
        notBefore: v.notBefore,
        notAfter: v.notAfter,
        rootPubkey: unhex(v.rootPubKeyHex),
      };

      // Byte-identical encoding is the load-bearing contract.
      expect(hex(encodeSessionCertClaims(claims))).toBe(v.signedBytesHex);

      // Same root key + claims → the exact same certificate, byte for byte.
      const cert = await signSessionCert(
        claims,
        decodeB64(v.rootPrivateKeyBase64),
      );
      expect(hex(encodeSessionCert(cert))).toBe(v.certBytesHex);
      expect(encodeSessionCertB64(cert)).toBe(v.certBase64);
      expect(sessionCertRootDid(cert)).toBe(v.rootDid);
      expect(sessionCertSessionDid(cert)).toBe(v.sessionDid);

      // And the fixture must decode back to the same thing, so this is a
      // decode target too, not only an encode one.
      expect(decodeSessionCert(unhex(v.certBytesHex))).toEqual(cert);
    });
  }
});

// The plumbing that makes the certificate reach the server: an Agent that
// carries one puts it inside the signed commit and on every auth proof, and an
// Agent that does not is byte-identical to before.
describe('carrying a session certificate', () => {
  it('signs it into the commit, and omits it entirely without one', async ({
    expect,
  }) => {
    const { Agent } = await import('./agent.js');
    const { CommitBuilder, serializeDeterministically } =
      await import('./commit.js');

    const keys = await Agent.generateKeyPair();
    const agent = await Agent.fromSecret(
      Agent.buildSecret(keys.privateKey, `did:ad:agent:${keys.publicKey}`),
      'js',
    );

    const build = () => {
      const builder = new CommitBuilder('https://localhost/thing');
      builder.setLoroUpdate(new Uint8Array([1, 2, 3]));

      return builder;
    };

    const plain = await build().signAt(agent, 1_700_000_000_000);
    expect(plain.sessionCert).toBeUndefined();
    expect(serializeDeterministically({ ...plain })).not.toContain(
      'sessionCert',
    );

    const { cert } = await certFor(30, 31);
    agent.sessionCert = encodeSessionCertB64(cert);

    const certified = await build().signAt(agent, 1_700_000_000_000);
    expect(certified.sessionCert).toBe(agent.sessionCert);
    // Inside the signed bytes: stripping it invalidates the signature, which
    // is what stops the session DID being presented on its own.
    expect(serializeDeterministically({ ...certified })).toContain(
      agent.sessionCert,
    );
    expect(certified.signature).not.toBe(plain.signature);
  });

  it('puts it on auth headers and in the auth resource', async ({ expect }) => {
    const { Agent } = await import('./agent.js');
    const { createAuthentication, signRequest } =
      await import('./authentication.js');

    const keys = await Agent.generateKeyPair();
    const agent = await Agent.fromSecret(
      Agent.buildSecret(keys.privateKey, `did:ad:agent:${keys.publicKey}`),
      'js',
    );
    const subject = 'https://localhost/thing';

    expect(await signRequest(subject, agent, {})).not.toHaveProperty(
      'x-atomic-session-cert',
    );

    const { cert } = await certFor(32, 33);
    agent.sessionCert = encodeSessionCertB64(cert);

    expect(
      (await signRequest(subject, agent, {}))['x-atomic-session-cert'],
    ).toBe(agent.sessionCert);
    expect(
      (await createAuthentication(subject, agent))[
        'https://atomicdata.dev/properties/auth/sessionCert'
      ],
    ).toBe(agent.sessionCert);
  });
});
