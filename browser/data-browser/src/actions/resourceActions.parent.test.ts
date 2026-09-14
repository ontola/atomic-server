import { describe, expect, it, vi } from 'vitest';
import { core, dataBrowser, server } from '@tomic/react';
import { resourceActions } from './resourceActions';
import type { ActionContext } from './types';

const parent = resourceActions.find(action => action.id === 'parent')!;
const viewSource = resourceActions.find(action => action.id === 'view-source')!;

function ctx(
  resource: {
    loading?: boolean;
    get: (prop: string) => unknown;
    getClasses: () => string[];
    hasClasses?: (classSubject: string) => boolean;
  },
  extra: Partial<ActionContext> = {},
): ActionContext {
  return {
    resource,
    subject: 'did:ad:child',
    ...extra,
  } as unknown as ActionContext;
}

describe('parent action', () => {
  it('is available when parent is already on the resource', () => {
    expect(
      parent.available?.(
        ctx({
          get: prop =>
            prop === core.properties.parent ? 'did:ad:parent' : undefined,
          getClasses: () => [],
        }),
      ),
    ).toBe(true);
  });

  it('stays available on a non-drive even before parent has materialized', () => {
    expect(
      parent.available?.(
        ctx({
          get: () => undefined,
          getClasses: () => [],
        }),
      ),
    ).toBe(true);
  });

  it('is hidden on a drive, which has no parent', () => {
    expect(
      parent.available?.(
        ctx({
          get: () => undefined,
          getClasses: () => [server.classes.drive],
        }),
      ),
    ).toBe(false);
  });

  it('fetches the resource when parent is not yet on the stub', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });

    const navigate = vi.fn();
    const getResource = vi.fn().mockResolvedValue({
      get: (prop: string) =>
        prop === core.properties.parent ? 'did:ad:parent' : undefined,
    });

    await parent.run(
      ctx(
        {
          loading: true,
          get: () => undefined,
          getClasses: () => [],
        },
        {
          subject: 'did:ad:child',
          navigate,
          store: { getResource } as unknown as ActionContext['store'],
        },
      ),
    );

    expect(getResource).toHaveBeenCalledWith('did:ad:child');
    expect(navigate).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent('did:ad:parent')),
    );
  });
});

describe('view source action', () => {
  it('is available for a Document V2 without write permission when the menu provides a dialog', () => {
    const showDocumentSourceDialog = vi.fn();

    expect(
      viewSource.available?.(
        ctx(
          {
            get: () => undefined,
            getClasses: () => [],
            hasClasses: (classSubject: string) =>
              classSubject === dataBrowser.classes.documentV2,
          },
          { canWrite: false, showDocumentSourceDialog },
        ),
      ),
    ).toBe(true);

    viewSource.run(
      ctx(
        {
          get: () => undefined,
          getClasses: () => [],
          hasClasses: () => true,
        },
        { canWrite: false, showDocumentSourceDialog },
      ),
    );

    expect(showDocumentSourceDialog).toHaveBeenCalledOnce();
  });

  it('stays hidden for non-documents and surfaces without a dialog callback', () => {
    const nonDocument = ctx({
      get: () => undefined,
      getClasses: () => [],
      hasClasses: () => false,
    });
    const noDialog = ctx(
      {
        get: () => undefined,
        getClasses: () => [],
        hasClasses: () => true,
      },
      { canWrite: false },
    );

    expect(viewSource.available?.(nonDocument)).toBe(false);
    expect(viewSource.available?.(noDialog)).toBe(false);
  });
});
