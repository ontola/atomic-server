import { describe, expect, it } from 'vitest';
import {
  readPreviewUnlocked,
  writePreviewUnlocked,
} from './integrationVisibility';

describe('Atomic integration preview unlock', () => {
  it('is locked until unlocked, per agent', () => {
    const storage = fakeStorage();
    expect(readPreviewUnlocked('did:ad:alice', storage)).toBe(false);
    writePreviewUnlocked('did:ad:alice', storage);
    expect(readPreviewUnlocked('did:ad:alice', storage)).toBe(true);
    expect(readPreviewUnlocked('did:ad:bob', storage)).toBe(false);
  });

  it('survives storage that is unavailable', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(readPreviewUnlocked('did:ad:alice', blocked)).toBe(false);
    expect(() => writePreviewUnlocked('did:ad:alice', blocked)).not.toThrow();
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
