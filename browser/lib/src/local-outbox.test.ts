import { describe, it, beforeEach, vi } from 'vitest';
import {
  LocalOutbox,
  isTerminalCommitErrorMessage,
  type OutboxEntry,
} from './local-outbox.js';
import type { Commit } from './commit.js';

function fakeCommit(subject: string): Commit {
  return {
    subject,
    signer: 'did:ad:agent:fake=',
    createdAt: 0,
    signature: 'fakesig==',
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
