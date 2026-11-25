// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Resource } from '@tomic/react';
import type { NavigateOptions } from '@tomic/resource-ui/ResourceUIHost';
import { CustomContextItemsProvider } from '@tomic/resource-ui/components/ResourceContextMenu/CustomContextItemsContext';
import { afterEach, expect, it, vi } from 'vitest';
import { buildTheme, ThemeProvider } from '../../test/providers.js';
import { TablePage } from './TablePage.js';

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useCanWrite: () => true,
  useResource: (subject: string) => ({ subject }),
  useString: () => ['row-class'],
}));
vi.mock('@tomic/resource-ui/chunks/FormBuilder/useTableFormColumns', () => ({
  useTableFormColumns: () => ({ columns: [{ subject: 'column' }] }),
}));
vi.mock('@tomic/resource-ui/components/EditableTitle', () => ({
  EditableTitle: () => null,
}));
vi.mock('@tomic/resource-ui/components/ResourceDecorations', () => ({
  ResourceCoverImage: () => null,
}));
vi.mock('./TableForms.js', () => ({ TableForms: () => null }));
vi.mock('./TableResource.js', () => ({ TableResource: () => null }));
vi.mock('./TableExportDialog.js', () => ({ TableExportDialog: () => null }));
vi.mock('./PropertyForm/EditPropertyDialog.js', () => ({
  EditPropertyDialog: ({
    bindShow,
  }: {
    bindShow: (visible: boolean) => void;
  }) => <button onClick={() => bindShow(false)}>Close column editor</button>,
}));

afterEach(cleanup);

it.each(['column', 'another-column'])(
  'preserves newer search state when closing a column editor (%s)',
  latestColumn => {
    const latest = {
      editColumn: latestColumn,
      subject: 'table',
      view: 'new-view',
      other: 'new-value',
    };
    const navigate = vi.fn<(options: NavigateOptions) => void>();
    render(
      <ThemeProvider
        theme={buildTheme()}
        hostOverrides={{
          search: { editColumn: 'column', subject: 'table', view: 'old-view' },
          navigate,
        }}
      >
        <CustomContextItemsProvider>
          <TablePage resource={{ subject: 'table' } as Resource} />
        </CustomContextItemsProvider>
      </ThemeProvider>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Close column editor' }),
    );
    expect(navigate).toHaveBeenCalledOnce();
    const [{ search, replace }] = navigate.mock.calls[0];
    expect(replace).toBe(true);
    expect(typeof search === 'function' ? search(latest) : search).toEqual({
      ...latest,
      editColumn: latestColumn === 'column' ? undefined : latestColumn,
    });
  },
);
