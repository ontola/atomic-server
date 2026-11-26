import { expect, it } from 'vitest';
import {
  normalizeVaultSyncScope,
  parseSerializedVaultReceipt,
} from './resource-vault-evidence.js';

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
    parseSerializedVaultReceipt({
      subject: 'atomic:x',
      version: { '1': -1 },
      confirmedAt: 10,
    }),
  ).toBeUndefined();
});
