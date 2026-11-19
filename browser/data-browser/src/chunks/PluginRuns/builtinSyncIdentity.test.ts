import { describe, expect, it } from 'vitest';
import {
  canonicalValue,
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
