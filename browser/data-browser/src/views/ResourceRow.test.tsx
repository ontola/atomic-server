// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildTheme } from '../styling';
import { ResourceRow } from './ResourceRow';

const navigate = vi.hoisted(() => vi.fn());
const subject = 'atomic:project-notes';

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useResource: (value: string) => ({ subject: value }),
  useTitle: () => ['Project notes'],
  useString: () => ['Notes for the project'],
}));
vi.mock('./ResourceInline/ResourceInline', () => ({
  ResourceInline: ({ subject: value }: { subject: string }) => (
    <a href={`/app?subject=${value}`}>Project notes</a>
  ),
}));
vi.mock('../components/ResourceGlyph', () => ({
  ResourceGlyph: () => <span aria-hidden>Document</span>,
}));
vi.mock('../helpers/navigation', () => ({
  constructOpenURL: (value: string) => `/app?subject=${value}`,
}));
vi.mock('../hooks/useNavigateWithTransition', () => ({
  useNavigateWithTransition: () => navigate,
}));
vi.mock('../components/ResourceSync/ResourceSyncIndicator', () => ({
  ResourceSyncIndicator: () => (
    <button type='button' aria-label='Copies and sync'>
      <span>Sync</span>
    </button>
  ),
}));

beforeEach(() => navigate.mockReset());
afterEach(cleanup);

function show(props: Partial<React.ComponentProps<typeof ResourceRow>> = {}) {
  return render(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <ResourceRow subject={subject} clickable {...props} />
    </ThemeProvider>,
  );
}

it('opens the resource from row content but not a nested status button', () => {
  show();
  fireEvent.click(screen.getByText('Sync'));
  expect(navigate).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText('Notes for the project', { exact: false }));
  expect(navigate).toHaveBeenCalledWith(`/app?subject=${subject}`);
});

it('does not navigate when another trailing control is activated', () => {
  const action = vi.fn();
  show({ trailing: <button onClick={action}>Resource action</button> });

  fireEvent.click(screen.getByRole('button', { name: 'Resource action' }));
  expect(action).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
});

it('omits interactive sync controls when the row is just a label', () => {
  show({ clickable: false });
  expect(screen.queryByRole('button', { name: 'Copies and sync' })).toBeNull();
});

it('allows callers inside another interactive control to omit the sync button', () => {
  show({ showSyncStatus: false });
  expect(screen.queryByRole('button', { name: 'Copies and sync' })).toBeNull();
});
