import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type ServerHandle } from './server-fixture.js';
import { Store } from '../src/store.js';
import { Agent } from '../src/agent.js';
import { grantAgent } from '../src/agent-grants.js';
import { signRequest } from '../src/authentication.js';
import { server } from '../src/ontologies/server.js';
import { core } from '../src/ontologies/core.js';

/**
 * The hosted MCP endpoint against a live atomic-server: dynamic client
 * registration, approval by a signed-in person, PKCE code exchange, and then
 * the read-only tools as the issued agent. Real Store and fetch, no mocks.
 *
 * Spawns its own atomic-server (see `server-fixture.ts`).
 */
let SERVER = '';
const REDIRECT = 'http://localhost:7777/callback';
const b64url = (bytes: Buffer) => bytes.toString('base64url');

async function newDrive(store: Store, did: string, name: string) {
  const drive = await store.newResource({
    isA: server.classes.drive,
    noParent: true,
    propVals: {
      [core.properties.name]: name,
      [core.properties.write]: [did],
      [core.properties.read]: [did],
    },
  });
  await drive.save();

  return drive;
}

async function signedPost(store: Store, path: string, body: object) {
  const url = new URL(path, SERVER).href;
  const payload = JSON.stringify(body);
  const headers = await signRequest(
    url,
    store.getAgent()!,
    {},
    { method: 'POST', body: payload },
  );

  return fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: payload,
  });
}

async function rpc(token: string, method: string, params?: object, id = 1) {
  const response = await fetch(`${SERVER}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });

  return { response, json: (await response.json()) as any };
}

const tool = async (token: string, name: string, args: object) => {
  const { json } = await rpc(token, 'tools/call', { name, arguments: args });
  const text = json.result.content[0].text as string;

  return { text, isError: json.result.isError as boolean };
};

describe('hosted MCP against a live server', () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await startServer();
    SERVER = handle.serverUrl;
  }, 120_000);

  afterAll(async () => {
    await handle?.stop();
  });

  it('approves a client and lets it read only what was shared', async () => {
    const agent = await Agent.fromSecret(handle.agentSecret);
    const did = agent.subject;
    const store = new Store({ serverUrl: SERVER, agent });
    store.setServerConnected(true);
    const shared = await newDrive(store, did, 'Shared with the client');
    const kept = await newDrive(store, did, 'Kept private');

    // Discovery and registration.
    const meta = await (
      await fetch(`${SERVER}/.well-known/oauth-authorization-server`)
    ).json();
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);

    const registered = await fetch(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test client',
        redirect_uris: [REDIRECT],
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id: clientId } = (await registered.json()) as {
      client_id: string;
    };

    // Not a registered redirect: refused, never redirected to.
    const bad = await fetch(
      `${SERVER}/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'https://evil.example/cb',
        code_challenge: 'x',
        code_challenge_method: 'S256',
      })}`,
      { redirect: 'manual' },
    );
    expect(bad.status).toBe(400);

    // The browser is sent to the consent page in the app.
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const authorize = await fetch(
      `${SERVER}/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'abc',
      })}`,
      { redirect: 'manual' },
    );
    expect(authorize.status).toBe(302);
    const consent = new URL(authorize.headers.get('location')!);
    expect(consent.pathname).toBe('/app/authorize-mcp');
    expect(consent.searchParams.get('client_name')).toBe('Test client');

    // Nobody signed in cannot approve.
    const anonymous = await fetch(`${SERVER}/oauth/agent`, {
      method: 'POST',
      body: JSON.stringify({ client_id: clientId }),
    });
    expect(anonymous.status).toBeGreaterThanOrEqual(400);

    // The person approves: an issued agent, rights on one drive, then the code.
    const issued = (await (
      await signedPost(store, '/oauth/agent', { client_id: clientId })
    ).json()) as { agent: string; nonce: string };
    await grantAgent(store, issued.agent, [shared.subject], false);

    const approved = await signedPost(store, '/oauth/approve', {
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      nonce: issued.nonce,
      state: 'abc',
    });
    expect(approved.status).toBe(200);
    const back = new URL(
      ((await approved.json()) as { redirect_url: string }).redirect_url,
    );
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('abc');
    const code = back.searchParams.get('code')!;

    // The person sees the client's name, not a key, under Connected apps.
    const named = await store.getResource(issued.agent);
    expect(named.get(core.properties.name)).toBe('Test client');

    const exchange = (body: Record<string, string>) =>
      fetch(`${SERVER}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          redirect_uri: REDIRECT,
          code,
          ...body,
        }),
      });

    // PKCE binds the code to whoever started the flow.
    expect((await exchange({ code_verifier: 'wrong' })).status).toBe(400);
    const tokens = (await (
      await exchange({ code_verifier: verifier })
    ).json()) as { access_token: string; refresh_token: string };
    expect(tokens.access_token).toBeTruthy();
    // A code works once.
    expect((await exchange({ code_verifier: verifier })).status).toBe(400);

    // The endpoint: protocol basics.
    const anonymousMcp = await fetch(`${SERVER}/mcp`, {
      method: 'POST',
      body: '{}',
    });
    expect(anonymousMcp.status).toBe(401);
    expect(anonymousMcp.headers.get('www-authenticate')).toContain(
      'oauth-protected-resource',
    );

    const token = tokens.access_token;
    const init = await rpc(token, 'initialize', {
      protocolVersion: '2025-06-18',
    });
    expect(init.json.result.serverInfo.name).toBe('atomic');
    const list = await rpc(token, 'tools/list');
    expect(list.json.result.tools.map((t: any) => t.name)).toEqual([
      'list_drives',
      'get_resource',
      'search',
    ]);

    // Reads: what was shared, and nothing else.
    const drives = await tool(token, 'list_drives', {});
    expect(drives.text).toContain(shared.subject);
    expect(drives.text).not.toContain(kept.subject);

    const read = await tool(token, 'get_resource', {
      subjects: [shared.subject, kept.subject],
    });
    const parsed = JSON.parse(read.text);
    expect(parsed[shared.subject].name).toBe('Shared with the client');
    expect(String(parsed[kept.subject])).toMatch(/^Error:/);

    // A refresh token gives a working access token again.
    const refreshed = (await (
      await fetch(`${SERVER}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
        }),
      })
    ).json()) as { access_token: string };
    expect(
      (await tool(refreshed.access_token, 'list_drives', {})).text,
    ).toContain(shared.subject);

    // Revoking is taking the issued agent off the drive.
    await shared.set(core.properties.read, [did]);
    await shared.save();
    const after = await tool(token, 'get_resource', {
      subjects: [shared.subject],
    });
    expect(String(JSON.parse(after.text)[shared.subject])).toMatch(/^Error:/);

    // Tokens are not interchangeable: a refresh token is no access token.
    expect((await rpc(tokens.refresh_token, 'ping')).response.status).toBe(401);
  }, 60_000);
});
