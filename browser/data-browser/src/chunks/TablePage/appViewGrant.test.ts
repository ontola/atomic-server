// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import type { RowGrant } from '@chunks/AppPage/rowGrant';
import { addAppView, grantWhenSaved } from './appViewGrant';

const APP = { subject: 'did:ad:money', name: 'Money' };

function setup() {
  const calls: string[] = [];
  const grant = vi.fn(async (view: string, via: string) => {
    calls.push(`grant ${view} ${via}`);

    return { id: 'g1', view, via } as unknown as RowGrant;
  });

  return {
    calls,
    grant,
    createView: vi.fn(async (kind: string, label: string) => {
      calls.push(`create ${kind} ${label}`);

      return 'did:ad:view-new';
    }),
    setViewKind: vi.fn(async (view: string, kind: string) => {
      calls.push(`kind ${view} ${kind}`);
    }),
  };
}

describe('making an app a table view (#1740)', () => {
  it('"+ Add view" with Allow editing adds the view, then grants it by that gesture', async () => {
    const s = setup();

    const result = await addAppView({ app: APP, allowEditing: true, ...s });

    expect(s.calls).toEqual([
      'create did:ad:money Money',
      'grant did:ad:view-new add-view',
    ]);
    expect(result.grant?.id).toBe('g1');
  });

  it('"Add read-only" adds the view and grants nothing', async () => {
    const s = setup();

    const result = await addAppView({ app: APP, allowEditing: false, ...s });

    expect(s.calls).toEqual(['create did:ad:money Money']);
    expect(s.grant).not.toHaveBeenCalled();
    expect(result).toEqual({ view: 'did:ad:view-new' });
  });

  it('switching a tab in "View type" sets the kind, then grants it as view-type', async () => {
    const s = setup();

    await addAppView({
      app: APP,
      view: 'did:ad:view-1',
      allowEditing: true,
      ...s,
    });

    expect(s.calls).toEqual([
      'kind did:ad:view-1 did:ad:money',
      'grant did:ad:view-1 view-type',
    ]);
  });

  it('setting the kind alone is not a grant', async () => {
    const s = setup();

    await addAppView({
      app: APP,
      view: 'did:ad:view-1',
      allowEditing: false,
      ...s,
    });

    expect(s.setViewKind).toHaveBeenCalledOnce();
    expect(s.grant).not.toHaveBeenCalled();
  });

  it('grants nothing when the view could not be created', async () => {
    const s = setup();
    s.createView.mockResolvedValueOnce(undefined as unknown as string);

    await addAppView({ app: APP, allowEditing: true, ...s });

    expect(s.grant).not.toHaveBeenCalled();
  });
});

describe('grantWhenSaved', () => {
  const wait = vi.fn(async () => undefined);

  it('retries while the server has not got the new view yet', async () => {
    let tries = 0;
    const result = await grantWhenSaved(async () => {
      if (tries++ < 2)
        throw new Error(
          'That view is not a view of this table showing this app',
        );

      return 'granted';
    }, wait);

    expect(result).toBe('granted');
    expect(tries).toBe(3);
  });

  it('does not retry any other refusal', async () => {
    let tries = 0;

    await expect(
      grantWhenSaved(async () => {
        tries++;
        throw new Error(
          'Only someone who can edit this table can let an app edit its rows',
        );
      }, wait),
    ).rejects.toThrow('Only someone');
    expect(tries).toBe(1);
  });
});
