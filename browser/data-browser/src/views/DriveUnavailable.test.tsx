// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../styling';
import { DriveUnavailable, RETRY_EVERY_MS } from './DriveUnavailable';

const store = vi.hoisted(() => ({
  isLocalOnlySubject: () => true,
  fetchResourceFromServer: vi.fn(),
}));

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useStore: () => store,
}));
vi.mock('../helpers/AppSettings', () => ({
  useSettings: () => ({ agent: undefined }),
}));
vi.mock('../helpers/browserPeerSync', () => ({
  resumePeerLinks: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  store.fetchResourceFromServer.mockReset();
});

function show() {
  render(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <DriveUnavailable
        subject='atomic:local-only-drive'
        error={new Error('not available locally')}
      />
    </ThemeProvider>,
  );
}

/**
 * A local-only subject this device doesn't hold makes every fetch reject. The
 * screen exists to say exactly that, so neither the timer nor "Retry now" may
 * leak the rejection (as an unhandled rejection, it reached Sentry every 10 s).
 * Vitest fails the run on an unhandled rejection, so these tests guard that.
 */
describe('DriveUnavailable', () => {
  it('keeps retrying on a timer without leaking the failure', async () => {
    vi.useFakeTimers();
    store.fetchResourceFromServer.mockRejectedValue(
      new Error('Not found locally and local-only'),
    );
    show();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETRY_EVERY_MS * 2);
    });

    expect(store.fetchResourceFromServer).toHaveBeenCalledTimes(2);
  });

  it('"Retry now" settles back to idle when the fetch fails', async () => {
    store.fetchResourceFromServer.mockRejectedValue(
      new Error('Not found locally and local-only'),
    );
    show();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    });

    expect(store.fetchResourceFromServer).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole('button', { name: 'Retry now' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });
});
