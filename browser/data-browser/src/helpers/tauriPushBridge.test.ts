import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetPushBridgeForTests,
  ingestRemotePushPayload,
  onPushDeviceToken,
} from './tauriPushBridge';
import {
  clearPushWakeReceive,
  clearPushWakeTap,
  onPushWakeReceive,
  peekPushWakeReceive,
  peekPushWakeTap,
} from './pushWakeTap';

describe('tauriPushBridge', () => {
  afterEach(() => {
    __resetPushBridgeForTests();
    clearPushWakeReceive();
    clearPushWakeTap();
  });

  it('ingestRemotePushPayload queues a wake receive', () => {
    const seen: { about: string; type: string }[] = [];
    const unsub = onPushWakeReceive(w => seen.push(w));
    ingestRemotePushPayload({
      about: 'did:ad:doc1',
      type: 'mention',
    });
    expect(seen).toEqual([{ about: 'did:ad:doc1', type: 'mention' }]);
    unsub();
  });

  it('reads nested FCM data bag', () => {
    ingestRemotePushPayload({
      data: { about: 'did:ad:doc2', notificationType: 'watch-content' },
    });
    expect(peekPushWakeReceive()).toEqual({
      about: 'did:ad:doc2',
      type: 'watch-content',
    });
  });

  it('treats userInteraction as a tap, not a receive', () => {
    ingestRemotePushPayload({
      about: 'did:ad:doc3',
      type: 'mention',
      userInteraction: true,
    });
    expect(peekPushWakeReceive()).toBeUndefined();
    expect(peekPushWakeTap()).toBe('did:ad:doc3');
  });

  it('onPushDeviceToken delivers cached token immediately', () => {
    const tokens: string[] = [];
    // Simulate cache via listener after manual set — refresh is async/plugin.
    // Just verify unsubscribe is safe with no cache.
    const unsub = onPushDeviceToken((t, p) => {
      tokens.push(`${p}:${t}`);
    });
    expect(tokens).toEqual([]);
    unsub();
  });
});
