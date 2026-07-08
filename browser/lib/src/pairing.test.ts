import { describe, expect, it } from 'vitest';
import {
  decodePairingEnvelope,
  encodePairingEnvelope,
  PairingEnvelopeError,
  PAIRING_URI_PREFIX,
  type PairingEnvelope,
} from './pairing.js';
import { encodeB64Url } from './base64.js';

const NODE = `did:ad:node:${'ab'.repeat(32)}`;

const onboard: PairingEnvelope = {
  v: 1,
  kind: 'onboard',
  secret: 'c2VjcmV0LWpzb24=',
  node: NODE,
  url: 'http://192.168.0.153:9883',
  drives: '*',
};

const pair: PairingEnvelope = {
  v: 1,
  kind: 'pair',
  node: NODE,
  drives: ['did:ad:drive1', 'did:ad:drive2'],
};

function encodeRaw(payload: unknown): string {
  return `${PAIRING_URI_PREFIX}${encodeB64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  )}`;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof PairingEnvelopeError) {
      return error.code;
    }

    throw error;
  }

  throw new Error('expected the decode to throw');
}

describe('pairing envelope', () => {
  it('round-trips an onboard envelope', () => {
    const uri = encodePairingEnvelope(onboard);
    expect(uri.startsWith(PAIRING_URI_PREFIX)).toBe(true);
    expect(decodePairingEnvelope(uri)).toEqual(onboard);
  });

  it('round-trips a pair envelope', () => {
    expect(decodePairingEnvelope(encodePairingEnvelope(pair))).toEqual(pair);
  });

  it('accepts the bare payload without the uri prefix', () => {
    const uri = encodePairingEnvelope(pair);
    const bare = uri.slice(PAIRING_URI_PREFIX.length);
    expect(decodePairingEnvelope(bare)).toEqual(pair);
  });

  it('rejects an unknown version with its own error code', () => {
    expect(codeOf(() => decodePairingEnvelope(encodeRaw({ ...pair, v: 2 })))).toBe(
      'unsupported-version',
    );
  });

  it('rejects garbage and truncated payloads as malformed', () => {
    expect(codeOf(() => decodePairingEnvelope('not a code'))).toBe('malformed');
    const uri = encodePairingEnvelope(pair);
    expect(codeOf(() => decodePairingEnvelope(uri.slice(0, -10)))).toBe(
      'malformed',
    );
  });

  it('rejects an onboard envelope without a secret', () => {
    const { secret: _secret, ...withoutSecret } = onboard;
    expect(codeOf(() => decodePairingEnvelope(encodeRaw(withoutSecret)))).toBe(
      'malformed',
    );
  });

  it('rejects a pair envelope that smuggles a secret', () => {
    expect(
      codeOf(() =>
        decodePairingEnvelope(encodeRaw({ ...pair, secret: 'sneaky' })),
      ),
    ).toBe('malformed');
  });

  it('rejects invalid node identities', () => {
    for (const node of [
      'did:ad:agent:abc',
      `did:ad:node:${'zz'.repeat(32)}`,
      'did:ad:node:abcdef',
      undefined,
    ]) {
      expect(codeOf(() => decodePairingEnvelope(encodeRaw({ ...pair, node })))).toBe(
        'malformed',
      );
    }
  });

  it('rejects non-http urls', () => {
    expect(
      codeOf(() =>
        decodePairingEnvelope(encodeRaw({ ...pair, url: 'ftp://x.example' })),
      ),
    ).toBe('malformed');
  });

  it('rejects empty or invalid drive lists', () => {
    for (const drives of [[], ['ok', 7], 'all', undefined]) {
      expect(
        codeOf(() => decodePairingEnvelope(encodeRaw({ ...pair, drives }))),
      ).toBe('malformed');
    }
  });

  it('refuses to encode an envelope it would not decode', () => {
    expect(() =>
      encodePairingEnvelope({ ...pair, node: 'did:ad:node:short' }),
    ).toThrow(PairingEnvelopeError);
  });
});
