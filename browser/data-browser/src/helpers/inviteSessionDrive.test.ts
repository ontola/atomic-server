import { describe, expect, it } from 'vitest';
import { inviteSessionDrive } from './inviteSessionDrive';

const PRIVATE = 'did:ad:private';
const HOST = 'did:ad:host';

describe('inviteSessionDrive', () => {
  it('keeps a child invite on the private drive even when ancestry named a host', () => {
    expect(
      inviteSessionDrive({
        privateDrive: PRIVATE,
        hostDrive: HOST,
        destinationIsDrive: false,
      }),
    ).toBe(PRIVATE);
  });

  it('lands a drive-level invite on the host', () => {
    expect(
      inviteSessionDrive({
        privateDrive: PRIVATE,
        hostDrive: HOST,
        destinationIsDrive: true,
      }),
    ).toBe(HOST);
  });

  it('falls back to the private drive if a drive invite has no host bookmark', () => {
    expect(
      inviteSessionDrive({
        privateDrive: PRIVATE,
        destinationIsDrive: true,
      }),
    ).toBe(PRIVATE);
  });

  it('is undefined when neither drive resolved', () => {
    expect(inviteSessionDrive({ destinationIsDrive: false })).toBeUndefined();
  });
});
