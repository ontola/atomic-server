import { describe, it, beforeEach, vi } from 'vitest';
import {
  LocalOutbox,
  isTerminalCommitErrorMessage,
  type OutboxEntry,
} from './local-outbox.js';
import type { Commit } from './commit.js';

function fakeCommit(subject: string, signature = 'fakesig=='): Commit {
  return {
    subject,
    signer: 'did:ad:agent:fake=',
    createdAt: 0,
    signature,
    isA: ['https://atomicdata.dev/classes/Commit'],
    previousCommit: undefined,
    set: { 'https://atomicdata.dev/properties/name': 'x' },
  } as unknown as Commit;
}

const SUBJECT = 'did:ad:fakeresource';

describe('isTerminalCommitErrorMessage', () => {
  it('flags genesis-collision errors', ({ expect }) => {
    expect(
      isTerminalCommitErrorMessage(
        'Commit for did:ad:abc has is_genesis: true, but the resource already exists.',
      ),
    ).toBe(true);
  });

  it("doesn't flag normal errors", ({ expect }) => {
    expect(isTerminalCommitErrorMessage('Invalid signature')).toBe(false);
    expect(isTerminalCommitErrorMessage('Network timeout')).toBe(false);
    expect(isTerminalCommitErrorMessage('')).toBe(false);
  });
});

describe('LocalOutbox.drain', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('drops entries on terminal error + calls onTerminalDrop', async ({
    expect,
  }) => {
    const outbox = new LocalOutbox();
    outbox.upsertCommit(SUBJECT, fakeCommit(SUBJECT));

    const onTerminalDrop = vi.fn();

    await outbox.drain({
      sort: e => [...e],
      postEntry: async () => {
        throw new Error(
          'Commit for did:ad:abc has is_genesis: true, but the resource already exists.',
        );
      },
      isTerminalError: (_entry, e) =>
        isTerminalCommitErrorMessage(e instanceof Error ? e.message : ''),
      onTerminalDrop,
    });

    expect(outbox.size).toBe(0);
    expect(onTerminalDrop).toHaveBeenCalledOnce();
    expect(onTerminalDrop.mock.calls[0][0].subject).toBe(SUBJECT);
  });

  it('does not drop new commits if `setEntry` replaces the queue mid-drain at the same length', async ({
    expect,
  }) => {
    // Regression: rapid typing produced 1-commit entries; if a new
    // commit arrived during `postEntry` and `setEntry` replaced the
    // queue with the new commit (still length 1, but different
    // signature), the old length-based diff deleted the entry and
    // the new commit was lost. Repros e2e
    // `quick-edit text typing ux` and `rename-regression`.
    const outbox = new LocalOutbox();
    const cA = fakeCommit(SUBJECT, 'sig-A');
    outbox.upsertCommit(SUBJECT, cA);

    await outbox.drain({
      sort: e => [...e],
      postEntry: async () => {
        // Simulate a new commit arriving while the previous post is
        // in flight — `Resource.applyToStore` calls
        // `outbox.setEntry(subject, _pendingCommits)`, REPLACING the
        // queue (not appending). The new array has the same length
        // as `live`, so the old length-based diff thought no work was
        // left to do.
        outbox.setEntry(SUBJECT, [fakeCommit(SUBJECT, 'sig-B')]);
      },
    });

    // Commit B (`sig-B`) was not in `live.commits` and must remain
    // queued for the next drain.
    expect(outbox.size).toBe(1);
    const entry = outbox.getEntry(SUBJECT) as OutboxEntry;
    expect(entry.commits.map(c => c.signature)).toEqual(['sig-B']);
  });

  it('keeps entries queued on non-terminal error', async ({ expect }) => {
    const outbox = new LocalOutbox();
    outbox.upsertCommit(SUBJECT, fakeCommit(SUBJECT));

    const onTerminalDrop = vi.fn();

    await outbox.drain({
      sort: e => [...e],
      postEntry: async () => {
        throw new Error('Temporary network failure');
      },
      isTerminalError: (_entry, e) =>
        isTerminalCommitErrorMessage(e instanceof Error ? e.message : ''),
      onTerminalDrop,
    });

    expect(outbox.size).toBe(1);
    expect(onTerminalDrop).not.toHaveBeenCalled();
    const entry = outbox.getEntry(SUBJECT) as OutboxEntry;
    expect(entry.lastAttemptError).toContain('Temporary network failure');
  });
});
