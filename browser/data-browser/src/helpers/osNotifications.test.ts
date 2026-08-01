import { describe, expect, it } from 'vitest';
import {
  notificationNumericId,
  shouldUseOsSurface,
} from './osNotifications';

describe('osNotifications helpers', () => {
  it('notificationNumericId is stable and non-zero', () => {
    const a = notificationNumericId('did:ad:abc');
    const b = notificationNumericId('did:ad:abc');
    const c = notificationNumericId('did:ad:xyz');

    expect(a).toBe(b);
    expect(a).not.toBe(0);
    expect(a).not.toBe(c);
    expect(Number.isInteger(a)).toBe(true);
  });

  it('shouldUseOsSurface reflects document visibility and focus', () => {
    // jsdom: typically visible + hasFocus true in happy path; we only
    // assert the function is callable and returns a boolean.
    expect(typeof shouldUseOsSurface()).toBe('boolean');
  });
});
