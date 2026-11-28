import { describe, expect, it } from 'vitest';
import {
  canonicalValue,
  entitySourceKey,
  entityTableKey,
  ruleSourceKey,
  collectionIdentity,
  sourceKey,
  sourceConfigFingerprint,
} from './builtinSyncIdentity.js';

const base = {
  proxyOrigin: 'https://proxy.example',
  platform: 'a-platform',
  kind: 'principal',
  principal: {
    kind: 'authenticated' as const,
    namespace: 'https://identity.example',
    subject: 7,
  },
};

describe('durable catalog source identities', () => {
  it('bounds deep collection and record keys without embedding ancestor JSON', () => {
    let parent = sourceKey(base);
    const seen = new Set([parent]);

    for (let depth = 0; depth < 16; depth++) {
      for (const kind of ['collection', 'record']) {
        const key = sourceKey({
          ...base,
          kind,
          collection: { name: 'children', resource: 'child' },
          parentSourceKey: parent,
          ...(kind === 'record' ? { remoteId: depth } : {}),
        });
        expect(key.length).toBeLessThan(600);
        const parsed = JSON.parse(key);
        expect(parsed.parentSourceKey).toBeUndefined();
        expect(parsed.parentSourceKeyHash).toBe(
          sourceConfigFingerprint(parent),
        );
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        parent = key;
      }
    }
  });

  it('round trips a canonical prehashed parent and isolates typed parent identities', () => {
    const numeric = sourceKey(base);
    const textual = sourceKey({
      ...base,
      principal: { ...base.principal, subject: '7' },
    });
    const first = sourceKey({
      ...base,
      kind: 'record',
      parentSourceKey: numeric,
      remoteId: 7,
    });
    expect(sourceKey(JSON.parse(first))).toBe(first);
    expect(first).not.toBe(
      sourceKey({
        ...base,
        kind: 'record',
        parentSourceKey: textual,
        remoteId: 7,
      }),
    );
    expect(first).not.toBe(
      sourceKey({
        ...base,
        kind: 'record',
        parentSourceKey: numeric,
        remoteId: '7',
      }),
    );
  });

  it('rejects oversized source identities before any bridge query', () => {
    expect(() =>
      sourceKey({
        ...base,
        principal: { ...base.principal, subject: 'x'.repeat(2000) },
      }),
    ).toThrow('2000 character query limit');
  });

  it('rejects invalid or competing parent identity inputs', () => {
    expect(() =>
      sourceKey({
        ...base,
        parentSourceKey: 'parent',
        parentSourceKeyHash: 'a'.repeat(64),
      }),
    ).toThrow('not both');
    expect(() =>
      sourceKey({ ...base, parentSourceKeyHash: 'not-a-digest' }),
    ).toThrow('64 lowercase hexadecimal');
    expect(() => sourceKey({ ...base, parentSourceKey: '' })).toThrow(
      'nonempty text',
    );
  });
  it('fingerprints canonical saved configuration while preserving JSON types', () => {
    expect(sourceConfigFingerprint({ z: 7, a: 'value' })).toBe(
      sourceConfigFingerprint({ a: 'value', z: 7 }),
    );
    expect(sourceConfigFingerprint({ id: 7 })).not.toBe(
      sourceConfigFingerprint({ id: '7' }),
    );
    expect(sourceConfigFingerprint({ id: 7 })).toMatch(/^[a-f0-9]{64}$/);
  });
  it('retains JSON subject and record identity types', () => {
    expect(sourceKey(base)).not.toBe(
      sourceKey({ ...base, principal: { ...base.principal, subject: '7' } }),
    );
    expect(sourceKey({ ...base, remoteId: 7 })).not.toBe(
      sourceKey({ ...base, remoteId: '7' }),
    );
    expect(sourceKey(base)).not.toBe(
      sourceKey({ ...base, principal: { kind: 'public' } }),
    );
  });
  it('isolates provider, client-scoped, collection instance and parent identities', () => {
    const key = sourceKey(base);
    for (const change of [
      { platform: 'another' },
      { proxyOrigin: 'https://another.example' },
      {
        principal: { ...base.principal, namespace: 'https://another.example' },
      },
      { principal: { ...base.principal, clientContext: 'oauth-client-2' } },
      { parentSourceKey: 'parent-2' },
      { collection: { name: 'another' } },
    ])
      expect(sourceKey({ ...base, ...change })).not.toBe(key);
  });
  it('canonicalizes object order and omits undefined values without changing arrays', () => {
    expect(
      canonicalValue({ z: undefined, b: [2, 1], a: { z: 1, a: 2 } }),
    ).toEqual({ a: { a: 2, z: 1 }, b: [2, 1] });
    expect(
      sourceKey({
        ...base,
        collection: { name: 'items', context: { b: '2', a: '1' } },
      }),
    ).toBe(
      sourceKey({
        ...base,
        collection: { context: { a: '1', b: '2' }, name: 'items' },
      }),
    );
  });
  it('does not include mutable navigation addresses in a child identity', () => {
    const navigation = {
      collection: 'items',
      resource: 'item',
      reference: 'address',
      link: 'items',
    };
    expect(collectionIdentity(undefined, navigation)).toEqual({
      name: 'items',
      resource: 'item',
      reference: 'address',
      link: 'items',
    });
  });
  it('keeps a named root collection stable when transport defaults change', () => {
    const first = {
      collection: 'items',
      resource: 'item',
      pathParams: { workspace_id: '7' },
      method: 'GET',
      query: { limit: '10' },
      body: {},
    };
    const changed = { ...first, method: 'POST', query: { limit: '100' } };
    expect(collectionIdentity(first)).toEqual(collectionIdentity(changed));
  });
  it.each([
    undefined,
    {},
    { namespace: 'x', subject: '' },
    { namespace: 'x', subject: 1.5 },
  ])('rejects absent or unsafe identity %j', principal => {
    expect(() =>
      sourceKey({ ...base, principal: principal as typeof base.principal }),
    ).toThrow('durable principal');
  });
});

describe('flat canonical entity identities', () => {
  const identity = {
    resource: 'repository',
    template: '/repositories/{id}',
    values: [['id', 7]] as [string, string | number][],
    path: '/repositories/7',
    key: '["repository",[["id",7]]]',
  };
  it('shares a resource table and entity across collection roots and navigation paths', () => {
    const table = entityTableKey({ ...base, resource: 'repository' });
    expect(sourceKey(JSON.parse(table))).toBe(table);
    const key = entitySourceKey({ ...base, entityIdentity: identity });
    expect(sourceKey(JSON.parse(key))).toBe(key);
    expect(
      entitySourceKey({
        ...base,
        entityIdentity: { ...identity, path: '/renamed-address/7' },
      }),
    ).toBe(key);
    expect(JSON.parse(key)).not.toHaveProperty('parentSourceKeyHash');
    expect(JSON.parse(key)).not.toHaveProperty('collection');
  });
  it('retains required context, typed identities and principal isolation in bounded keys', () => {
    const key = entitySourceKey({ ...base, entityIdentity: identity });
    for (const change of [
      { entityIdentity: { ...identity, key: '["repository",[["id","7"]]]' } },
      {
        entityIdentity: {
          ...identity,
          key: '["repository",[["workspace",8],["id",7]]]',
        },
      },
      { principal: { kind: 'public' as const } },
      { principal: { ...base.principal, subject: '7' } },
    ])
      expect(
        entitySourceKey({ ...base, entityIdentity: identity, ...change }),
      ).not.toBe(key);
    expect(key.length).toBeLessThan(600);
  });
  it('bounds saved rule keys while preserving distinct table and filter identities', () => {
    const first = ruleSourceKey('table-key', 'x'.repeat(10000));
    expect(first.length).toBeLessThan(300);
    expect(first).toBe(ruleSourceKey('table-key', 'x'.repeat(10000)));
    expect(first).not.toBe(ruleSourceKey('another-table', 'x'.repeat(10000)));
    expect(first).not.toBe(ruleSourceKey('table-key', 'another-rule'));
  });

  it('rejects path-dependent v3 inputs and malformed entity hashes', () => {
    expect(() =>
      sourceKey({
        ...base,
        version: 3,
        kind: 'record',
        resource: 'repository',
        entityIdentityHash: 'bad',
      }),
    ).toThrow('canonical entity');
    expect(() =>
      sourceKey({
        ...base,
        version: 3,
        kind: 'collection',
        resource: 'repository',
        parentSourceKey: 'parent',
      }),
    ).toThrow('canonical entity');
  });
});
