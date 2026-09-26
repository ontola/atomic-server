import { setupError } from './setupError';
import { expect, it } from 'vitest';
import { listAppSetups, getAppSetup } from './registry';

it('redacts credential values from reported host errors', () => {
  expect(
    setupError(new Error('Failed using my-token then my-token'), 'my-token'),
  ).toBe('Failed using [redacted] then [redacted]');
});

it('has no registered setup actions', () => {
  expect(listAppSetups()).toEqual([]);
  expect(() => getAppSetup('untrusted-source')).toThrow();
});
