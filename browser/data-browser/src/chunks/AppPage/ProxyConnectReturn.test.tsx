// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { StoreContext, type Store } from '@tomic/react';

/**
 * #1883: under StrictMode the return effect ran twice. The first run consumed
 * the pending handoff and was then cancelled; the second found nothing and
 * showed "not one this browser started" instead of going back to the app.
 */

/** Handoffs this "browser" started; `finish` consumes them, like the real one. */
const started = new Set<string>();
const finish = vi.fn();

vi.mock('@helpers/integrationProxy', () => ({
  getIntegrationProxy: () => 'https://proxy.example',
}));

vi.mock('@helpers/proxyConnections', () => ({
  ProxyConnections: class {
    isReturn(params: URLSearchParams) {
      return started.has(params.get('integration_state') ?? '');
    }

    finish(params: URLSearchParams) {
      return finish(params);
    }
  },
}));

const { ProxyConnectReturn } = await import('./ProxyConnectReturn');

const store = {
  getAgent: () => ({ subject: 'did:ad:agent:test' }),
  on: () => () => undefined,
} as unknown as Store;

const replace = vi.fn();

function renderReturn(state: string) {
  // jsdom's `location.replace` can be neither spied on nor navigate.
  vi.stubGlobal('location', {
    pathname: '/app/integrations',
    search: `?integration_state=${state}&platform=github&connection_code=c`,
    replace,
  });

  return render(
    <StrictMode>
      <StoreContext.Provider value={store}>
        <ProxyConnectReturn>
          <p>app</p>
        </ProxyConnectReturn>
      </StoreContext.Provider>
    </StrictMode>,
  );
}

beforeEach(() => {
  started.clear();
  finish.mockReset();
  finish.mockImplementation(async (params: URLSearchParams) => {
    const state = params.get('integration_state') ?? '';

    if (!started.delete(state)) {
      throw new Error(
        'This connection return is not one this browser started.',
      );
    }

    return { returnTo: `/app/drive?after=${state}`, connected: true };
  });
  replace.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProxyConnectReturn', () => {
  it('redeems once and returns to the app under StrictMode', async () => {
    started.add('s1');
    renderReturn('s1');

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('/app/drive?after=s1'),
    );
    expect(finish).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a failed redemption once', async () => {
    started.add('s2');
    finish.mockImplementation(async () => {
      throw new Error('The proxy refused the code.');
    });
    renderReturn('s2');

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'The proxy refused the code.',
    );
    expect(finish).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('still refuses a return this browser did not start', async () => {
    // Recognised at mount (say, another tab consumed it since), gone by the
    // time it is redeemed.
    started.add('s3');
    finish.mockImplementation(async () => {
      throw new Error(
        'This connection return is not one this browser started.',
      );
    });
    renderReturn('s3');

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'This connection return is not one this browser started.',
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it('renders the app for a page load that is no return', () => {
    renderReturn('unknown');

    expect(screen.getByText('app')).toBeTruthy();
    expect(finish).not.toHaveBeenCalled();
  });
});
