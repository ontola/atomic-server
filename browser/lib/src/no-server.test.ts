import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from './agent.js';
import {
  NativeClientDb,
  NativeCryptoProvider,
  type NativeChannel,
} from './client-db.native.js';
import type { ClientDbWorker } from './client-db.js';
import { isNotFound, NOT_IN_HOST_STORE_MESSAGE } from './error.js';
import { createApp } from './plugin-app.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { Store } from './store.js';

const AGENT = 'atomic:agent:pZyZYvKoOcwczHXJoYvYctgrHXn2pZ7qfeWMyoUfQ_8';
const DRIVE =
  'atomic:50cViRzEn58gVUYWYypS4CRIFwx4AvFVtNjxLMCc5tg4p0DLZmnD2YV_-jB1lEYVdU2mZ0T6eImwRVPhAiA4Ag';

/** The drive a fresh identity gets, as the Rust host answers it. */
const driveJsonAd = JSON.stringify({
  '@id': DRIVE,
  [core.properties.isA]: [server.classes.drive],
  [core.properties.name]: "Tester's Drive",
  [core.properties.description]: 'Your private drive.',
  [core.properties.read]: [AGENT],
  [core.properties.write]: [AGENT],
});

/**
 * The Flutter app's embedded renderer: the page runs in a web view (a
 * browser: `window`, `document.cookie`), and a host app holds the store and
 * the agent's key. The host signs commits of its agent and nothing else, as
 * `atomic_lib::host::embed` does; reading makes no commit, so here every
 * signature is refused, as that host refused an auth cookie or a request.
 */
async function embeddedPage(opts: { noServer: boolean; agent?: Agent }) {
  const refused: string[] = [];
  const queries: unknown[] = [];
  const stored = new Map<string, string>([[DRIVE, driveJsonAd]]);
  const channel: NativeChannel = {
    async call(method, args) {
      switch (method) {
        case 'init':
          return true;

        case 'sign':
          refused.push(args[0] as string);
          throw new Error('only commits are signed');

        case 'getResourcesWithSnapshots':
          return (args[0] as string[]).map(s => ({
            jsonAd: s === DRIVE ? driveJsonAd : null,
            snapshot: null,
          }));
        case 'getResource':
          return args[0] === DRIVE ? driveJsonAd : null;
        case 'query':
          queries.push(args[0]);

          return { subjects: [], resources: [], count: 0 };
        case 'outboxEntries':
          return [];
        default:
          return null;
      }
    },
  };
  const db = new NativeClientDb(channel);
  const store = new Store({
    serverUrl: 'https://embed.invalid',
    connect: false,
    noServer: opts.noServer,
    agent: opts.agent ?? new Agent(new NativeCryptoProvider(channel), AGENT),
    commitTransport: db.commitTransport,
  });
  store.setClientDb(db as unknown as ClientDbWorker);
  await db.waitForInit();
  const fetch = vi.fn(async () => {
    throw new Error('test: no network in the embed');
  });
  store.injectFetch(fetch);

  return { store, refused, fetch, queries, stored };
}

const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, document: g.document, location: g.location };

beforeEach(() => {
  // A web view: `hasBrowserAPI()` is true, so the store would make cookies.
  g.window = globalThis;
  g.document = { cookie: '' };
  g.location = {
    origin: 'http://127.0.0.1:47831',
    protocol: 'http:',
    hostname: '127.0.0.1',
  };
  g.addEventListener ??= () => undefined;
  g.removeEventListener ??= () => undefined;
});

afterEach(() => {
  g.window = saved.window;
  g.document = saved.document;
  g.location = saved.location;
  vi.restoreAllMocks();
});

describe('a store with no server (the embedded renderer)', () => {
  it('opens the fresh drive and keeps it when a view asks the server again', async () => {
    const { store, refused, fetch } = await embeddedPage({ noServer: true });

    const drive = await store.getResource(DRIVE);
    expect(drive.error).toBeUndefined();
    expect(drive.get(core.properties.name)).toBe("Tester's Drive");

    // What the drive page's plugin lookup does after its first pass: "only
    // the server gets to say no ontology". It used to sign an HTTP request
    // through the host, which refused, and that error replaced the drive:
    // the page showed the raw subject and "Empty".
    const again = await store.fetchResourceFromServer(DRIVE);
    expect(again.error).toBeUndefined();
    expect(store.getResourceLoading(DRIVE).error).toBeUndefined();
    expect(store.getResourceLoading(DRIVE).get(core.properties.name)).toBe(
      "Tester's Drive",
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(refused).toEqual([]);
  });

  it('makes no auth cookie: nothing but commits is signed', async () => {
    const { store, refused } = await embeddedPage({ noServer: true });
    await new Promise(r => setTimeout(r, 20));

    expect(refused).toEqual([]);
    expect(g.document).toEqual({ cookie: '' });
    expect(store.getSyncStatus().serverConnected).toBe(false);
  });

  it('says not found for what the host does not have, without asking a server', async () => {
    const { store, fetch } = await embeddedPage({ noServer: true });
    const missing = await store.getResource('did:ad:not-on-this-device');

    expect(isNotFound(missing.error)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('names the subject it could not find', async () => {
    const { store } = await embeddedPage({ noServer: true });
    const subject = 'atomic:not-on-this-device';
    const missing = await store.getResource(subject);

    expect(String(missing.error?.message)).toContain(subject);
    expect(String(missing.error?.message)).toContain(
      NOT_IN_HOST_STORE_MESSAGE.slice(0, -1),
    );
  });

  it('looks up a localId in the host database, not at a /query endpoint', async () => {
    const { store, fetch, queries } = await embeddedPage({ noServer: true });

    await expect(
      store.findByLocalId(DRIVE, DRIVE, 'schema:ontology:x'),
    ).resolves.toBeUndefined();
    expect(queries).toEqual([
      expect.objectContaining({
        drive: DRIVE,
        property: core.properties.localId,
        value: 'schema:ontology:x',
      }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('creates an app', async () => {
    const keys = await Agent.generateKeyPair();
    const agent = await Agent.fromSecret(
      Agent.buildSecret(keys.privateKey, `did:ad:agent:${keys.publicKey}`),
    );
    const { store } = await embeddedPage({ noServer: true, agent });
    const drive = await store.getResource(DRIVE);
    const ontology = await store.createDefaultOntology(drive);
    expect(ontology.error).toBeUndefined();

    const created = await createApp(store as never, {
      drive: DRIVE,
      name: 'Habits',
      source: 'export function view() {}',
    });

    expect(created.app).toBeTruthy();
  });
});
