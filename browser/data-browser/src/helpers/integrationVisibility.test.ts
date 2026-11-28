import { describe, expect, it } from 'vitest';
import {
  carryOverLegacyOptIn,
  visibilityLocalKey,
} from './integrationVisibility';

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

const blocked = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
} as unknown as Storage;

describe('carrying over a legacy opt-in', () => {
  const legacyKey = 'integration-visibility:did:ad:alice';
  const target = visibilityLocalKey('did:ad:alice', 'show-api-plugins');

  it('copies an opt-in from the old per-agent cache', () => {
    const storage = fakeStorage({
      [legacyKey]:
        '{"show-api-plugins":true,"show-experimental-plugins":false}',
    });

    carryOverLegacyOptIn('did:ad:alice', 'show-api-plugins', storage);
    carryOverLegacyOptIn('did:ad:alice', 'show-experimental-plugins', storage);
    expect(storage.getItem(target)).toBe('true');
    expect(
      storage.getItem(
        visibilityLocalKey('did:ad:alice', 'show-experimental-plugins'),
      ),
    ).toBe(null);
  });

  it('leaves a value the new key already holds, and other agents', () => {
    const storage = fakeStorage({
      [legacyKey]: '{"show-api-plugins":true}',
      [target]: 'false',
    });

    carryOverLegacyOptIn('did:ad:alice', 'show-api-plugins', storage);
    carryOverLegacyOptIn('did:ad:bob', 'show-api-plugins', storage);
    expect(storage.getItem(target)).toBe('false');
    expect(
      storage.getItem(visibilityLocalKey('did:ad:bob', 'show-api-plugins')),
    ).toBe(null);
  });

  it.each(['null', '"true"', 'not json'])('ignores unusable cache %s', raw => {
    const storage = fakeStorage({ [legacyKey]: raw });

    carryOverLegacyOptIn('did:ad:alice', 'show-api-plugins', storage);
    expect(storage.getItem(target)).toBe(null);
    expect(() =>
      carryOverLegacyOptIn('did:ad:alice', 'show-api-plugins', blocked),
    ).not.toThrow();
  });
});
