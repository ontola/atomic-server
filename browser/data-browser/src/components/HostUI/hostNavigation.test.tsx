// @vitest-environment jsdom
import { createRef, useEffect, type ReactNode } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHostUI } from './hostUI';

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  store: {
    getResource: vi.fn(async (subject: string) => ({
      subject,
      title: 'Readable row',
      error: undefined as Error | undefined,
    })),
  },
}));

vi.mock('@tomic/react', async () => ({
  ...(await vi.importActual<typeof import('@tomic/react')>('@tomic/react')),
  useStore: () => state.store,
}));
vi.mock('@hooks/useNavigateWithTransition', () => ({
  useNavigateWithTransition: () => state.navigate,
}));
vi.mock('@components/LocaleContext', () => ({
  useLocale: () => ({ locale: 'en' }),
}));
vi.mock('@components/ResourceContextMenu/ResourceContextMenuContext', () => ({
  useResourceContextMenu: () => ({ openResourceMenu: vi.fn() }),
}));
vi.mock('@components/ConfirmationDialog', () => ({
  ConfirmationDialogTheme: { Default: 'default', Alert: 'alert' },
  ConfirmationDialog: ({
    title,
    children,
    confirmLabel,
    onConfirm,
    onCancel,
  }: {
    title: string;
    children: ReactNode;
    confirmLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) => (
    <div role='dialog'>
      <h1>{title}</h1>
      {children}
      <button onClick={onConfirm}>{confirmLabel}</button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  ),
}));
vi.mock('@components/Dropdown', () => ({ DropdownMenu: () => null }));
vi.mock('@components/Dropdown/AutoOpenTrigger', () => ({
  AutoOpenTrigger: () => null,
}));
vi.mock('@components/Share/ShareDialog', () => ({
  OpenShareDialog: () => null,
}));
vi.mock('@components/forms/FilePicker/FilePickerDialog', () => ({
  FilePickerDialog: () => null,
}));
vi.mock('./hostUIDialogs', () => ({
  AppFormDialog: () => null,
  PickResourceDialog: () => null,
  AskedBy: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

let handle: ReturnType<typeof useHostUI>['handle'];

function Harness() {
  const ui = useHostUI({
    writeRoot: 'atomic:app',
    mayWriteUnder: async () => true,
    appTitle: 'Example app',
    frame: createRef<HTMLIFrameElement>(),
  });
  useEffect(() => {
    handle = ui.handle;
  }, [ui.handle]);

  return ui.element;
}

beforeEach(() => {
  state.navigate.mockClear();
  state.store.getResource.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('confirmed frame navigation', () => {
  it('names the actual host and opens only on confirmation with no opener', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const reply = vi.fn();
    render(<Harness />);
    act(() => {
      handle(
        { id: 1, op: 'openExternal', url: 'https://аpple.com/page' },
        reply,
      );
    });
    expect(screen.getByRole('heading').textContent).toContain(
      'xn--pple-43d.com',
    );
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open link' }));
    expect(open).toHaveBeenCalledWith(
      'https://xn--pple-43d.com/page',
      '_blank',
      'noopener,noreferrer',
    );
    expect(reply).toHaveBeenCalledWith({ id: 1, result: { status: 'opened' } });
  });

  it('cancels a link without opening it', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const reply = vi.fn();
    render(<Harness />);
    act(() => {
      handle({ id: 1, op: 'openExternal', url: 'https://example.com' }, reply);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(open).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      id: 1,
      result: { status: 'cancelled' },
    });
  });

  it('checks the resource through the person’s store and waits for a click', async () => {
    const reply = vi.fn();
    render(<Harness />);
    act(() => {
      handle(
        { id: 2, op: 'openResourceConfirmed', subject: 'atomic:row' },
        reply,
      );
    });
    await screen.findByRole('dialog');
    expect(state.store.getResource).toHaveBeenCalledWith('atomic:row');
    expect(screen.getByText(/Readable row/)).toBeTruthy();
    expect(state.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(state.navigate.mock.calls[0][0]).toContain('subject=atomic%3Arow');
    expect(reply).toHaveBeenCalledWith({
      id: 2,
      result: { status: 'opened', subject: 'atomic:row' },
    });
  });

  it.each([
    'atomic:agent:key',
    'atomic:commit:sig',
    'atomic:blob:hash',
    'atomic:node:id',
    '/app/dev-drive',
    'javascript:alert(1)',
  ])('refuses %s without loading it', async subject => {
    const reply = vi.fn();
    render(<Harness />);
    act(() => {
      handle({ id: 2, op: 'openResourceConfirmed', subject }, reply);
    });
    await waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0][0]).toMatchObject({
      id: 2,
      error: expect.any(String),
    });
    expect(state.store.getResource).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it('refuses a resource error instead of drawing a navigation prompt', async () => {
    state.store.getResource.mockResolvedValueOnce({
      subject: 'atomic:row',
      title: '',
      error: new Error('Forbidden'),
    });
    const reply = vi.fn();
    render(<Harness />);
    act(() => {
      handle(
        { id: 2, op: 'openResourceConfirmed', subject: 'atomic:row' },
        reply,
      );
    });
    await waitFor(() =>
      expect(reply).toHaveBeenCalledWith({ id: 2, error: 'Forbidden' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cannot resurrect a superseded resource ask when its read finishes', async () => {
    let resolveRead!: (value: {
      subject: string;
      title: string;
      error: undefined;
    }) => void;
    state.store.getResource.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveRead = resolve;
        }),
    );
    const reply = vi.fn();
    render(<Harness />);
    act(() => {
      handle(
        { id: 2, op: 'openResourceConfirmed', subject: 'atomic:row' },
        reply,
      );
      handle({ id: 3, op: 'openExternal', url: 'https://example.com' }, reply);
    });
    expect(reply).toHaveBeenCalledWith({
      id: 2,
      result: { status: 'cancelled', subject: 'atomic:row' },
    });
    await act(async () => {
      resolveRead({
        subject: 'atomic:row',
        title: 'Late row',
        error: undefined,
      });
    });
    expect(screen.getByRole('heading').textContent).toContain('example.com');
    expect(screen.queryByText(/Late row/)).toBeNull();
  });

  it('keeps a same-origin resource in the subject query, never as a host route', async () => {
    const subject = `${window.location.origin}/app/dev-drive`;
    const reply = vi.fn();
    render(<Harness />);
    act(() => {
      handle({ id: 5, op: 'openResourceConfirmed', subject }, reply);
    });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(state.navigate).toHaveBeenCalledWith(
      `/app/show?${new URLSearchParams({ subject })}`,
    );
  });

  it('keeps the existing store.ui.openResource response and navigation', () => {
    const reply = vi.fn();
    render(<Harness />);
    act(() => {
      handle({ id: 4, op: 'openResource', subject: 'atomic:row' }, reply);
    });
    expect(state.navigate).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ id: 4, result: true });
  });
});
