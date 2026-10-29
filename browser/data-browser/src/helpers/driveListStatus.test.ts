import { expect, it } from 'vitest';
import {
  AtomicError,
  ErrorType,
  NOT_AVAILABLE_LOCALLY_MESSAGE,
} from '@tomic/lib';
import { driveListStatus } from './driveListStatus';

it('distinguishes a missing local copy from server, permission and address failures', () => {
  expect(
    driveListStatus(
      new AtomicError(NOT_AVAILABLE_LOCALLY_MESSAGE, ErrorType.Transport),
    ),
  ).toBe('Not on this device yet');
  expect(
    driveListStatus(new AtomicError('fetch failed', ErrorType.Transport)),
  ).toBe('Server unavailable');
  expect(
    driveListStatus(new AtomicError('denied', ErrorType.Unauthorized)),
  ).toBe('No access with this identity');
  expect(driveListStatus(new AtomicError('missing', ErrorType.NotFound))).toBe(
    'Drive not found at this address',
  );
  expect(driveListStatus(new Error('unexpected'))).toBe(
    'Could not load this drive',
  );
  expect(driveListStatus(undefined, true)).toBe('Loading drive…');
  expect(driveListStatus()).toBeUndefined();
});
