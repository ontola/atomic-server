import { describe, expect, it } from 'vitest';
import {
  integrationVisibility,
  integrationVisibilitySchema,
  readPendingVisibility,
  readVisibilityCache,
  writePendingVisibility,
  writeVisibilityCache,
} from './integrationVisibility';

const properties = {
  'show-api-plugins': 'did:ad:api-preference',
  'show-experimental-plugins': 'did:ad:experimental-preference',
};

describe('Atomic integration visibility preferences', () => {
  it('defaults to hidden before schema hydration without writing defaults', () => {
    expect(integrationVisibility({ get: () => true })).toEqual({
      showApiPlugins: false,
      showExperimentalPlugins: false,
    });
  });

  it.each([undefined, false, 'true', 1, null])(
    'does not opt in for %s',
    value => {
      expect(integrationVisibility({ get: () => value }, properties)).toEqual({
        showApiPlugins: false,
        showExperimentalPlugins: false,
      });
    },
  );

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('keeps API=%s and experimental=%s independent', (api, experimental) => {
    const values = {
      [properties['show-api-plugins']]: api,
      [properties['show-experimental-plugins']]: experimental,
    };
    expect(
      integrationVisibility({ get: key => values[key] }, properties),
    ).toEqual({
      showApiPlugins: api,
      showExperimentalPlugins: experimental,
    });
  });

  it('defines both preferences as Atomic boolean properties', () => {
    expect(
      integrationVisibilitySchema().properties.map(p => [
        p.shortname,
        p.datatype,
      ]),
    ).toEqual([
      ['show-api-plugins', 'https://atomicdata.dev/datatypes/boolean'],
      ['show-experimental-plugins', 'https://atomicdata.dev/datatypes/boolean'],
    ]);
  });
});

describe('Atomic integration visibility pending writes', () => {
  it('keeps unsaved toggles apart from the cache, per agent', () => {
    const storage = fakeStorage();
    writePendingVisibility(
      'did:ad:alice',
      { 'show-experimental-plugins': true },
      storage,
    );
    expect(readPendingVisibility('did:ad:alice', storage)).toEqual({
      'show-experimental-plugins': true,
    });
    expect(readVisibilityCache('did:ad:alice', storage)).toEqual({});
    expect(readPendingVisibility('did:ad:bob', storage)).toEqual({});
  });

  it('clears once nothing is pending', () => {
    const storage = fakeStorage();
    writePendingVisibility(
      'did:ad:alice',
      { 'show-api-plugins': true },
      storage,
    );
    writePendingVisibility('did:ad:alice', {}, storage);
    expect(readPendingVisibility('did:ad:alice', storage)).toEqual({});
    expect(storage.getItem('integration-visibility-pending:did:ad:alice')).toBe(
      null,
    );
  });
});

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const items = new Map(Object.entries(initial));

  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
    key: (index: number) => [...items.keys()][index] ?? null,
    get length() {
      return items.size;
    },
  } as Storage;
}

describe('Atomic integration visibility cache', () => {
  it('reads back what it wrote for an agent', () => {
    const storage = fakeStorage();
    writeVisibilityCache('did:ad:alice', { 'show-api-plugins': true }, storage);
    expect(readVisibilityCache('did:ad:alice', storage)).toEqual({
      'show-api-plugins': true,
    });
  });

  it('keeps agents apart', () => {
    const storage = fakeStorage();
    writeVisibilityCache('did:ad:alice', { 'show-api-plugins': true }, storage);
    expect(readVisibilityCache('did:ad:bob', storage)).toEqual({});
  });

  it('merges without dropping the other preference', () => {
    const storage = fakeStorage();
    writeVisibilityCache('did:ad:alice', { 'show-api-plugins': true }, storage);
    expect(
      writeVisibilityCache(
        'did:ad:alice',
        { 'show-experimental-plugins': false },
        storage,
      ),
    ).toEqual({
      'show-api-plugins': true,
      'show-experimental-plugins': false,
    });
  });

  it.each(['null', '"true"', '{"show-api-plugins":"true"}', 'not json'])(
    'ignores unusable cached value %s',
    raw => {
      const storage = fakeStorage({
        'integration-visibility:did:ad:alice': raw,
      });
      expect(readVisibilityCache('did:ad:alice', storage)).toEqual({});
    },
  );

  it('survives storage that is unavailable', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(readVisibilityCache('did:ad:alice', blocked)).toEqual({});
    expect(() =>
      writeVisibilityCache(
        'did:ad:alice',
        { 'show-api-plugins': true },
        blocked,
      ),
    ).not.toThrow();
  });
});
