// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  addRecentResource,
  getRecentResources,
  recentResourcesKey,
  removeRecentResource,
} from './recentResources';

const AGENT = 'did:ad:agent:a';
const DRIVE = 'did:ad:drive:one';
const OTHER_DRIVE = 'did:ad:drive:two';

describe('recentResources', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('lists opened resources most recent first, without duplicates', () => {
    addRecentResource(AGENT, DRIVE, 'did:ad:resource:a');
    addRecentResource(AGENT, DRIVE, 'did:ad:resource:b');
    addRecentResource(AGENT, DRIVE, 'did:ad:resource:a');

    expect(getRecentResources(AGENT, DRIVE)).toEqual([
      'did:ad:resource:a',
      'did:ad:resource:b',
    ]);
  });

  it('keeps drives apart and leaves the drive itself out', () => {
    addRecentResource(AGENT, DRIVE, DRIVE);
    addRecentResource(AGENT, DRIVE, 'did:ad:resource:a');
    addRecentResource(AGENT, OTHER_DRIVE, 'did:ad:resource:b');

    expect(getRecentResources(AGENT, DRIVE)).toEqual(['did:ad:resource:a']);
    expect(getRecentResources(AGENT, OTHER_DRIVE)).toEqual([
      'did:ad:resource:b',
    ]);
  });

  it('caps the list', () => {
    for (let i = 0; i < 30; i++) {
      addRecentResource(AGENT, DRIVE, `did:ad:resource:${i}`);
    }

    expect(getRecentResources(AGENT, DRIVE)).toHaveLength(20);
    expect(getRecentResources(AGENT, DRIVE)[0]).toBe('did:ad:resource:29');
  });

  it('forgets a removed resource, in that drive only', () => {
    addRecentResource(AGENT, DRIVE, 'did:ad:resource:a');
    addRecentResource(AGENT, DRIVE, 'did:ad:resource:b');
    addRecentResource(AGENT, OTHER_DRIVE, 'did:ad:resource:a');

    removeRecentResource(AGENT, DRIVE, 'did:ad:resource:a');
    removeRecentResource(AGENT, DRIVE, 'did:ad:resource:unknown');

    expect(getRecentResources(AGENT, DRIVE)).toEqual(['did:ad:resource:b']);
    expect(getRecentResources(AGENT, OTHER_DRIVE)).toEqual([
      'did:ad:resource:a',
    ]);
  });

  it('survives corrupt storage', () => {
    window.localStorage.setItem(recentResourcesKey(AGENT), '[not json');

    expect(getRecentResources(AGENT, DRIVE)).toEqual([]);
    addRecentResource(AGENT, DRIVE, 'did:ad:resource:a');
    expect(getRecentResources(AGENT, DRIVE)).toEqual(['did:ad:resource:a']);
  });

  it('does not show one identity what another opened', () => {
    addRecentResource(AGENT, DRIVE, 'did:ad:resource:a');

    expect(getRecentResources('did:ad:agent:b', DRIVE)).toEqual([]);
    expect(getRecentResources(undefined, DRIVE)).toEqual([]);
  });

  it('writes nothing without an agent', () => {
    addRecentResource(undefined, DRIVE, 'did:ad:resource:a');
    removeRecentResource(undefined, DRIVE, 'did:ad:resource:a');

    expect(window.localStorage.length).toBe(0);
  });
});
