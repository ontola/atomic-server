// @wc-ignore-file
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '@tomic/react';
import {
  grantRowAccess,
  onRowGrantChange,
  revokeRowAccess,
  rowAccessQuestion,
  type RowGrant,
} from './rowGrant';

vi.mock('@tomic/react', async () => {
  const actual =
    await vi.importActual<typeof import('@tomic/react')>('@tomic/react');

  return { ...actual, signRequest: async () => ({}) };
});

const TABLE = 'did:ad:transactions';
const VIEW = 'did:ad:money-tab';
const APP = 'did:ad:money';
const DRIVE = 'did:ad:drive';

const GRANT: RowGrant = {
  id: 'g1',
  drive: DRIVE,
  app: APP,
  appAgent: 'did:ad:agent:app',
  table: TABLE,
  view: VIEW,
  grantedBy: 'did:ad:agent:me',
  grantedAt: 1790000000000,
  via: 'request',
};

let requests: Array<{ url: string; method: string; body?: unknown }>;
let live: RowGrant | null;

beforeEach(() => {
  requests = [];
  live = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      requests.push({ url, method: init.method ?? 'GET', body });

      const answer =
        init.method === 'POST'
          ? body.op === 'grant'
            ? { ...GRANT, via: body.via }
            : { ...GRANT, revokedVia: body.via }
          : { grant: live, history: live ? [live] : [] };

      return {
        ok: true,
        json: async () => answer,
        text: async () => '',
      } as unknown as Response;
    }),
  );
});

function fakeStore(canWrite: boolean) {
  return {
    getAgent: () => ({ subject: 'did:ad:agent:me' }),
    getServerUrl: () => 'https://node.test',
    getResource: async () => ({ canWrite: async () => [canWrite] }),
  } as unknown as Store;
}

const name = async () => 'Money';

describe("an app's requestRowAccess (#1740)", () => {
  it('is refused at once when the app is not a table view here', async () => {
    expect(
      await rowAccessQuestion(
        fakeStore(true),
        { app: APP, drive: DRIVE },
        name,
      ),
    ).toEqual({
      ask: false,
      result: {
        status: 'denied',
        reason: 'This app is not shown as a table view here',
      },
    });
    expect(requests).toEqual([]);
  });

  it('is refused at once for someone who cannot edit the table', async () => {
    const answer = await rowAccessQuestion(
      fakeStore(false),
      { app: APP, drive: DRIVE, table: TABLE, view: VIEW },
      name,
    );

    expect(answer).toMatchObject({ ask: false, result: { status: 'denied' } });
    expect(requests).toEqual([]);
  });

  it('is answered at once when the grant already exists', async () => {
    live = GRANT;

    expect(
      await rowAccessQuestion(
        fakeStore(true),
        { app: APP, drive: DRIVE, table: TABLE, view: VIEW },
        name,
      ),
    ).toEqual({ ask: false, result: { status: 'granted' } });
  });

  it('asks the person, naming the app, otherwise', async () => {
    expect(
      await rowAccessQuestion(
        fakeStore(true),
        { app: APP, drive: DRIVE, table: TABLE, view: VIEW },
        name,
      ),
    ).toEqual({ ask: true, appName: 'Money' });
  });

  it('records the confirmation as a grant by that gesture, tied to the tab', async () => {
    const changed = vi.fn();
    const stop = onRowGrantChange(changed);

    const grant = await grantRowAccess(fakeStore(true), {
      drive: DRIVE,
      table: TABLE,
      app: APP,
      view: VIEW,
      via: 'request',
    });
    stop();

    expect(requests).toEqual([
      {
        url: 'https://node.test/app-row-grant',
        method: 'POST',
        body: {
          op: 'grant',
          drive: DRIVE,
          table: TABLE,
          app: APP,
          view: VIEW,
          via: 'request',
        },
      },
    ]);
    // Who granted it is the request's signer, recorded by the server; the
    // page never sends a `grantedBy` of its own.
    expect(requests[0].body).not.toHaveProperty('grantedBy');
    expect(grant.via).toBe('request');
    expect(changed).toHaveBeenCalledOnce();
  });

  it('revokes from the menu', async () => {
    const revoked = await revokeRowAccess(fakeStore(true), {
      drive: DRIVE,
      table: TABLE,
      app: APP,
    });

    expect(requests[0].body).toEqual({
      op: 'revoke',
      via: 'menu',
      drive: DRIVE,
      table: TABLE,
      app: APP,
    });
    expect(revoked?.revokedVia).toBe('menu');
  });
});
