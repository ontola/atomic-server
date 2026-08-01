import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPushWakeTap,
  onPushWakeTap,
  peekPushWakeTap,
  queuePushWakeTap,
} from './pushWakeTap';

describe('pushWakeTap queue', () => {
  afterEach(() => {
    clearPushWakeTap();
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
});
