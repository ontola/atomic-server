import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  isBenignTerminalCommitError,
  isTerminalCommitError,
  isUnrecoverableCommitError,
  isNotEnrolledRefusal,
  isMissingParentRefusal,
  isPendingDepsRefusal,
  isSettledDestroyRefusal,
} from './local-outbox.js';
import { ErrorCode } from './ws-v2.js';

interface Row {
  name: string;
  code: number;
  disposition: 'retry' | 'park' | 'drop';
  benign?: boolean;
  snapshot?: boolean;
  settlesDestroy?: boolean;
}

// Shared with lib/src/sync/outbox.rs: the two outboxes cannot disagree.
const rows = (
  JSON.parse(
    readFileSync(
      new URL(
        '../../../lib/tests/fixtures/commit-refusals.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { codes: Row[] }
).codes;

describe('commit refusal codes (shared fixture)', () => {
  it('ErrorCode lists exactly the fixture codes', () => {
    expect(Object.entries(ErrorCode).sort((a, b) => a[1] - b[1])).toEqual(
      rows.map(r => [r.name, r.code]),
    );
  });

  it.each(rows)('$name is decided on its code, not its wording', row => {
    const message = 'wording that matches nothing';

    expect(isTerminalCommitError(message, row.code)).toBe(
      row.disposition === 'drop',
    );
    expect(isUnrecoverableCommitError(message, row.code)).toBe(
      row.disposition === 'park',
    );
    expect(isBenignTerminalCommitError(message, row.code)).toBe(!!row.benign);
    expect(isPendingDepsRefusal(message, row.code)).toBe(!!row.snapshot);
    expect(isSettledDestroyRefusal(message, row.code)).toBe(
      !!row.settlesDestroy,
    );
    // Not-enrolled has no code of its own: it is SYNC_REJECTED plus its text.
    expect(isNotEnrolledRefusal(message, row.code)).toBe(false);
    expect(isMissingParentRefusal(message, row.code)).toBe(
      row.name === 'MISSING_PARENT',
    );
  });

  it('INVALID_SIGNATURE parks, as the Rust outbox does', () => {
    expect(isUnrecoverableCommitError('x', ErrorCode.INVALID_SIGNATURE)).toBe(
      true,
    );
  });
});

describe('servers that predate the codes', () => {
  it.each([
    ['is_genesis: true, but the resource already exists.', 'drop'],
    ['Commits cannot be edited.', 'drop'],
    ['Property p missing. Is required in class c ', 'drop'],
    ['No https://atomicdata.dev/properties/write right has been found', 'park'],
    ['Failed getting class x. nope', 'park'],
    ['Parent of x (y) not found: z', 'park'],
    ['Drive d is not enrolled for sync on this node.', 'park'],
    ['Incorrect signature for Commit.', 'park'],
  ])('%s is %s on the text alone', (message, disposition) => {
    expect(isTerminalCommitError(message)).toBe(disposition === 'drop');
    expect(isUnrecoverableCommitError(message)).toBe(disposition === 'park');
  });

  it('an old server answers not-enrolled with SYNC_REJECTED', () => {
    expect(
      isNotEnrolledRefusal(
        'Drive d is not enrolled for sync on this node.',
        ErrorCode.SYNC_REJECTED,
      ),
    ).toBe(true);
  });
});
