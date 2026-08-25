import { describe, expect, it } from 'vitest';
import { isPrivateDrive } from './isPrivateDrive';

const HOME = 'did:ad:home';

/**
 * Everything that holds the private drive apart — the locked title, the badge,
 * the sharing warning — asks this one question. The answer while the personal
 * drive is still being resolved matters as much as the answer afterwards: a
 * warning that flashes onto an ordinary drive teaches people to ignore it.
 */
describe('isPrivateDrive', () => {
  it('is true for the drive that is the agent\u2019s home', () => {
    expect(isPrivateDrive(HOME, HOME, false)).toBe(true);
  });

  it('is false for any other drive', () => {
    expect(isPrivateDrive('did:ad:work', HOME, false)).toBe(false);
  });

  it('says no while the answer is still unknown', () => {
    expect(isPrivateDrive(HOME, HOME, true)).toBe(false);
  });

  it('says no when signed out', () => {
    expect(isPrivateDrive(HOME, undefined, false)).toBe(false);
  });

  it('says no when there is no subject to judge', () => {
    expect(isPrivateDrive(undefined, HOME, false)).toBe(false);
  });
});
