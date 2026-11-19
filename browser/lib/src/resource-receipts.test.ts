import { describe, expect, it } from 'vitest';
import {
  normalizeResourceSyncScope,
  normalizeVaultSyncScope,
  parseSerializedReceipt,
} from './resource-receipts.js';

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
    expect(parseSerializedReceipt(receipt)?.subject).toBe('atomic:resource');
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
    expect(parseSerializedReceipt(value)).toBeUndefined();
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

const scope = {
  managedAccount: 'alice@example.test',
  agent: 'did:ad:alice',
  portalUrl: 'https://PORTAL.example:443/api/',
  drive: 'did:ad:drive',
  drivePseudonym: 'opaque-vault',
  keyEpoch: 1,
};

it('canonicalizes identity and portal paths without merging different endpoints', () => {
  expect(normalizeVaultSyncScope(scope)).toEqual({
    ...scope,
    agent: 'atomic:alice',
    drive: 'atomic:drive',
    portalUrl: 'https://portal.example/api',
  });
  expect(
    normalizeVaultSyncScope({
      ...scope,
      portalUrl: 'https://portal.example/other-api',
    })?.portalUrl,
  ).not.toBe(normalizeVaultSyncScope(scope)?.portalUrl);
});

it.each([
  { managedAccount: '' },
  { agent: '' },
  { drive: '' },
  { drivePseudonym: 'bad\0value' },
  { portalUrl: 'file:///private' },
  { keyEpoch: -1 },
  { keyEpoch: 4294967296 },
  { keyEpoch: 1.5 },
])('rejects invalid vault scope %#', change => {
  expect(normalizeVaultSyncScope({ ...scope, ...change })).toBeUndefined();
});

it('rejects malformed vault version evidence', () => {
  expect(
    parseSerializedReceipt({
      subject: 'atomic:x',
      version: { '1': -1 },
      confirmedAt: 10,
    }),
  ).toBeUndefined();
});
