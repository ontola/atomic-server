// @wc-ignore-file
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AlreadyLinkedError,
  fetchOidcSession,
  linkMessage,
  linkOidcAgent,
  oidcStartUrl,
  parseOidcHash,
} from './oidcClient';

const TICKET = 'abcdefghijklmnopqrstuvwxyz0123456789_-AB';

afterEach(() => vi.unstubAllGlobals());

describe('parseOidcHash', () => {
  it('reads a ticket and a fixed error vocabulary', () => {
    expect(parseOidcHash(`#oidc_ticket=${TICKET}`)).toEqual({
      kind: 'ticket',
      ticket: TICKET,
    });
    expect(parseOidcHash('#oidc_error=policy')).toEqual({
      kind: 'error',
      code: 'policy',
    });
    // Unknown codes never reach the UI as text.
    expect(parseOidcHash('#oidc_error=<script>')).toEqual({
      kind: 'error',
      code: 'provider',
    });
  });

  it('ignores everything else, including malformed tickets', () => {
    expect(parseOidcHash('')).toBeNull();
    expect(parseOidcHash('#section')).toBeNull();
    expect(parseOidcHash('#oidc_ticket=short')).toBeNull();
    expect(parseOidcHash('#oidc_ticket=<b>x</b>')).toBeNull();
  });
});

describe('oidcStartUrl', () => {
  it('encodes the return path and ignores trailing slashes', () => {
    expect(oidcStartUrl('https://a.example/', '/app/oidc?x=1')).toBe(
      'https://a.example/oidc/start?return=%2Fapp%2Foidc%3Fx%3D1',
    );
  });
});

describe('linking', () => {
  it('signs the exact message the server verifies', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const sign = vi.fn(async () => 'SIG');

    await linkOidcAgent('https://s.example', {
      ticket: TICKET,
      agentSubject: 'did:ad:agent:AAA',
      signer: { sign },
      recovery: 'BLOB',
    });

    expect(sign).toHaveBeenCalledWith(linkMessage(TICKET, 'did:ad:agent:AAA'));
    expect(linkMessage(TICKET, 'did:ad:agent:AAA')).toBe(
      `atomic-oidc-link:v1:${TICKET}:did:ad:agent:AAA`,
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://s.example/oidc/link');
    expect(JSON.parse(init.body as string)).toEqual({
      ticket: TICKET,
      agent: 'did:ad:agent:AAA',
      signature: 'SIG',
      recovery: 'BLOB',
      replace: false,
    });
  });

  it('turns 409 into AlreadyLinkedError', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 409 }));

    await expect(
      linkOidcAgent('https://s.example', {
        ticket: TICKET,
        agentSubject: 'did:ad:agent:AAA',
        signer: { sign: async () => 'S' },
        recovery: 'B',
      }),
    ).rejects.toBeInstanceOf(AlreadyLinkedError);
  });
});

describe('fetchOidcSession', () => {
  it('distinguishes linked from unlinked identities', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ linked: false, name: 'Corp' }), {
          status: 200,
        }),
    );
    expect(await fetchOidcSession('https://s.example', TICKET)).toEqual({
      linked: false,
      name: 'Corp',
    });

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            linked: true,
            name: 'Corp',
            agent: 'did:ad:agent:AAA',
            recovery: 'BLOB',
          }),
          { status: 200 },
        ),
    );
    expect(await fetchOidcSession('https://s.example', TICKET)).toMatchObject({
      linked: true,
      agent: 'did:ad:agent:AAA',
    });
  });

  it('reports an expired ticket', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 400 }));

    await expect(fetchOidcSession('https://s.example', TICKET)).rejects.toThrow(
      /expired/,
    );
  });
});
