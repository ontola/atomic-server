/**
 * ontola/atomic-server#1838, against a real atomic-server: a signed fetch of
 * an external class through the server's `/path` proxy is accepted and
 * returns the external resource, and the Store falls back to that proxy when
 * the vocabulary host fails.
 *
 * The external origin is a local stub with GitHub Pages' behaviour: GET
 * answers with `access-control-allow-origin: *` and a preflight gets 405.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { startServer, type ServerHandle } from './server-fixture.js';
import { Agent } from '../src/agent.js';
import { signRequest } from '../src/authentication.js';
import { Client, proxyPathUrl } from '../src/client.js';
import { core } from '../src/ontologies/core.js';
import { Store } from '../src/store.js';

interface Stub {
  origin: string;
  hits: (path: string) => number;
  close: () => Promise<void>;
}

/** A class document the way the shared ontology publishes one. */
function classDoc(subject: string, name: string) {
  return {
    '@id': subject,
    [core.properties.isA]: [core.classes.class],
    [core.properties.shortname]: name.toLowerCase(),
    [core.properties.description]: `${name}, served by a stub vocabulary host.`,
  };
}

async function startStub(): Promise<Stub> {
  const hits = new Map<string, number>();
  let origin = '';
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/';
    const n = (hits.get(path) ?? 0) + 1;
    hits.set(path, n);

    if (req.method === 'OPTIONS') {
      // What GitHub Pages answers a preflight with.
      res.writeHead(405).end();

      return;
    }

    // Fails the first request only: the browser's direct attempt. The
    // server's own fetch, behind the proxy, then succeeds.
    if (path.startsWith('/flaky/') && n === 1) {
      res.writeHead(503).end('Pages is down');

      return;
    }

    res
      .writeHead(200, {
        'content-type': 'application/octet-stream',
        'access-control-allow-origin': '*',
      })
      .end(JSON.stringify(classDoc(`${origin}${path}`, 'Draft')));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    hits: path => hits.get(path) ?? 0,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

describe('fetching external vocabulary through the /path proxy', () => {
  let server: ServerHandle;
  let stub: Stub;
  let agent: Agent;

  beforeAll(async () => {
    [server, stub] = await Promise.all([startServer(), startStub()]);
    agent = await Agent.fromSecret(server.agentSecret);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([server?.stop(), stub?.close()]);
  });

  it('accepts a proxy request signed over the proxy URL and returns the external class', async () => {
    const term = `${stub.origin}/ontology/classes/draft`;
    const client = new Client();

    const { resource } = await client.fetchResourceHTTP(term, {
      from: server.serverUrl,
      signInfo: { agent, serverURL: server.serverUrl },
      serverURL: server.serverUrl,
    });

    expect(resource.error).toBeUndefined();
    expect(resource.subject).toBe(term);
    expect(resource.get(core.properties.shortname)).toBe('draft');
    // The server fetched it from the external origin.
    expect(stub.hits('/ontology/classes/draft')).toBeGreaterThan(0);
  });

  it('refuses a proxy request signed over the external subject', async () => {
    const term = `${stub.origin}/ontology/classes/draft`;
    const headers = await signRequest(term, agent, {
      Accept: 'application/ad+json',
    });

    const res = await fetch(proxyPathUrl(server.serverUrl, term), { headers });

    expect(res.status).toBe(401);
  });

  it('falls back to the proxy when the vocabulary host fails', async () => {
    const term = `${stub.origin}/flaky/classes/draft`;
    const store = new Store({
      serverUrl: server.serverUrl,
      agent,
      connect: false,
    });

    const resource = await store.fetchResourceFromServer(term);

    expect(resource.error).toBeUndefined();
    expect(resource.subject).toBe(term);
    expect(resource.get(core.properties.shortname)).toBe('draft');
    // Once from the store directly (503), once from the server.
    expect(stub.hits('/flaky/classes/draft')).toBe(2);
  });
});
