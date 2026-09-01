import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPushWakeReceive,
  clearPushWakeTap,
  onPushWakeReceive,
  onPushWakeTap,
  peekPushWakeReceive,
  peekPushWakeTap,
  queuePushWakeReceive,
  queuePushWakeTap,
} from './pushWakeTap';

describe('pushWakeTap queue', () => {
  afterEach(() => {
    clearPushWakeTap();
    clearPushWakeReceive();
  });

  it('queues until a listener arms', () => {
    queuePushWakeTap('did:ad:about1');
    expect(peekPushWakeTap()).toBe('did:ad:about1');

    let received: string | undefined;
    const unsub = onPushWakeTap(about => {
      received = about;
    });
    expect(received).toBe('did:ad:about1');
    expect(peekPushWakeTap()).toBeUndefined();
    unsub();
  });

  it('delivers immediately when listener already armed', () => {
    const seen: string[] = [];
    const unsub = onPushWakeTap(about => {
      seen.push(about);
    });
    queuePushWakeTap('did:ad:about2');
    expect(seen).toEqual(['did:ad:about2']);
    expect(peekPushWakeTap()).toBeUndefined();
    unsub();
  });

  it('queues silent wake receives until a listener arms', () => {
    queuePushWakeReceive({ about: 'did:ad:doc', type: 'mention' });
    expect(peekPushWakeReceive()).toEqual({
      about: 'did:ad:doc',
      type: 'mention',
    });

    let received: { about: string; type: string } | undefined;
    const unsub = onPushWakeReceive(wake => {
      received = wake;
    });
    expect(received).toEqual({ about: 'did:ad:doc', type: 'mention' });
    expect(peekPushWakeReceive()).toBeUndefined();
    unsub();
  });
});
