import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  waitForEmbeddedServer,
  showEmbeddedServerError,
  hideBootSplash,
} from './waitForEmbeddedServer';

/**
 * The default vitest environment here is `node`, so there is no `document`.
 * Splash DOM tests stub the two nodes the helper touches.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

function deps(overrides: Parameters<typeof waitForEmbeddedServer>[0] = {}) {
  return {
    isTauri: () => true,
    origin: 'http://localhost:9883',
    now: () => 0,
    sleep: async () => undefined,
    timeoutMs: 1_000,
    intervalMs: 1,
    showError: vi.fn(),
    ...overrides,
  };
}

describe('waitForEmbeddedServer', () => {
  it('does nothing in a regular browser', async () => {
    const fetchFn = vi.fn();
    const getStatus = vi.fn();

    await waitForEmbeddedServer(
      deps({
        isTauri: () => false,
        fetchFn,
        getStatus,
      }),
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('resolves as soon as node_status reports ready', async () => {
    const fetchFn = vi.fn();

    await waitForEmbeddedServer(
      deps({
        fetchFn,
        getStatus: async () => ({ ready: true }),
      }),
    );

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('falls back to HTTP when invoke is missing, then resolves', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    await waitForEmbeddedServer(
      deps({
        fetchFn,
        getStatus: async () => undefined,
      }),
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('probes HTTP with HEAD so it does not download the SPA', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 200 }));

    await waitForEmbeddedServer(
      deps({
        fetchFn,
        getStatus: async () => undefined,
      }),
    );

    expect(fetchFn).toHaveBeenCalledWith(
      'http://localhost:9883',
      expect.objectContaining({ method: 'HEAD' }),
    );
  });

  it('does not HTTP-poll when IPC reports that the node is not ready', async () => {
    const fetchFn = vi.fn();
    let now = 0;

    await expect(
      waitForEmbeddedServer(
        deps({
          fetchFn,
          getStatus: async () => ({ ready: false }),
          now: () => now,
          sleep: async () => {
            now += 500;
          },
          timeoutMs: 1_000,
        }),
      ),
    ).rejects.toThrow(/did not start in time/);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('treats any HTTP response as up, including 404', async () => {
    await waitForEmbeddedServer(
      deps({
        fetchFn: vi.fn().mockResolvedValue(new Response('', { status: 404 })),
        getStatus: async () => undefined,
      }),
    );
  });

  it('fails immediately when the node reports a startup error', async () => {
    const showError = vi.fn();
    const reason =
      'The local node failed to start: Database already open\n\nAnother atomic-server is already using this data directory.';

    await expect(
      waitForEmbeddedServer(
        deps({
          fetchFn: vi.fn(),
          getStatus: async () => ({ ready: false, error: reason }),
          showError,
        }),
      ),
    ).rejects.toThrow(reason);

    expect(showError).toHaveBeenCalledWith(reason);
  });

  it('retries until the node is ready', async () => {
    let calls = 0;

    const getStatus = async () => {
      calls += 1;

      return { ready: calls >= 3 };
    };

    await waitForEmbeddedServer(
      deps({
        fetchFn: vi.fn().mockRejectedValue(new Error('refused')),
        getStatus,
      }),
    );

    expect(calls).toBe(3);
  });

  it('throws after the deadline and writes the error onto the splash', async () => {
    let now = 0;
    const showError = vi.fn();

    await expect(
      waitForEmbeddedServer(
        deps({
          fetchFn: vi.fn().mockRejectedValue(new Error('refused')),
          getStatus: async () => ({ ready: false }),
          now: () => now,
          sleep: async () => {
            now += 500;
          },
          timeoutMs: 1_000,
          showError,
        }),
      ),
    ).rejects.toThrow(/did not start in time/);

    expect(showError).toHaveBeenCalledOnce();
  });
});

function stubSplash(
  overrides: {
    splashFailed?: boolean;
    splashHidden?: boolean;
  } = {},
) {
  const classes = new Set<string>();
  const attrs: Record<string, string> = {};
  const status = { hidden: true, textContent: '' };
  const loader = {
    classList: {
      add: (name: string) => {
        classes.add(name);
      },
    },
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
  };
  const splash = {
    classList: {
      add: (name: string) => {
        classes.add(name);
      },
      contains: (name: string) => {
        if (name === 'is-failed') return !!overrides.splashFailed;
        if (name === 'is-hidden') return !!overrides.splashHidden;

        return classes.has(name);
      },
    },
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
    querySelector: (selector: string) =>
      selector === '.loader' ? loader : null,
  };

  vi.stubGlobal('document', {
    getElementById: (id: string) => {
      if (id === 'loader-status') return status;
      if (id === 'boot-splash') return splash;

      return null;
    },
    querySelector: (selector: string) =>
      selector === '.loader' ? loader : null,
  });

  return { classes, attrs, status };
}

describe('showEmbeddedServerError', () => {
  it('unhides the splash status and stops the spinner', () => {
    const { classes, attrs, status } = stubSplash();

    showEmbeddedServerError('Database already open');

    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Database already open');
    expect(classes.has('is-failed')).toBe(true);
    expect(attrs['aria-busy']).toBe('false');
  });
});

describe('hideBootSplash', () => {
  it('fades the overlay so React can show the app', () => {
    const { classes, attrs } = stubSplash();

    hideBootSplash();

    expect(classes.has('is-hidden')).toBe(true);
    expect(attrs['aria-busy']).toBe('false');
    expect(attrs['aria-hidden']).toBe('true');
  });

  it('leaves a failed splash up so the error stays readable', () => {
    const { classes } = stubSplash({ splashFailed: true });

    hideBootSplash();

    expect(classes.has('is-hidden')).toBe(false);
  });

  it('is a no-op the second time', () => {
    const { classes } = stubSplash({ splashHidden: true });

    hideBootSplash();

    expect(classes.has('is-hidden')).toBe(false);
  });
});
