import { expect, it } from 'vitest';
import {
  canonicalValue,
  collectionIdentity,
  sourceKey,
  sourceConfigFingerprint,
  entitySourceKey,
  entityTableKey,
} from './builtinSyncIdentity.js';
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

it('uses one resource table and typed entity identity independently of read paths and credential slots', () => {
  const entityIdentity = {
    resource: 'event',
    template: '/events/{id}',
    values: [['id', 7]] as [string, string | number][],
    path: '/events/7',
    key: '["event",[["id",7]]]',
  };
  const table = {
    ...base,
    version: 3 as const,
    kind: 'collection' as const,
    resource: 'event',
  };
  const key = entityTableKey(table);
  const parsed = parseSyncableSourceKey(key);
  expect(parsed).toMatchObject({ version: 3, resource: 'event' });
  if (parsed.version !== 3) throw new Error('Expected flat source');
  expect(
    sourceConfigMatchesKey(parseSyncableSourceConfig(table), parsed, key),
  ).toBe(true);
  expect(
    sourceConfigMatchesKey(
      parseSyncableSourceConfig({ ...table, connectionId: 'x'.repeat(43) }),
      parsed,
      key,
    ),
  ).toBe(true);
  const { connectionId: _slot, ...rowBase } = table;
  const row = {
    ...rowBase,
    kind: 'record' as const,
    entityIdentity,
    record: { id: 7 },
    context: {},
  };
  const rowKey = entitySourceKey({ ...row, entityIdentity });
  const rowParsed = parseSyncableSourceKey(rowKey);
  if (rowParsed.version !== 3) throw new Error('Expected flat source');
  expect(
    sourceConfigMatchesKey(parseSyncableSourceConfig(row), rowParsed, rowKey),
  ).toBe(true);
  expect(
    sourceConfigMatchesKey(
      {
        ...row,
        entityIdentity: { ...entityIdentity, key: '["event",[["id","7"]]]' },
      },
      rowParsed,
      rowKey,
    ),
  ).toBe(false);
  expect(() => parseSyncableSourceConfig({ ...row, collection })).toThrow(
    'flat',
  );
  expect(() =>
    parseSyncableSourceKey(
      JSON.stringify({
        ...JSON.parse(rowKey),
        parentSourceKeyHash: 'a'.repeat(64),
      }),
    ),
  ).toThrow();
});

it('requires an operational authenticated table slot and rejects forged flat identities', () => {
  const { connectionId: _slot, ...withoutSlot } = base;
  expect(() =>
    parseSyncableSourceConfig({
      ...withoutSlot,
      version: 3,
      kind: 'collection',
      resource: 'event',
    }),
  ).toThrow('connection');
  expect(
    parseSyncableSourceConfig({
      ...withoutSlot,
      version: 3,
      kind: 'collection',
      resource: 'event',
      principal: { kind: 'public' },
    }),
  ).toMatchObject({ version: 3 });
  expect(() =>
    parseSyncableSourceConfig({
      ...base,
      version: 3,
      kind: 'record',
      resource: 'event',
      record: {},
      entityIdentity: {
        resource: 'other',
        template: '/events/{id}',
        values: [['id', 7]],
        path: '/events/7',
        key: 'identity',
      },
    }),
  ).toThrow('different resource');
  expect(() =>
    parseSyncableSourceConfig({
      ...base,
      version: 3,
      kind: 'record',
      resource: 'event',
      record: {},
      entityIdentity: {
        resource: 'event',
        template: '/events/{id}',
        values: [
          ['id', 7],
          ['id', '7'],
        ],
        path: '/events/7',
        key: 'identity',
      },
    }),
  ).toThrow('canonical');
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

it('verifies compact parent digests against the complete saved provenance key', () => {
  const parent = sourceKey({
    ...base,
    kind: 'collection',
    collection: collectionIdentity(collection),
  });
  const config = parseSyncableSourceConfig({
    ...base,
    parentSourceKey: parent,
    resource: 'event',
    record: { id: 7 },
  });
  if (config.version !== 2)
    throw new Error('Expected historical configuration');
  const raw = sourceKey({
    ...config,
    kind: 'record',
    collection: { name: 'events', resource: 'event' },
    remoteId: 7,
  });
  const parsed = parseSyncableSourceKey(raw);
  if (parsed.version !== 2) throw new Error('Expected current source');
  expect(parsed).not.toHaveProperty('parentSourceKey');
  expect(parsed.parentSourceKeyHash).toBe(sourceConfigFingerprint(parent));
  expect(sourceConfigMatchesKey(config, parsed, raw)).toBe(true);
  expect(
    sourceConfigMatchesKey(
      { ...config, parentSourceKey: parent + 'changed' },
      parsed,
      raw,
    ),
  ).toBe(false);
});
it.each(['a'.repeat(63), 'A'.repeat(64), 'z'.repeat(64), 7])(
  'rejects malformed saved parent digests %s',
  hash => {
    const { connectionId: _slot, ...identity } = base;
    expect(() =>
      parseSyncableSourceKey(
        JSON.stringify(
          canonicalValue({
            ...identity,
            kind: 'record',
            collection: { name: 'events', resource: 'event' },
            remoteId: 7,
            parentSourceKeyHash: hash,
          }),
        ),
      ),
    ).toThrow();
  },
);
it('rejects an expanded parent in a current compact identity', () => {
  const { connectionId: _slot, ...identity } = base;
  expect(() =>
    parseSyncableSourceKey(
      JSON.stringify(
        canonicalValue({
          ...identity,
          kind: 'record',
          parentSourceKey: 'expanded-parent',
          collection: { name: 'events', resource: 'event' },
          remoteId: 7,
        }),
      ),
    ),
  ).toThrow();
});
