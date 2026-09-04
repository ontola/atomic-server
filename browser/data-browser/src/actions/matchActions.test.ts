import { describe, expect, it } from 'vitest';
import { matchActionsForPalette, PALETTE_ACTION_CAP } from './matchActions';
import { resourceActions } from './resourceActions';
import type { ActionContext, ActionDefinition } from './types';

const ctx = {
  canWrite: true,
  pathname: '/app/show',
  isFavorite: false,
  resource: {
    isFork: false,
    title: 'Test',
    get: (prop: string) =>
      typeof prop === 'string' && prop.endsWith('/parent')
        ? 'did:ad:parent'
        : undefined,
    getClasses: () => [],
  },
} as unknown as ActionContext;

function def(
  partial: Partial<ActionDefinition> & { id: string },
): ActionDefinition {
  return {
    scope: 'resource',
    section: 'action',
    label: () => partial.id,
    helper: () => partial.id,
    run: () => undefined,
    ...partial,
  };
}

describe('matchActionsForPalette', () => {
  it('hides the section for an empty or one-letter query', () => {
    expect(matchActionsForPalette('', resourceActions, ctx)).toEqual([]);
    expect(matchActionsForPalette('d', resourceActions, ctx)).toEqual([]);
  });

  it('matches a prefix of the action id or a keyword, not a mid-word substring', () => {
    const ids = matchActionsForPalette('del', resourceActions, ctx).map(
      action => action.id,
    );

    expect(ids).toContain('delete');
    expect(ids).not.toContain('edit');

    // "ete" is inside "delete" but is not a prefix of the vocabulary.
    expect(
      matchActionsForPalette('ete', resourceActions, ctx).map(a => a.id),
    ).not.toContain('delete');
  });

  it('matches label words so "parent" finds "Go to parent"', () => {
    const ids = matchActionsForPalette('parent', resourceActions, ctx).map(
      action => action.id,
    );

    expect(ids).toContain('parent');
  });

  it('does not fire on ordinary resource-name queries', () => {
    expect(
      matchActionsForPalette('avocado', resourceActions, ctx),
    ).toHaveLength(0);
    expect(
      matchActionsForPalette('Searchable-Folder', resourceActions, ctx),
    ).toHaveLength(0);
    expect(
      matchActionsForPalette('tag:work', resourceActions, ctx),
    ).toHaveLength(0);
  });

  it('caps the section and prefers exact / shorter remainder', () => {
    const actions = [
      def({ id: 'edit', keywords: ['change'] }),
      def({ id: 'editAsFork', label: () => 'Edit as fork' }),
      def({ id: 'editorial', keywords: ['edit'] }),
      def({ id: 'history' }),
    ];

    const ids = matchActionsForPalette('edit', actions, ctx).map(a => a.id);

    expect(ids[0]).toBe('edit');
    expect(ids.length).toBeLessThanOrEqual(PALETTE_ACTION_CAP);
  });

  it('hides unavailable and disabled actions', () => {
    const actions = [
      def({ id: 'delete', available: () => false }),
      def({ id: 'history', disabled: () => true }),
      def({ id: 'share' }),
    ];

    expect(matchActionsForPalette('de', actions, ctx).map(a => a.id)).toEqual(
      [],
    );
    expect(matchActionsForPalette('hi', actions, ctx).map(a => a.id)).toEqual(
      [],
    );
    expect(matchActionsForPalette('sh', actions, ctx).map(a => a.id)).toEqual([
      'share',
    ]);
  });

  it('respects canWrite on the real delete action', () => {
    const readOnly = { ...ctx, canWrite: false };

    expect(
      matchActionsForPalette('delete', resourceActions, readOnly).map(
        a => a.id,
      ),
    ).not.toContain('delete');
    expect(
      matchActionsForPalette('delete', resourceActions, ctx).map(a => a.id),
    ).toContain('delete');
  });
});
