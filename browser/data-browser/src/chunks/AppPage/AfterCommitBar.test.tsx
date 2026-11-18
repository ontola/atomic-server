// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import type { AfterCommitSubscription } from './afterCommit';

const answerAfterCommit = vi.fn(async () => ({}));

vi.mock('./afterCommit', async importOriginal => ({
  ...(await importOriginal<typeof import('./afterCommit')>()),
  answerAfterCommit: (...args: unknown[]) =>
    (answerAfterCommit as (...a: unknown[]) => Promise<unknown>)(...args),
}));
vi.mock('@tomic/react', () => ({
  useStore: () => ({ getDrive: () => 'did:ad:drive' }),
  useResource: () => ({ title: 'Sync' }),
}));
vi.mock('@components/Button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: React.PropsWithChildren<{ onClick?: () => void; disabled?: boolean }>) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

const { AfterCommitNotice } = await import('./AfterCommitBar');
const { FollowsChangesText } = await import('./RowGrantText');

afterEach(() => {
  cleanup();
  answerAfterCommit.mockClear();
});

const theme = { colors: {}, radius: '4px' } as unknown as DefaultTheme;

function sub(
  patch: Partial<AfterCommitSubscription> = {},
): AfterCommitSubscription {
  return {
    table: 'did:ad:table',
    view: 'did:ad:view',
    app: 'did:ad:app',
    via: 'add-view',
    activatedBy: 'did:ad:agent:me',
    activatedAt: 0,
    attempts: 0,
    waiting: false,
    ...patch,
  };
}

function show(s: AfterCommitSubscription) {
  return render(
    <ThemeProvider theme={theme}>
      <AfterCommitNotice
        sub={s}
        appName='Calendar sync'
        table='did:ad:table'
        tableName='Events'
      />
    </ThemeProvider>,
  );
}

it('asks about the rows a background run wants to change, with the three answers', () => {
  show(sub({ pending: { rows: 3, subjects: [], inScope: true, at: 0 } }));

  expect(screen.getByTestId('after-commit-proposal').textContent).toContain(
    'Calendar sync wants to change 3 rows',
  );
  expect(screen.getByText('Apply')).toBeTruthy();
  expect(
    screen.getByText('Allow all edits by this view on this table'),
  ).toBeTruthy();
  expect(screen.getByText('Decline')).toBeTruthy();
});

it('offers only Apply and Decline for edits beyond the rows', () => {
  show(sub({ pending: { rows: 1, subjects: [], inScope: false, at: 0 } }));

  expect(screen.getByTestId('after-commit-proposal').textContent).toContain(
    'wants to change 1 row',
  );
  expect(
    screen.queryByText('Allow all edits by this view on this table'),
  ).toBeNull();
});

it('sends the answer for this table', () => {
  show(sub({ pending: { rows: 2, subjects: [], inScope: true, at: 0 } }));
  fireEvent.click(
    screen.getByText('Allow all edits by this view on this table'),
  );

  expect(answerAfterCommit).toHaveBeenCalledWith(expect.anything(), {
    drive: 'did:ad:drive',
    table: 'did:ad:table',
    app: 'did:ad:app',
    op: 'allow-all',
  });
});

it('shows a quiet warning with Retry when it stopped following the table', () => {
  show(
    sub({
      stopped: { reason: 'boom on attempt 8', at: 0, attempts: 8 },
    }),
  );

  const warning = screen.getByTestId('after-commit-stopped');
  expect(warning.textContent).toContain(
    'Calendar sync stopped following changes to Events:',
  );
  expect(screen.getByText('boom on attempt 8')).toBeTruthy();
  fireEvent.click(screen.getByText('Retry'));
  expect(answerAfterCommit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ op: 'retry' }),
  );
  expect(screen.queryByTestId('after-commit-proposal')).toBeNull();
});

it('the dialog line says it follows changes while the tab is closed', () => {
  const { container } = render(<FollowsChangesText appName='Calendar sync' />);

  expect(container.textContent).toBe(
    'Calendar sync is told when rows change, also when this tab is closed.',
  );
});
