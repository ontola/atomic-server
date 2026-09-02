import { beforeEach, describe, expect, it } from 'vitest';
import {
  beat,
  clearHeartbeat,
  getLockPolicy,
  setLockPolicy,
  shouldLock,
} from './deviceLock';

const AGENT = 'did:ad:agent:test';
const MINUTE = 60_000;

// These tests run in node, which has no localStorage. An in-memory stand-in
// keeps them dependency-free and fast; the module only ever uses these four.
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
} as unknown as Storage;

beforeEach(() => {
  localStorage.clear();
});

describe('lock policy', () => {
  it('defaults to never, so nothing changes for people who never opt in', () => {
    expect(getLockPolicy(AGENT)).toBe('never');
    expect(shouldLock(AGENT)).toBe(false);
  });

  it('is per agent, so one account on a shared machine does not set another’s', () => {
    setLockPolicy(AGENT, 'idle-1h');

    expect(getLockPolicy('did:ad:agent:other')).toBe('never');
  });

  it('never locks under the never policy, however old the clocks are', () => {
    const now = Date.now();
    beat(now - 30 * 24 * 60 * MINUTE);

    expect(shouldLock(AGENT, now)).toBe(false);
  });
});

describe('lock on close', () => {
  it('survives a reload: a short gap must not lock', () => {
    const now = Date.now();
    setLockPolicy(AGENT, 'close');
    beat(now - 5_000);

    expect(shouldLock(AGENT, now)).toBe(false);
  });

  it('locks once the app has not been open for a while', () => {
    const now = Date.now();
    setLockPolicy(AGENT, 'close');
    beat(now - 5 * MINUTE);

    expect(shouldLock(AGENT, now)).toBe(true);
  });

  it('locks when there is no record at all', () => {
    setLockPolicy(AGENT, 'close');
    clearHeartbeat();

    expect(shouldLock(AGENT)).toBe(true);
  });
});

describe('lock when inactive', () => {
  it('does not lock while the user is still around', () => {
    const now = Date.now();
    setLockPolicy(AGENT, 'idle-15m');
    beat(now - 5 * MINUTE);

    expect(shouldLock(AGENT, now)).toBe(false);
  });

  it('locks past its own threshold but not a longer one', () => {
    const now = Date.now();
    beat(now - 30 * MINUTE);

    setLockPolicy(AGENT, 'idle-15m');
    expect(shouldLock(AGENT, now)).toBe(true);

    setLockPolicy(AGENT, 'idle-1h');
    expect(shouldLock(AGENT, now)).toBe(false);
  });

  it('a clock that jumped backwards does not read as a long gap', () => {
    const now = Date.now();
    setLockPolicy(AGENT, 'idle-15m');
    // Timestamp in the future — e.g. the system clock was corrected.
    beat(now + 60 * MINUTE);

    expect(shouldLock(AGENT, now)).toBe(false);
  });
});
