import { describe, expect, it, vi } from 'vitest';
import { actionToolNames, executeDerivedAction } from './deriveTools';
import { resourceActions } from './resourceActions';
import type { ActionContext, ActionDefinition } from './types';

const ctx = {
  canWrite: true,
  pathname: '/app/show',
  isFavorite: false,
  subject: 'did:ad:example',
} as ActionContext;

describe('deriveActionTools', () => {
  it('derives tools only for asTool verbs, using helper as the description', () => {
    const names = actionToolNames(resourceActions);

    expect(names).toEqual(
      expect.arrayContaining([
        'delete_resource',
        'favorite_resource',
        'open_share_settings',
        'show_history',
      ]),
    );
    expect(names).not.toContain('edit');
    expect(names).not.toContain('setEmoji');
  });

  it('execute builds context, gates on available, and calls run', async () => {
    const run = vi.fn();
    const action: ActionDefinition = {
      id: 'delete',
      scope: 'resource',
      section: 'action',
      label: () => 'Delete',
      helper: () => 'Delete this resource.',
      asTool: true,
      toolName: 'delete_resource',
      available: c => c.canWrite,
      run,
    };

    const allowed = await executeDerivedAction(action, 'did:ad:example', {
      buildContext: async () => ctx,
    });

    expect(run).toHaveBeenCalledOnce();
    expect(allowed).toMatchObject({ success: true, action: 'delete' });

    const blocked = await executeDerivedAction(action, 'did:ad:example', {
      buildContext: async () => ({ ...ctx, canWrite: false }),
    });

    expect(blocked).toMatchObject({ success: false });
  });
});
