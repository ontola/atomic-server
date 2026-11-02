import { describe, expect, it } from 'vitest';
import { personalDriveName } from './driveDisplayName';

describe('personalDriveName', () => {
  it('replaces the stored default and a missing name', () => {
    expect(personalDriveName('My drive', 'Personal drive')).toBe(
      'Personal drive',
    );
    expect(personalDriveName(undefined, 'Personal drive')).toBe(
      'Personal drive',
    );
  });

  it('keeps a name the owner chose', () => {
    expect(personalDriveName("Joep's Drive", 'Personal drive')).toBe(
      "Joep's Drive",
    );
  });
});
