import { describe, expect, it, vi } from 'vitest';
import {
  buildPushWakePayload,
  handlePushWake,
  shouldOpenAfterPushWake,
  shouldSurfaceAfterPushSync,
  visiblePushCopy,
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

describe('visiblePushCopy', () => {
  it('stays generic and never echoes the about subject', () => {
    const copy = visiblePushCopy('mention');
    expect(copy.title).toBe('Atomic');
    expect(copy.body).toBe('Someone mentioned you');
    expect(visiblePushCopy('message').body).toBe('You have a new message');
    expect(visiblePushCopy('access-request').body).toBe(
      'Someone requested access',
    );
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

describe('handlePushWake', () => {
  it('surfaces when no item exists yet', async () => {
    const fetchResourceFromServer = vi.fn(async () => undefined);
    const result = await handlePushWake({
      store: { fetchResourceFromServer } as never,
      about: 'did:ad:doc1',
      type: 'mention',
      reconcile: async () => undefined,
      findItemForAbout: async () => undefined,
    });
    expect(result).toEqual({
      action: 'surface',
      about: 'did:ad:doc1',
      type: 'mention',
      itemSubject: undefined,
      summary: undefined,
    });
    expect(fetchResourceFromServer).toHaveBeenCalledWith('did:ad:doc1');
  });

  it('suppresses when item is already read', async () => {
    const result = await handlePushWake({
      store: { fetchResourceFromServer: async () => undefined } as never,
      about: 'did:ad:doc1',
      type: 'mention',
      reconcile: async () => undefined,
      findItemForAbout: async () => ({
        subject: 'did:ad:item1',
        read: true,
        dismissed: false,
      }),
    });
    expect(result).toEqual({ action: 'suppress', reason: 'read' });
  });

  it('surfaces unread item with summary', async () => {
    const result = await handlePushWake({
      store: { fetchResourceFromServer: async () => undefined } as never,
      about: 'did:ad:doc1',
      type: 'mention',
      reconcile: async () => undefined,
      findItemForAbout: async () => ({
        subject: 'did:ad:item1',
        read: false,
        dismissed: false,
        summary: 'Mentioned you',
      }),
    });
    expect(result).toEqual({
      action: 'surface',
      about: 'did:ad:doc1',
      type: 'mention',
      itemSubject: 'did:ad:item1',
      summary: 'Mentioned you',
    });
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
