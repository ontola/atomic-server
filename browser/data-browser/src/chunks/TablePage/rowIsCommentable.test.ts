import { describe, expect, it } from 'vitest';
import { Agent, Store, core } from '@tomic/lib';
import { rowIsCommentable } from './RowCommentButton';

describe('rowIsCommentable', () => {
  it('allows comments on a saved row', () => {
    expect(rowIsCommentable({ new: false, subject: 'atomic:saved-row' })).toBe(
      true,
    );
  });

  it('hides comments on a draft row that already has its final subject', () => {
    expect(rowIsCommentable({ new: true, subject: 'atomic:draft-row' })).toBe(
      false,
    );
  });

  it('hides comments on a legacy _new: placeholder', () => {
    expect(rowIsCommentable({ new: false, subject: '_new:abc' })).toBe(false);
  });

  it('treats a deferred-genesis draft from the store as not commentable', async () => {
    const store = new Store({
      serverUrl: 'https://example.com',
      connect: false,
    });
    store.setAgent(await Agent.generateNonExtractable());

    // How TableResource pre-mints the next row: final subject, no genesis yet.
    const draft = await store.newResource({
      isA: core.classes.class,
      parent: 'https://example.com',
      noParent: true,
      deferGenesis: true,
    });

    expect(draft.subject.startsWith('_new:')).toBe(false);
    expect(rowIsCommentable(draft)).toBe(false);
  });
});
