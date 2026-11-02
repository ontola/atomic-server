// @wc-ignore-file
import { expect, it } from 'vitest';
import type { PresenceItem } from '@tomic/react';
import { callStrip } from './callStrip';

const item = (
  sessionId: string,
  extra: Partial<PresenceItem>,
): PresenceItem => ({
  sessionId,
  agent: `did:ad:agent:${sessionId}`,
  ...extra,
});
const meeting = 'did:ad:meeting';

it('shows who is in this meeting’s call, once per agent', () => {
  const presence = [
    item('a', { call: meeting }),
    item('a2', { agent: 'did:ad:agent:a', call: meeting }),
    item('b', { call: 'did:ad:other' }),
    item('c', { session: meeting }),
  ];

  expect(callStrip(presence, meeting, false)).toEqual({
    agents: ['did:ad:agent:a'],
    show: true,
  });
});

it('hides when nobody is in the call or this session is', () => {
  expect(callStrip([item('c', {})], meeting, false).show).toBe(false);
  expect(callStrip([item('a', { call: meeting })], meeting, true).show).toBe(
    false,
  );
});
