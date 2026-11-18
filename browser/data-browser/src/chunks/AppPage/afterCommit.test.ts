// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import type { Store } from '@tomic/react';
import {
  fetchAfterCommit,
  pendingRows,
  stoppedTables,
  type AfterCommitSubscription,
} from './afterCommit';

function sub(
  patch: Partial<AfterCommitSubscription> = {},
): AfterCommitSubscription {
  return {
    table: 'did:ad:t',
    view: 'did:ad:v',
    app: 'did:ad:a',
    via: 'add-view',
    activatedBy: 'did:ad:agent:me',
    activatedAt: 0,
    attempts: 0,
    waiting: false,
    ...patch,
  };
}

describe('afterCommit status (#1851)', () => {
  it('counts the proposed edits waiting across tables, for the Installation page', () => {
    expect(
      pendingRows([
        sub({ pending: { rows: 3, subjects: [], inScope: true, at: 0 } }),
        sub(),
        sub({ pending: { rows: 2, subjects: [], inScope: false, at: 0 } }),
      ]),
    ).toBe(5);
    expect(pendingRows([])).toBe(0);
  });

  it('lists the tables that stopped and need a Retry', () => {
    const stopped = sub({
      table: 'did:ad:s',
      stopped: { reason: 'x', at: 0, attempts: 8 },
    });

    expect(stoppedTables([sub(), stopped])).toEqual([stopped]);
  });

  it('asks nothing when signed out', async () => {
    const store = { getAgent: () => undefined } as unknown as Store;

    expect(await fetchAfterCommit(store, { drive: 'd', app: 'a' })).toEqual({
      enabled: false,
      declares: false,
      subscriptions: [],
    });
  });
});
