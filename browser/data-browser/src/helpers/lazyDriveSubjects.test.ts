import { describe, expect, it } from 'vitest';
import { lazyDriveSubjects } from './lazyDriveSubjects';

const subjects = [
  'https://staging.atomicdata.dev/drive/a',
  'did:ad:local',
  'did:ad:loaded',
];
const opts = {
  isLocal: (s: string) => s === 'did:ad:local',
  isLoaded: (s: string) => s === 'did:ad:loaded',
};

describe('lazyDriveSubjects', () => {
  it('does not fetch remote legacy drives while closed', () => {
    expect(lazyDriveSubjects(subjects, { ...opts, opened: false })).toEqual([
      'did:ad:local',
      'did:ad:loaded',
    ]);
  });

  it('allows every drive once opened', () => {
    expect(lazyDriveSubjects(subjects, { ...opts, opened: true })).toEqual(
      subjects,
    );
  });
});
