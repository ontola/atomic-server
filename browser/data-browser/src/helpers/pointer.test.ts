import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTouchPrimary } from './pointer';

afterEach(() => vi.unstubAllGlobals());

const stubPointer = (coarse: boolean) =>
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({
      matches: query === '(pointer: coarse)' ? coarse : false,
    }),
  });

describe('isTouchPrimary', () => {
  it('is true when the primary pointer is coarse', () => {
    stubPointer(true);
    expect(isTouchPrimary()).toBe(true);
  });

  it('is false on a mouse or trackpad', () => {
    stubPointer(false);
    expect(isTouchPrimary()).toBe(false);
  });

  it('is false where matchMedia is missing', () => {
    vi.stubGlobal('window', {});
    expect(isTouchPrimary()).toBe(false);
  });
});
