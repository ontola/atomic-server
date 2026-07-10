import { describe, expect, it } from 'vitest';
import {
  decodePairingEnvelope,
  encodePairingEnvelope,
  PairingEnvelopeError,
  PAIRING_URI_PREFIX,
  type PairingEnvelope,
} from './pairing.js';

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

/** Build a URI from raw query params, bypassing the encoder's validation. */
function uriOf(params: Record<string, string | string[] | undefined>): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;

    for (const entry of Array.isArray(value) ? value : [value]) {
      parts.push(`${key}=${entry}`);
    }
  }

  return `${PAIRING_URI_PREFIX}${parts.join('&')}`;
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

  it('writes the node identity the way the rest of the app writes it', () => {
    // The whole point of the readable form: no base64, no percent-escaped
    // colons. A human reading the copied code sees a did:ad:node: identity.
    expect(encodePairingEnvelope(pair)).toContain(`node=${NODE}`);
  });

  it('repeats the parameter for a multi-drive envelope', () => {
    expect(encodePairingEnvelope(pair)).toContain(
      'drives=did:ad:drive1&drives=did:ad:drive2',
    );
  });

  it('accepts a bare node DID as a routing-only code for every drive', () => {
    expect(decodePairingEnvelope(`  ${NODE}  `)).toEqual({
      v: 1,
      kind: 'pair',
      node: NODE,
      drives: '*',
    });
  });

  it('round-trips a url hint through percent-encoding', () => {
    const decoded = decodePairingEnvelope(encodePairingEnvelope(onboard));
    expect(decoded.url).toBe('http://192.168.0.153:9883');
  });

  it('round-trips a secret containing base64 padding and plus signs', () => {
    const secret = 'a+b/c=='; // would break an unescaped query value
    const uri = encodePairingEnvelope({ ...onboard, secret });
    expect(decodePairingEnvelope(uri).secret).toBe(secret);
  });

  it('rejects an unknown version with its own error code', () => {
    expect(
      codeOf(() => decodePairingEnvelope(uriOf({ ...pair, v: '2' } as never))),
    ).toBe('unsupported-version');
  });

  it('rejects a missing version as malformed', () => {
    expect(
      codeOf(() =>
        decodePairingEnvelope(uriOf({ kind: 'pair', node: NODE, drives: '*' })),
      ),
    ).toBe('malformed');
  });

  it('rejects garbage and truncated payloads as malformed', () => {
    expect(codeOf(() => decodePairingEnvelope('not a code'))).toBe('malformed');
    expect(codeOf(() => decodePairingEnvelope('https://example.com'))).toBe(
      'malformed',
    );
  });

  it('rejects an onboard envelope without a secret', () => {
    expect(
      codeOf(() =>
        decodePairingEnvelope(
          uriOf({ v: '1', kind: 'onboard', node: NODE, drives: '*' }),
        ),
      ),
    ).toBe('malformed');
  });

  it('rejects a pair envelope that smuggles a secret', () => {
    expect(
      codeOf(() =>
        decodePairingEnvelope(
          uriOf({
            v: '1',
            kind: 'pair',
            node: NODE,
            drives: '*',
            secret: 'sneaky',
          }),
        ),
      ),
    ).toBe('malformed');
  });

  it('rejects an unknown kind', () => {
    expect(
      codeOf(() =>
        decodePairingEnvelope(
          uriOf({ v: '1', kind: 'takeover', node: NODE, drives: '*' }),
        ),
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
      expect(
        codeOf(() =>
          decodePairingEnvelope(
            uriOf({ v: '1', kind: 'pair', node, drives: '*' }),
          ),
        ),
      ).toBe('malformed');
    }
  });

  it('rejects non-http urls', () => {
    expect(
      codeOf(() =>
        decodePairingEnvelope(
          uriOf({
            v: '1',
            kind: 'pair',
            node: NODE,
            drives: '*',
            url: encodeURIComponent('ftp://x.example'),
          }),
        ),
      ),
    ).toBe('malformed');
  });

  it('rejects empty or contradictory drive lists', () => {
    for (const drives of [undefined, ['*', 'did:ad:drive1']]) {
      expect(
        codeOf(() =>
          decodePairingEnvelope(
            uriOf({ v: '1', kind: 'pair', node: NODE, drives }),
          ),
        ),
      ).toBe('malformed');
    }
  });

  it('refuses to encode an envelope it would not decode', () => {
    expect(() =>
      encodePairingEnvelope({ ...pair, node: 'did:ad:node:short' }),
    ).toThrow(PairingEnvelopeError);
  });
});
