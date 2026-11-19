import { expect, it } from 'vitest';
import { collectionIdentity, sourceKey } from './builtinSyncIdentity.js';
import {
  parseSyncableSourceConfig,
  parseSyncableSourceKey,
  sourceConfigMatchesKey,
} from './syncableSource';

const base = {
  version: 2 as const,
  proxyOrigin: 'https://proxy.example',
  platform: 'calendar-service',
  principal: {
    kind: 'authenticated' as const,
    namespace: 'https://identity.example',
    subject: 7,
  },
  connectionId: 's'.repeat(43),
};
const collection = {
  collection: 'events',
  resource: 'event',
  pathParams: { calendar: 'one' },
  path: '/calendars/one/events',
  method: 'GET' as const,
  query: {},
  body: {},
};
it('preserves typed principal and source identities independently of credential slots', () => {
  const config = parseSyncableSourceConfig({ ...base, collection });
  const key = sourceKey({
    ...config,
    kind: 'collection',
    collection: collectionIdentity(collection),
  });
  const parsed = parseSyncableSourceKey(key);
  expect(parsed.version).toBe(2);
  if (parsed.version !== 2) throw new Error('Expected current source');
  expect(sourceConfigMatchesKey(config, parsed, key)).toBe(true);
  expect(
    sourceConfigMatchesKey(
      { ...config, connectionId: 'x'.repeat(43) },
      parsed,
      key,
    ),
  ).toBe(true);
  expect(
    sourceConfigMatchesKey(
      { ...config, principal: { ...base.principal, subject: '7' } },
      parsed,
      key,
    ),
  ).toBe(false);
});
it.each([
  { ...base, principal: { kind: 'public' } },
  { ...base, principal: { ...base.principal, subject: NaN } },
  { ...base, principal: { ...base.principal, clientContext: 3 } },
  {
    ...base,
    principal: { ...base.principal, namespace: 'http://identity.example' },
  },
  { ...base, connectionId: 'bad-slot' },
  { ...base, proxyOrigin: 'https://proxy.example/path' },
  { ...base, platform: '../foreign' },
  { ...base, collection: { ...collection, query: { page: 2 } } },
])('rejects malformed or mixed saved authority %s', input => {
  expect(() => parseSyncableSourceConfig(input)).toThrow();
});
it('accepts anonymous Public configuration only without a credential binding', () => {
  const { connectionId: _, ...publicConfig } = {
    ...base,
    principal: { kind: 'public' },
  };
  expect(parseSyncableSourceConfig(publicConfig).principal).toEqual({
    kind: 'public',
  });
});
it('parses legacy arrays explicitly without operational provider assumptions', () => {
  expect(
    parseSyncableSourceKey(
      JSON.stringify([
        base.proxyOrigin,
        base.platform,
        'account',
        'old-id',
        '',
      ]),
    ),
  ).toMatchObject({
    version: 1,
    kind: 'account',
    identity: 'old-id',
    collection: '',
  });
});
it('rejects noncanonical source keys and keeps record identity typed', () => {
  const key = sourceKey({
    ...base,
    kind: 'record',
    collection: { name: 'events', resource: 'event' },
    remoteId: '7',
  });
  expect(parseSyncableSourceKey(key)).toMatchObject({ remoteId: '7' });
  expect(() =>
    parseSyncableSourceKey(
      JSON.stringify({ ...JSON.parse(key), extraneous: 'field' }),
    ),
  ).toThrow('canonical');
});
