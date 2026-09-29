import {
  errorMessageFromResponse,
  signRequest,
  type Store,
} from '@tomic/react';

/**
 * The person's side of approving an MCP client at a node's OAuth
 * authorization endpoint (`/oauth/authorize`, see planning/mcp-endpoint.md).
 * Both calls are signed as the person, like any write. The node never signs
 * as them: it only mints an identity for the client, and what that identity
 * may reach is what the person grants it here.
 */

async function signedPost<T>(
  store: Store,
  server: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const agent = store.getAgent();

  if (!agent) {
    throw new Error('Sign in to approve an app');
  }

  const url = new URL(path, server).href;
  const payload = JSON.stringify(body);
  const headers = await signRequest(
    url,
    agent,
    {},
    { method: 'POST', body: payload },
  );
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: payload,
  });

  if (!response.ok) {
    throw new Error(
      errorMessageFromResponse(await response.text(), response.status),
    );
  }

  return (await response.json()) as T;
}

/** A fresh identity for this client, to give rights to before approving. */
export function requestIssuedAgent(
  store: Store,
  server: string,
  clientId: string,
): Promise<{ agent: string; nonce: string }> {
  return signedPost(store, server, '/oauth/agent', { client_id: clientId });
}

/** Where to send the browser back to the client, carrying its authorization code. */
export async function approveAuthorization(
  store: Store,
  server: string,
  request: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    nonce: string;
    state?: string;
  },
): Promise<string> {
  const { redirect_url } = await signedPost<{ redirect_url: string }>(
    store,
    server,
    '/oauth/approve',
    {
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      code_challenge: request.codeChallenge,
      nonce: request.nonce,
      state: request.state,
    },
  );

  return redirect_url;
}
