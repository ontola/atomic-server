import { describe, it, expect, afterEach } from 'vitest';
import { getHomeDrive } from './homeDrive';

type WindowWithHomeDrive = { __ATOMIC_HOME_DRIVE__?: unknown };

const set = (value: unknown) => {
  (globalThis as unknown as WindowWithHomeDrive).__ATOMIC_HOME_DRIVE__ = value;
};

afterEach(() => {
  delete (globalThis as unknown as WindowWithHomeDrive).__ATOMIC_HOME_DRIVE__;
});

describe('getHomeDrive', () => {
  it('is undefined when the server declares nothing', () => {
    // The default for every install: `/` keeps the welcome / sign-in flow.
    expect(getHomeDrive()).toBe(undefined);
  });

  it('reads the subject the server injected', () => {
    set('did:ad:drive:abc123');
    expect(getHomeDrive()).toBe('did:ad:drive:abc123');
  });

  it('supports a root Drive subject', () => {
    set('internal:/');
    expect(getHomeDrive()).toBe('internal:/');
  });

  it('treats blank values as unset', () => {
    // `ATOMIC_HOME_DRIVE=""` must not route `/` to an empty subject.
    set('   ');
    expect(getHomeDrive()).toBe(undefined);
    set('');
    expect(getHomeDrive()).toBe(undefined);
  });

  it('ignores non-string values', () => {
    set(42);
    expect(getHomeDrive()).toBe(undefined);
    set(null);
    expect(getHomeDrive()).toBe(undefined);
  });

  it('trims surrounding whitespace', () => {
    set('  internal:/  ');
    expect(getHomeDrive()).toBe('internal:/');
  });
});
