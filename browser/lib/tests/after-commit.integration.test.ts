/**
 * ontola/atomic-server#1851, against a real atomic-server started with
 * `--plugin-after-commit`: an app shown as a table's view, added read-only,
 * follows a table of its row class; a row saved through `store.save` reaches its
 * `afterCommit` hook in the background, and the edit the hook proposes waits
 * on the table for review (there is no grant).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';

import { startServer, type ServerHandle } from './server-fixture.js';
import { Agent } from '../src/agent.js';
import { signRequest, signedRequestInit } from '../src/authentication.js';
import { core } from '../src/ontologies/core.js';
import { dataBrowser } from '../src/ontologies/dataBrowser.js';
import { server as serverOntology } from '../src/ontologies/server.js';
import { createApp } from '../src/plugin-app.js';
import { Store } from '../src/store.js';

const SOURCE = `
export const manifest = {
  schemaVersion: 2,
  world: 'extension',
  namespace: 'test',
  name: 'follower',
  entrypoints: { run: true, afterCommit: true },
};
export function view() {}
export function run() { return { intents: [] }; }
export async function afterCommit(ctx) {
  return {
    intents: ctx.event.changes
      .filter(c => c.kind !== 'deleted')
      .map(c => ({
        op: 'set',
        subject: c.subject,
        set: { '${core.properties.name}': 'seen: ' + c.subject },
      })),
  };
}
`;

const VIEW = 'https://atomicdata.dev/classes/View';
const VIEW_KIND = 'https://atomicdata.dev/properties/view-kind';
const TABLE_VIEWS = 'https://atomicdata.dev/properties/table-views';

describe('afterCommit against a real server', () => {
  let server: ServerHandle;
  let agent: Agent;
  let store: Store;

  beforeAll(async () => {
    process.env.ATOMIC_PLUGIN_AFTER_COMMIT = 'true';
    server = await startServer();
    delete process.env.ATOMIC_PLUGIN_AFTER_COMMIT;
    agent = await Agent.fromSecret(server.agentSecret);
    store = new Store({ serverUrl: server.serverUrl, agent });
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  const post = async (path: string, body: object) => {
    const url = `${server.serverUrl}${path}`;
    const response = await fetch(
      url,
      await signedRequestInit(url, agent, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    expect(response.ok, `${path}: ${text}`).toBe(true);

    return JSON.parse(text);
  };

  it('delivers a saved row to the hook, whose edit waits for review', async () => {
    const drive = (await store.createDrive('After commit test')).subject;
    // The plugin vocabulary goes in the drive's default ontology.
    const ontology = await store.newResource({
      parent: drive,
      isA: [core.classes.ontology],
      propVals: {
        [core.properties.shortname]: 'test-plugins',
        [core.properties.description]: 'Plugin vocabulary for this test',
        [core.properties.classes]: [],
        [core.properties.properties]: [],
      },
    });
    await ontology.save();
    const driveResource = await store.getResource(drive);
    await driveResource.set(
      serverOntology.properties.defaultOntology,
      ontology.subject,
    );
    await driveResource.save();

    const created = await createApp(store, {
      drive,
      name: 'Follower',
      source: SOURCE,
    });
    await post('/app-agent', {
      drive,
      app: created.app,
      secret: created.secret,
    });

    // A table of the app's row class outside the app, so its rows are not
    // the app's own and a background edit has to wait for review.
    const shared = await store.newResource({
      parent: drive,
      isA: [dataBrowser.classes.table],
      propVals: {
        [core.properties.name]: 'Shared',
        [core.properties.classtype]: created.rowClass,
      },
    });
    await shared.save();

    const view = await store.newResource({
      parent: shared.subject,
      isA: [VIEW],
      propVals: {
        [core.properties.name]: 'Follower',
        [VIEW_KIND]: created.app,
      },
    });
    await view.save();
    const table = await store.getResource(shared.subject);
    await table.set(TABLE_VIEWS, [view.subject]);
    await table.save();

    // `follow` answers `null` until the server can read the app's package
    // (the saves above can still be landing under CI load), and is
    // idempotent, so it is asked again until it answers or a deadline passes.
    const follow = () =>
      post('/app-row-grant', {
        op: 'follow',
        drive,
        table: shared.subject,
        app: created.app,
        view: view.subject,
        via: 'add-view',
      });
    const until = async <T>(
      what: string,
      ask: () => Promise<T>,
      done: (answer: T) => boolean,
      ms = 30_000,
    ): Promise<T> => {
      const deadline = Date.now() + ms;
      let answer = await ask();

      while (!done(answer)) {
        if (Date.now() > deadline)
          throw new Error(`${what}: still ${JSON.stringify(answer)}`);
        await delay(250);
        answer = await ask();
      }

      return answer;
    };
    const followed = await until(
      'follow (null means: no --plugin-after-commit, a server built without the wasm32-wasip2 plugin runtime, or an app that does not declare afterCommit)',
      follow,
      answer => !!answer?.table,
    );
    expect(followed.table).toBeTruthy();

    const status = async () => {
      const url = new URL('/app-after-commit', server.serverUrl);
      url.searchParams.set('drive', drive);
      url.searchParams.set('app', created.app);
      url.searchParams.set('table', shared.subject);
      const headers = await signRequest(url.href, agent, {});

      return (await fetch(url.href, { headers })).json();
    };

    // Let the initial delivery (a full-compare reset) finish first, so the
    // row below is a change of its own.
    await until(
      'the initial delivery',
      status,
      answer => !!answer.subscriptions?.[0]?.lastDeliveredAt,
    );

    const row = await store.newResource({
      parent: shared.subject,
      isA: [created.rowClass],
      propVals: { [core.properties.name]: 'Saved through the store' },
    });
    await row.save();

    const last = await until(
      'the saved row reaching the hook',
      status,
      answer => !!answer.subscriptions?.[0]?.pending,
    );
    const pending = last.subscriptions[0].pending;

    expect(pending?.rows, JSON.stringify(last)).toBe(1);
    expect(pending?.inScope).toBe(true);
  }, 90_000);
});
