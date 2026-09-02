import { describe, expect, it } from 'vitest';
import { getMeetingPhase } from './meetingLifecycle';

describe('getMeetingPhase', () => {
  it('labels an unstarted meeting as an agenda', () => {
    expect(getMeetingPhase(undefined, undefined)).toBe('agenda');
  });

  it('labels a started meeting as notes', () => {
    expect(getMeetingPhase(1, undefined)).toBe('notes');
  });

  it('labels an ended meeting as minutes', () => {
    expect(getMeetingPhase(1, 2)).toBe('minutes');
  });
});
