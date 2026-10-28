// @vitest-environment jsdom
// @wc-ignore-file
import { createElement, useEffect } from 'react';
import { act, render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { StoreContext, type NativeChannel } from '@tomic/react';
import { createEmbedStore } from '../../embed/embedStore';
import { handOverAppKey, appAgentOf } from './appAgent';
import { AppVerifierProvider, useAppVerifier } from './AppVerifierContext';

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

// Seen after `create_app` in the Flutter app: the run check failed with
// "only commits are signed", because the app's view token request was signed
// through the host.
it('checks an app without signing a request when the store has no server', async () => {
  const { channel, refused } = host();
  const { store } = await createEmbedStore(channel);
  let verify: ReturnType<typeof useAppVerifier>['verifyApp'] | undefined;

  const Probe = () => {
    const { verifyApp } = useAppVerifier();
    useEffect(() => {
      verify = verifyApp;
    }, [verifyApp]);

    return null;
  };

  render(
    createElement(
      StoreContext.Provider,
      { value: store },
      createElement(AppVerifierProvider, null, createElement(Probe)),
    ),
  );

  let verdict: Awaited<ReturnType<NonNullable<typeof verify>>> | undefined;
  await act(async () => {
    verdict = await verify!('atomic:app', 'atomic:drive');
  });

  expect(verdict?.verdict).toBe('unknown');
  expect(verdict && 'message' in verdict && verdict.message).toMatch(
    /Apps run on a server/,
  );
  expect(refused).toEqual([]);
});

it('does not sign the app key hand-over or lookup when the store has no server', async () => {
  const { channel, refused } = host();
  const { store } = await createEmbedStore(channel);

  await expect(
    handOverAppKey(store, { drive: 'd', app: 'a', secret: 's' }),
  ).rejects.toThrow(/no/i);
  await expect(appAgentOf(store, { drive: 'd', app: 'a' })).rejects.toThrow(
    /no/i,
  );
  expect(refused).toEqual([]);
});
