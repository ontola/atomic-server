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
    outbox.markDirty(SUBJECT);

    const onTerminalDrop = vi.fn();

    await outbox.drain({
      sort: e => [...e],
      drainSubject: async () => {
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

  it('a signedGenesis envelope survives drain failure and stays queued', async ({
    expect,
  }) => {
    // Under sign-at-drain the only signed envelope the outbox holds
    // is a `signedGenesis` for DID-derived subjects. If the drain
    // throws non-terminally the genesis must remain queued for the
    // next drain attempt.
    const outbox = new LocalOutbox();
    const genesis = fakeCommit(SUBJECT, 'sig-genesis');
    outbox.setGenesisCommit(SUBJECT, genesis);

    await outbox.drain({
      sort: e => [...e],
      drainSubject: async () => {
        throw new Error('Temporary network failure');
      },
    });

    expect(outbox.size).toBe(1);
    const entry = outbox.getEntry(SUBJECT) as OutboxEntry;
    expect(entry.signedGenesis?.signature).toBe('sig-genesis');
    expect(entry.lastAttemptError).toContain('Temporary network failure');
  });

  it('keeps entries queued on non-terminal error', async ({ expect }) => {
    const outbox = new LocalOutbox();
    outbox.markDirty(SUBJECT);

    const onTerminalDrop = vi.fn();

    await outbox.drain({
      sort: e => [...e],
      drainSubject: async () => {
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

  it('clearDirty removes an entry but keeps signedGenesis pending', ({
    expect,
  }) => {
    const outbox = new LocalOutbox();
    outbox.setGenesisCommit(SUBJECT, fakeCommit(SUBJECT, 'sig-genesis'));
    outbox.markDirty(SUBJECT);
    expect(outbox.size).toBe(1);

    // clearDirty on an entry with a signedGenesis keeps the entry —
    // genesis still needs to POST.
    outbox.clearDirty(SUBJECT);
    expect(outbox.size).toBe(1);
    expect(outbox.getEntry(SUBJECT)?.signedGenesis?.signature).toBe(
      'sig-genesis',
    );

    // After genesis acks, clearGenesis drops the envelope. The entry
    // then has neither a dirty bit nor a pending genesis and clears
    // on the next dirty-clear.
    outbox.clearGenesis(SUBJECT);
    outbox.clearDirty(SUBJECT);
    expect(outbox.size).toBe(0);
  });
});
