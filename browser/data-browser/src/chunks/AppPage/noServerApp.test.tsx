// @vitest-environment jsdom
// @wc-ignore-file
import { createElement, useEffect } from 'react';
import { act, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../../styling';
import { StoreContext, type NativeChannel } from '@tomic/react';
import { createEmbedStore } from '../../embed/embedStore';
import { handOverAppKey, appAgentOf } from './appAgent';
import { AppVerifierProvider, useAppVerifier } from './AppVerifierContext';
import { AppFrame } from './AppFrame';

vi.mock('@tomic/lib', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/lib')>()),
  findSchema: async () => ({ properties: { entrypoint: 'urn:entrypoint' } }),
  appSourceOf: async () => 'export const view = () => {};',
}));

const APP_AGENT = 'did:ad:agent:app';
const AGENT = 'atomic:agent:pZyZYvKoOcwczHXJoYvYctgrHXn2pZ7qfeWMyoUfQ_8';

/** The host as `atomic_lib::host::embed` answers: only commits are signed. */
function host() {
  const refused: string[] = [];
  const channel: NativeChannel = {
    async call(method, args) {
      switch (method) {
        case 'init':
          return true;
        case 'agent':
          return AGENT;
        case 'sign':
          refused.push(args[0] as string);
          throw new Error('only commits are signed');
        case 'getResourcesWithSnapshots':
          return (args[0] as string[]).map(() => ({
            jsonAd: null,
            snapshot: null,
          }));
        case 'outboxEntries':
          return [];
        default:
          return null;
      }
    },
  };

  return { channel, refused };
}

/** Renders `children` in a store with no server, and the host that refuses signing. */
async function noServerPage(children: React.ReactNode) {
  const { channel, refused } = host();
  const { store } = await createEmbedStore(channel);

  vi.spyOn(store, 'getResource').mockResolvedValue({
    get: () => 'urn:script',
    title: 'App',
  } as never);

  const theme = buildTheme(false, '#1b50d8');
  const view = render(
    createElement(
      StoreContext.Provider,
      { value: store },
      createElement(ThemeProvider, { theme }, children),
    ),
  );

  return { ...view, refused };
}

// Seen after `create_app` in the Flutter app: the run check failed with
// "only commits are signed", because the app's view token request was signed
// through the host. The view now runs in a srcdoc frame, nothing is signed.
it('runs an app in a srcdoc frame without signing when the store has no server', async () => {
  let verify: ReturnType<typeof useAppVerifier>['verifyApp'] | undefined;

  const Probe = () => {
    const { verifyApp } = useAppVerifier();
    useEffect(() => {
      verify = verifyApp;
    }, [verifyApp]);

    return null;
  };

  const { refused, container } = await noServerPage(
    createElement(AppVerifierProvider, null, createElement(Probe)),
  );

  let pending: ReturnType<NonNullable<typeof verify>> | undefined;
  await act(async () => {
    pending = verify!('atomic:app', 'atomic:drive');
  });

  // jsdom runs no iframe, so the verdict stays open; what is testable is the
  // frame that was made for the run.
  const frame = container.ownerDocument.querySelector('iframe');

  expect(frame?.getAttribute('srcdoc')).toContain("connect-src 'none'");
  expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-modals');
  expect(frame?.getAttribute('allow')).toBe('fullscreen');
  expect(frame?.hasAttribute('src')).toBe(false);
  expect(pending).toBeDefined();
  expect(refused).toEqual([]);
});

it('hands the app key to the host and reads its agent back, signing nothing', async () => {
  const { channel, refused } = host();
  const calls: Array<[string, unknown[]]> = [];
  const recording: NativeChannel = {
    async call(method, args) {
      calls.push([method, args]);

      if (method === 'setAppAgent' || method === 'appAgent')
        return { agent: APP_AGENT, createdAt: 1 };

      return channel.call(method, args);
    },
  };
  const { store } = await createEmbedStore(recording);

  await handOverAppKey(store, { drive: 'd', app: 'a', secret: 's' });
  expect(calls).toContainEqual(['setAppAgent', ['d', 'a', 's']]);
  expect(await appAgentOf(store, { drive: 'd', app: 'a' })).toBe(APP_AGENT);
  expect(refused).toEqual([]);
});

it('says an app has no identity when the host holds no key for it', async () => {
  const { channel } = host();
  const { store } = await createEmbedStore(channel);

  await expect(appAgentOf(store, { drive: 'd', app: 'a' })).rejects.toThrow(
    /no identity/i,
  );
});

it('renders a sandboxed srcdoc frame for an app, with no allow-same-origin', async () => {
  const { refused } = await noServerPage(
    createElement(AppFrame, { app: 'urn:app', drive: 'urn:drive' }),
  );

  await act(async () => {});
  const frame = document.querySelector('iframe');

  expect(frame).not.toBeNull();
  expect(frame!.getAttribute('sandbox')).not.toContain('allow-same-origin');
  expect(frame!.getAttribute('srcdoc')).toContain('export const view');
  expect(refused).toEqual([]);
});
