import { describe, expect, it } from 'vitest';
import {
  looksLikeOpenableSubject,
  parseDidOpenInput,
} from './didResolve';

const RESOURCE =
  'did:ad:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const AGENT =
  'did:ad:agent:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const NODE =
  'did:ad:node:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

describe('parseDidOpenInput', () => {
  it('parses a bare resource DID', () => {
    expect(parseDidOpenInput(RESOURCE)).toEqual({ subject: RESOURCE });
  });

  it('parses agent and node hints on the DID query string', () => {
    const input = `${RESOURCE}?agent=${AGENT}&node=${NODE}`;
    expect(parseDidOpenInput(input)).toEqual({
      subject: RESOURCE,
      agent: AGENT,
      node: NODE,
    });
  });

  it('keeps a drive hint on the subject', () => {
    const drive = RESOURCE.replace(/A/g, 'D');
    const input = `${RESOURCE}?drive=${drive}&agent=${AGENT}`;
    expect(parseDidOpenInput(input)).toEqual({
      subject: `${RESOURCE}?drive=${drive}`,
      agent: AGENT,
    });
  });

  it('parses atomic://open links', () => {
    const input = `atomic://open?subject=${encodeURIComponent(RESOURCE)}&agent=${encodeURIComponent(AGENT)}&node=${encodeURIComponent(NODE)}`;
    expect(parseDidOpenInput(input)).toEqual({
      subject: RESOURCE,
      agent: AGENT,
      node: NODE,
    });
  });

  it('rejects bare node DIDs (those are pairing codes)', () => {
    expect(parseDidOpenInput(NODE)).toBeNull();
  });

  it('looksLikeOpenableSubject accepts resource DIDs and rejects garbage', () => {
    expect(looksLikeOpenableSubject(RESOURCE)).toBe(true);
    expect(looksLikeOpenableSubject('not a did')).toBe(false);
  });
});
