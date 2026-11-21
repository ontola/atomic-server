// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  act,
  cleanup,
} from '@testing-library/react';
import { expect, it, vi, afterEach } from 'vitest';
import { buildTheme, ThemeProvider } from '../../../resource-ui/test/providers';
import { AtomicLink } from '@tomic/resource-ui/components/AtomicLink';
import { ResourceLinkNavigationContext } from '@tomic/resource-ui/components/ResourceLinkNavigationContext';

afterEach(cleanup);

const navigate = vi.fn();

function show(subject: string, onNavigate?: () => void) {
  return render(
    <ThemeProvider
      theme={buildTheme()}
      hostOverrides={{
        navigateWithTransition: navigate,
        links: {
          constructOpenURL: target =>
            target === 'current'
              ? window.location.href
              : '/app/open?subject=next',
          pathToURL: path => path,
        },
      }}
    >
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
  navigate.mockImplementationOnce(
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
