// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  act,
  cleanup,
} from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { expect, it, vi, afterEach } from 'vitest';
import { AtomicLink } from './AtomicLink';
import { ResourceLinkNavigationContext } from './ResourceLinkNavigationContext';

afterEach(cleanup);

const fixture = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('../hooks/useNavigateWithTransition', () => ({
  useNavigateWithTransition: () => fixture.navigate,
}));
vi.mock('../helpers/navigation', () => ({
  constructOpenURL: (subject: string) =>
    subject === 'current' ? window.location.href : '/app/open?subject=next',
  pathToURL: (path: string) => path,
}));
vi.mock('@components/ResourceContextMenu/ResourceContextMenuContext', () => ({
  useResourceContextMenu: () => ({ openResourceMenu: vi.fn() }),
}));
vi.mock('@hooks/useIsInRTE', () => ({ useIsInRTE: () => false }));

function show(subject: string, onNavigate?: () => void) {
  return render(
    <ThemeProvider theme={{ colors: { text: 'black', main: 'blue' } } as never}>
      <ResourceLinkNavigationContext value={onNavigate}>
        <AtomicLink subject={subject}>Open resource</AtomicLink>
      </ResourceLinkNavigationContext>
    </ThemeProvider>,
  );
}

it('activates the already-open resource so mobile chat can dismiss', () => {
  const close = vi.fn();
  show('current', close);
  const link = screen.getByRole('link', { name: 'Open resource' });
  expect(link.tabIndex).toBe(0);
  fireEvent.click(link);
  expect(close).toHaveBeenCalledOnce();
});

it('waits for resource navigation before dismissing the overlay', async () => {
  const close = vi.fn();
  let finish!: () => void;
  fixture.navigate.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      }),
  );
  show('next', close);
  fireEvent.click(screen.getByRole('link', { name: 'Open resource' }));
  expect(close).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(close).toHaveBeenCalledOnce();
});
