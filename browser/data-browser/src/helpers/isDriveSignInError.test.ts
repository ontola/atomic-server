import { describe, it, expect } from 'vitest';
import { AtomicError, ErrorType, type Agent, type Resource } from '@tomic/react';
import { isDriveSignInError } from './isDriveSignInError';

const BASE = 'https://example.com';
const DRIVE = 'https://example.com/drive/x';
const unauthorized = new AtomicError('Unauthorized', ErrorType.Unauthorized);
const notFound = new AtomicError('not here', ErrorType.NotFound);

const res = (subject: string, error?: Error): Resource =>
  ({ subject, error }) as unknown as Resource;
const someAgent = {} as Agent;

describe('isDriveSignInError', () => {
  it('not signed in + unauthorized + a (non-home) drive → guard', () => {
    expect(isDriveSignInError(res(DRIVE, unauthorized), undefined, BASE)).toBe(
      true,
    );
  });

  it('already signed in → no guard (open the drive directly)', () => {
    expect(isDriveSignInError(res(DRIVE, unauthorized), someAgent, BASE)).toBe(
      false,
    );
  });

  it('the server home → handled by the welcome gate, not this guard', () => {
    expect(isDriveSignInError(res(BASE, unauthorized), undefined, BASE)).toBe(
      false,
    );
  });

  it('a non-unauthorized error (e.g. not found) → no guard', () => {
    expect(isDriveSignInError(res(DRIVE, notFound), undefined, BASE)).toBe(
      false,
    );
  });

  it('no error at all → no guard', () => {
    expect(isDriveSignInError(res(DRIVE), undefined, BASE)).toBe(false);
  });
});
