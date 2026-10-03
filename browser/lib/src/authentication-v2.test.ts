import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { Agent } from './agent.js';
import {
  requestSignatureMessageV2,
  sha256Hex,
  signRequest,
} from './authentication.js';
import { decodeB64 } from './base64.js';
import { JSCryptoProvider } from './CryptoProvider.js';

// ---- Cross-implementation golden vectors ----
//
// `authentication_v2_vectors.json` is written by the Rust side
// (`cargo test -p atomic_lib --lib print_v2_vectors -- --ignored --nocapture`)
// into `lib/src/authentication_v2_vectors.json`; the copy next to this file is
// what CI's browser-only container can reach, and a Rust test
// (`browser_copy_of_v2_vectors_is_identical`) fails when the two drift. Rust
// verifies every vector; here every one must be produced byte-for-byte.

interface V2Vector {
  name: string;
  private_key: string;
  public_key: string;
  agent: string;
  method: string;
  url: string;
  timestamp: number;
  body: string;
  body_sha256_hex: string;
  message: string;
  signature: string;
}

const { vectors } = JSON.parse(
  readFileSync(
    new URL('./authentication_v2_vectors.json', import.meta.url),
    'utf8',
  ),
) as { vectors: V2Vector[] };

async function verifies(publicKey: string, message: string, sig: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(decodeB64(publicKey)),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );

  return crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    new Uint8Array(decodeB64(sig)),
    new TextEncoder().encode(message),
  );
}

describe('version 2 request signatures', () => {
  it('has vectors to check', ({ expect }) => {
    expect(vectors.length).toBeGreaterThanOrEqual(4);
  });

  for (const v of vectors) {
    it(`reproduces the Rust vector ${v.name}`, async ({ expect }) => {
      expect(sha256Hex(v.body)).toBe(v.body_sha256_hex);
      expect(
        requestSignatureMessageV2(
          v.method,
          v.url,
          v.timestamp,
          v.body_sha256_hex,
        ),
      ).toBe(v.message);

      // noble's Ed25519 is deterministic, like dalek: same bytes out.
      const agent = new Agent(new JSCryptoProvider(v.private_key), v.agent);
      const headers = await signRequest(
        v.url,
        agent,
        {},
        {
          method: v.method,
          body: v.body,
          timestamp: v.timestamp,
        },
      );

      expect(headers).toEqual({
        'x-atomic-public-key': v.public_key,
        'x-atomic-signature': v.signature,
        'x-atomic-timestamp': v.timestamp.toString(),
        'x-atomic-agent': v.agent,
        'x-atomic-signature-version': '2',
      });
    });
  }

  it('hashes bytes and strings alike', ({ expect }) => {
    const v = vectors.find(x => x.name === 'patch_utf8_body')!;
    const bytes = new TextEncoder().encode(v.body);
    expect(sha256Hex(bytes)).toBe(v.body_sha256_hex);
    expect(sha256Hex(bytes.buffer as ArrayBuffer)).toBe(v.body_sha256_hex);
    expect(sha256Hex(undefined)).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(null)).toBe(sha256Hex(''));
  });

  it('signs with a non-extractable WebCrypto key', async ({ expect }) => {
    const agent = await Agent.generateNonExtractable();
    const publicKey = await agent.getPublicKey();
    expect(agent.subject).toBe(`atomic:agent:${publicKey}`);

    const url = 'https://proxy.example/proxy/c_1/github/user?x=1';
    const body = '{"a":1}';
    const timestamp = 1_790_000_000_000;
    const headers = await signRequest(
      url,
      agent,
      { 'content-type': 'application/json' },
      { method: 'post', body, timestamp },
    );

    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-atomic-agent']).toBe(agent.subject);
    expect(headers['x-atomic-signature-version']).toBe('2');

    const message = requestSignatureMessageV2(
      'POST',
      url,
      timestamp,
      sha256Hex(body),
    );
    expect(
      await verifies(publicKey, message, headers['x-atomic-signature']),
    ).toBe(true);
    // The body is covered.
    expect(
      await verifies(
        publicKey,
        requestSignatureMessageV2('POST', url, timestamp, sha256Hex('{}')),
        headers['x-atomic-signature'],
      ),
    ).toBe(false);
  });

  it('keeps the key non-extractable', async ({ expect }) => {
    const generate = crypto.subtle.generateKey.bind(crypto.subtle);
    let pair: CryptoKeyPair | undefined;

    const spy = async (...args: Parameters<typeof generate>) => {
      pair = (await generate(...args)) as CryptoKeyPair;

      return pair;
    };

    const original = crypto.subtle.generateKey;
    (crypto.subtle as { generateKey: unknown }).generateKey = spy;

    try {
      await Agent.generateNonExtractable();
    } finally {
      (crypto.subtle as { generateKey: unknown }).generateKey = original;
    }

    expect(pair?.privateKey.extractable).toBe(false);
    await expect(
      crypto.subtle.exportKey('pkcs8', pair!.privateKey),
    ).rejects.toThrow();
  });

  it('fails clearly where WebCrypto has no Ed25519', async ({ expect }) => {
    const original = crypto.subtle.generateKey;
    (crypto.subtle as { generateKey: unknown }).generateKey = () =>
      Promise.reject(
        new DOMException('Unrecognized name', 'NotSupportedError'),
      );

    try {
      await expect(Agent.generateNonExtractable()).rejects.toThrow(
        /non-extractable Ed25519/,
      );
    } finally {
      (crypto.subtle as { generateKey: unknown }).generateKey = original;
    }
  });

  it('signs the normalised URL', async ({ expect }) => {
    const v = vectors.find(x => x.name === 'post_delegation')!;
    const agent = new Agent(new JSCryptoProvider(v.private_key), v.agent);
    // `new URL().href` lower-cases the host; the server sees it that way.
    const headers = await signRequest(
      v.url.replace('proxy.example', 'PROXY.example'),
      agent,
      {},
      { method: v.method, body: v.body, timestamp: v.timestamp },
    );
    expect(headers['x-atomic-signature']).toBe(v.signature);
  });

  it('can send another agent subject form', async ({ expect }) => {
    const v = vectors[0];
    const agent = new Agent(
      new JSCryptoProvider(v.private_key),
      `did:ad:agent:${v.public_key}`,
    );
    const headers = await signRequest(
      v.url,
      agent,
      {},
      {
        method: v.method,
        body: v.body,
        timestamp: v.timestamp,
        agentSubject: v.agent,
      },
    );
    expect(headers['x-atomic-agent']).toBe(v.agent);
    expect(headers['x-atomic-signature']).toBe(v.signature);
  });

  it('leaves version 1 unchanged', async ({ expect }) => {
    const v = vectors[0];
    const agent = new Agent(new JSCryptoProvider(v.private_key), v.agent);
    const headers = await signRequest(v.url, agent, {});
    expect(headers['x-atomic-signature-version']).toBeUndefined();
    const ts = Number(headers['x-atomic-timestamp']);
    expect(headers['x-atomic-signature']).toBe(
      await agent.createSignature(v.url, ts),
    );
  });
});
