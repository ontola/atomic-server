// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { Resource } from '@tomic/react';
import { ExternalPropertyDialog } from './ExternalPropertyDialog';
const mocks = vi.hoisted(() => ({ attach: vi.fn(), getResource: vi.fn() }));
vi.mock('@tomic/react', () => ({
  useStore: () => ({ getResource: mocks.getResource }),
  urls: { classes: { property: 'Property' } },
}));
vi.mock('../Kanban/createSelectProperty', () => ({
  attachPropertiesToClass: (...args: unknown[]) => mocks.attach(...args),
}));
vi.mock('@components/forms/ResourceSelector', () => ({
  ResourceSelector: ({
    value,
    setSubject,
    disabled,
  }: {
    value?: string;
    setSubject: (value: string) => void;
    disabled: boolean;
  }) => (
    <input
      aria-label='Property'
      value={value ?? ''}
      disabled={disabled}
      onChange={event => setSubject(event.target.value)}
    />
  ),
}));
vi.mock(
  '@components/forms/formValidation/FormValidationContextProvider',
  async () => {
    const { useEffect } = await import('react');

    return {
      FormValidationContextProvider: ({
        children,
        onValidationChange,
      }: {
        children: React.ReactNode;
        onValidationChange: (valid: boolean) => void;
      }) => {
        useEffect(() => onValidationChange(true), [onValidationChange]);

        return children;
      },
    };
  },
);
vi.mock('./AtomicPropertyFrame', () => ({
  AtomicPropertyFrame: ({
    title,
    children,
    actions,
  }: {
    title: string;
    children: React.ReactNode;
    actions: {
      key: string;
      label: string;
      disabled: boolean;
      run: () => void;
    }[];
  }) => (
    <div role='dialog' aria-label={title}>
      {children}
      {actions.map(action => (
        <button
          key={action.key}
          disabled={action.disabled}
          onClick={action.run}
        >
          {action.label}
        </button>
      ))}
    </div>
  ),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const owner = { subject: 'row-class' } as Resource;
it('retains the chosen property after a failed attachment and confirms only after a successful retry', async () => {
  let release!: () => void;
  mocks.getResource.mockResolvedValue({ hasClasses: () => true });
  mocks.attach
    .mockRejectedValueOnce(Error('Attachment unavailable'))
    .mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
    );
  const created = vi.fn(),
    close = vi.fn();
  render(
    <ExternalPropertyDialog
      open
      tableClassResource={owner}
      bindShow={close}
      onCreated={created}
    />,
  );
  fireEvent.change(await screen.findByRole('textbox', { name: 'Property' }), {
    target: { value: 'chosen-property' },
  });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await screen.findByText('Attachment unavailable');
  expect(created).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('textbox', { name: 'Property' }) as HTMLInputElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
  expect(mocks.attach.mock.calls[1][1]).toBe(owner);
  expect(mocks.attach.mock.calls[1][2]).toEqual(['chosen-property']);
  expect(
    (screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  release();
  await waitFor(() => expect(created).toHaveBeenCalledWith('chosen-property'));
  expect(close).toHaveBeenCalledWith(false);
});
it('rejects a non-Property resource before any attachment', async () => {
  mocks.getResource.mockResolvedValue({ hasClasses: () => false });
  render(
    <ExternalPropertyDialog
      open
      tableClassResource={owner}
      bindShow={vi.fn()}
    />,
  );
  fireEvent.change(await screen.findByRole('textbox', { name: 'Property' }), {
    target: { value: 'not-property' },
  });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await screen.findByText('Choose a Property resource.');
  expect(mocks.attach).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('textbox', { name: 'Property' }) as HTMLInputElement)
      .disabled,
  ).toBe(false);
});
