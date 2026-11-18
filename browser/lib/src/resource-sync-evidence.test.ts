import { describe, expect, it } from 'vitest';
import {
  normalizeResourceSyncScope,
  parseSerializedServerReceipt,
} from './resource-sync-evidence.js';

describe('persisted resource sync schema', () => {
  const receipt = {
    subject: 'did:ad:resource',
    version: { '18446744073709551615': 7 },
    confirmedAt: 123,
  };
  it('canonicalizes destination origins and legacy identities', () => {
    expect(
      normalizeResourceSyncScope({
        agent: 'did:ad:alice',
        serverUrl: 'https://EXAMPLE.com:443/a?b=1',
      }),
    ).toEqual({ agent: 'atomic:alice', serverUrl: 'https://example.com' });
    expect(parseSerializedServerReceipt(receipt)?.subject).toBe(
      'atomic:resource',
    );
  });
  it.each([
    null,
    {},
    { ...receipt, confirmedAt: NaN },
    { ...receipt, confirmedAt: -1 },
    { ...receipt, confirmedAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...receipt, version: { bad: 1 } },
    { ...receipt, version: { '01': 1 } },
    { ...receipt, version: { '18446744073709551616': 1 } },
    { ...receipt, version: { '1': -1 } },
    { ...receipt, version: { '1': 0.5 } },
    { ...receipt, version: { '1': 2147483648 } },
    { ...receipt, version: [] },
  ])('rejects malformed evidence %#', value => {
    expect(parseSerializedServerReceipt(value)).toBeUndefined();
  });
  it.each(['not a URL', 'file:///private', 'wss://example.com'])(
    'rejects non-server destinations %s',
    serverUrl => {
      expect(
        normalizeResourceSyncScope({ agent: 'atomic:alice', serverUrl }),
      ).toBeUndefined();
    },
  );
});
