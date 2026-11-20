// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../../styling';
import {
  AppFrame,
  appFrameProfileSource,
  type AppFrameProfile,
} from './AppFrame';

const fixture = vi.hoisted(() => {
  const actor = { subject: 'did:ad:agent:person' };
  const store = {
    getAgent: () => actor,
    getServerUrl: () => 'https://node.test',
    noServer: false,
    subscribe: vi.fn((_subject: string, _changed: () => void) => vi.fn()),
  };

  return {
    actor,
    store,
    handleUI: vi.fn(() => false),
    forwardKey: vi.fn(() => false),
    consent: vi.fn(),
  };
});

vi.mock('@tomic/react', async original => ({
  ...(await original<typeof import('@tomic/react')>()),
  useStore: () => fixture.store,
  useCurrentAgent: () => [fixture.actor],
  useServerURL: () => [fixture.store.getServerUrl()],
  useResource: () => ({}),
  useTitle: () => ['Test app'],
}));
vi.mock('./appKeyHandover', () => ({
  subscribeAppKeyHandover: () => () => undefined,
}));
vi.mock('@components/HostUI/hostUI', () => ({
  useHostUI: () => ({
    handle: fixture.handleUI,
    forwardKey: fixture.forwardKey,
    element: null,
  }),
}));
vi.mock('@views/PluginView/useCreateThemeVars', () => ({
  useCreateThemeVars: () => '',
  useFrameColorScheme: () => 'light',
}));
vi.mock('./ConnectDialog', () => ({
  ConnectDialog: (props: unknown) => {
    fixture.consent(props);

    return <span>Native connection consent</span>;
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const profile = (extra: Partial<AppFrameProfile> = {}): AppFrameProfile => ({
  source: 'https://node.test/builtin/app.html',
  access: { root: 'https://node.test/table', assertCurrent: () => undefined },
  ...extra,
});

async function mount(selected: AppFrameProfile) {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const rendered = render(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <AppFrame
        app='https://node.test/app'
        drive='https://node.test/drive'
        table='https://node.test/table'
        profile={selected}
      />
    </ThemeProvider>,
  );
  await act(async () => {});
  const iframe = rendered.container.querySelector('iframe')!;
  const post = iframe
    ? vi.spyOn(iframe.contentWindow!, 'postMessage')
    : vi.fn();

  const connect = async () => {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: iframe.contentWindow,
          data: {
            type: 'atomic.view.request',
            version: 1,
            id: 'connect',
            op: 'proxyConnect',
            args: { platform: 'provider', connectionId: 'existing' },
          },
        }),
      );
    });
  };

  return { ...rendered, iframe, fetch, post, connect };
}

it('confines a host-selected source to the selected server', () => {
  expect(appFrameProfileSource('/builtin/app.html', 'https://node.test')).toBe(
    'https://node.test/builtin/app.html',
  );
  for (const source of [
    'https://other.test/app.html',
    'https://user:password@node.test/app.html',
    'https://node.test/app.html#fragment',
    'javascript:alert(1)',
  ])
    expect(() => appFrameProfileSource(source, 'https://node.test')).toThrow(
      'served by this Atomic Server',
    );
});

it('loads the fixed source in the existing null-origin frame without minting an app token', async () => {
  const page = await mount(profile());
  expect(page.iframe.getAttribute('src')).toBe(
    'https://node.test/builtin/app.html',
  );
  expect(page.iframe.getAttribute('sandbox')).toBe(
    'allow-scripts allow-modals',
  );
  expect(page.fetch).not.toHaveBeenCalled();
  page.fetch.mockRestore();
});

it('denies a worker connection request before opening native consent', async () => {
  const page = await mount(profile());
  await page.connect();
  expect(page.post).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'atomic.view.response',
      id: 'connect',
      error: 'This view cannot connect an account',
    }),
    '*',
  );
  expect(fixture.consent).not.toHaveBeenCalled();
  page.fetch.mockRestore();
});

it('does not mount a frame for a foreign source', async () => {
  const page = await mount(profile({ source: 'https://other.test/app.html' }));
  expect(page.iframe).toBeNull();
  expect(page.container.textContent).toContain(
    'Built-in views must be served by this Atomic Server',
  );
  expect(page.fetch).not.toHaveBeenCalled();
});

it('opens native consent before invoking the host-selected account flow', async () => {
  const start = vi.fn(async () => {
    throw new Error('OAuth redirect would start here');
  });
  const page = await mount(profile({ connect: start }));
  await page.connect();
  expect(fixture.consent).toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  await expect(
    fixture.consent.mock.calls.at(-1)![0].onConnect(),
  ).rejects.toThrow('OAuth redirect would start here');
  expect(start).toHaveBeenCalledWith('provider', 'existing');
  page.fetch.mockRestore();
});

async function openResource(
  page: Awaited<ReturnType<typeof mount>>,
  subject: string,
) {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: page.iframe.contentWindow,
        data: {
          type: 'atomic.view.request',
          version: 1,
          id: 'open',
          op: 'openResource',
          args: { subject },
        },
      }),
    );
  });
}

it('prepares host-selected navigation through the existing openResource operation', async () => {
  const prepare = vi.fn(async () => 'https://node.test/principal-app');
  const page = await mount(profile({ prepareOpenResource: prepare }));
  await openResource(page, 'https://node.test/principal');
  expect(prepare).toHaveBeenCalledWith('https://node.test/principal');
  expect(fixture.handleUI).toHaveBeenCalledWith(
    expect.objectContaining({
      op: 'openResource',
      subject: 'https://node.test/principal-app',
    }),
    expect.any(Function),
  );
});

it('does not navigate after preparation loses its selected authority', async () => {
  let current = true;
  const page = await mount(
    profile({
      access: {
        root: 'https://node.test/table',
        assertCurrent: () => {
          if (!current) throw new Error('Source changed');
        },
      },
      prepareOpenResource: async () => {
        current = false;

        return 'https://node.test/principal-app';
      },
    }),
  );
  await openResource(page, 'https://node.test/principal');
  expect(fixture.handleUI).not.toHaveBeenCalled();
  expect(page.post).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'open',
      error: expect.stringContaining('Source changed'),
    }),
    '*',
  );
});

async function subscription(
  page: Awaited<ReturnType<typeof mount>>,
  op: 'subscribe' | 'unsubscribe',
  subject: string,
) {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: page.iframe.contentWindow,
        data: {
          type: 'atomic.view.request',
          version: 1,
          id: op,
          op,
          args: { subject },
        },
      }),
    );
  });
}

it('rejects a foreign-Drive subscription before installing any Store listener', async () => {
  const page = await mount(
    profile({
      authorizeRead: async () => {
        throw new Error('Outside selected Drive');
      },
    }),
  );
  await subscription(page, 'subscribe', 'https://node.test/foreign-row');
  expect(fixture.store.subscribe).not.toHaveBeenCalled();
  expect(page.post).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'subscribe',
      error: 'Outside selected Drive',
    }),
    '*',
  );
});

it('revalidates each native subscription event and stops notifying after the row moves out of Drive', async () => {
  let allowed = true;
  const remove = vi.fn();
  fixture.store.subscribe.mockReturnValueOnce(remove);
  const page = await mount(
    profile({
      authorizeRead: async () => {
        if (!allowed) throw new Error('Row moved');
      },
    }),
  );
  const subject = 'https://node.test/own-row';
  await subscription(page, 'subscribe', subject);
  expect(fixture.store.subscribe).toHaveBeenCalledOnce();
  const changed = fixture.store.subscribe.mock.calls[0][1];
  await act(async () => changed());
  expect(page.post).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'atomic.view.change', subject }),
    '*',
  );
  page.post.mockClear();
  allowed = false;
  await act(async () => changed());
  expect(page.post).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledOnce();
});

it.each(['unsubscribe', 'cancel', 'frame reload'] as const)(
  'does not install a subscription after pending authorization is revoked by %s',
  async revoke => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => {
      release = resolve;
    });
    const controller = new AbortController();
    const page = await mount(
      profile({
        authorizeRead: async () => waiting,
        access: {
          root: 'https://node.test/table',
          signal: controller.signal,
          assertCurrent: () => {},
        },
      }),
    );
    const subject = 'https://node.test/own-row';
    await subscription(page, 'subscribe', subject);
    if (revoke === 'unsubscribe')
      await subscription(page, 'unsubscribe', subject);
    else if (revoke === 'cancel') controller.abort();
    else
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: page.iframe.contentWindow,
            data: { type: '__atomic_plugin_ready' },
          }),
        );
      });
    page.post.mockClear();
    await act(async () => {
      release();
    });
    expect(fixture.store.subscribe).not.toHaveBeenCalled();
    expect(page.post).not.toHaveBeenCalled();
  },
);
