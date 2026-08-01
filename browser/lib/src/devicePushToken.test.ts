import { describe, expect, it } from 'vitest';
import {
  buildPushWakePayload,
  shouldOpenAfterPushWake,
  shouldSurfaceAfterPushSync,
  type PushPlatform,
} from './devicePushToken.js';
import { watchDedupeKey } from './mentions.js';

describe('buildPushWakePayload', () => {
  it('is wake-only (about + type, no body)', () => {
    const payload = buildPushWakePayload({
      about: 'did:ad:doc1',
      type: 'mention',
    });
    expect(payload).toEqual({ about: 'did:ad:doc1', type: 'mention' });
    expect(payload).not.toHaveProperty('body');
    expect(payload).not.toHaveProperty('summary');
  });
});

describe('shouldSurfaceAfterPushSync', () => {
  it('suppresses read or dismissed items', () => {
    expect(shouldSurfaceAfterPushSync(true, false)).toBe(false);
    expect(shouldSurfaceAfterPushSync(false, true)).toBe(false);
    expect(shouldSurfaceAfterPushSync(false, false)).toBe(true);
  });
});

describe('shouldOpenAfterPushWake', () => {
  it('opens when no item flags are set', () => {
    expect(shouldOpenAfterPushWake({})).toBe(true);
  });

  it('skips when already read', () => {
    expect(shouldOpenAfterPushWake({ itemRead: true })).toBe(false);
  });
});

describe('watchDedupeKey', () => {
  it('includes type, about, watch target, and actor', () => {
    expect(
      watchDedupeKey(
        'watch-membership',
        'did:ad:row1',
        'did:ad:table1',
        'did:ad:agent:bob',
      ),
    ).toBe('watch-membership|did:ad:row1|did:ad:table1|did:ad:agent:bob');
  });
});

describe('PushPlatform', () => {
  it('accepts known platforms', () => {
    const platforms: PushPlatform[] = ['ios', 'android', 'web', 'desktop'];
    expect(platforms).toHaveLength(4);
  });
});
