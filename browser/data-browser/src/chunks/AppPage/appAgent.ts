import {
  errorMessageFromResponse,
  server,
  signRequest,
  type Store,
} from '@tomic/react';

/**
 * Hands an app's freshly minted key to the node, once.
 *
 * The node needs it because an app that imports at 3am has nobody to ask for
 * a credential — whatever signs its writes has to be openable unattended. It
 * is posted rather than stored in a resource: a resource syncs, and the drive
 * it would live on can later be shared or replicated somewhere less trusted.
 *
 * Nothing keeps a copy here. If this fails the app still exists and still
 * works when you are present; what it cannot do is write as itself, which is
 * what the caller is told.
 */
export async function handOverAppKey(
  store: Store,
  options: { drive: string; app: string; secret: string },
): Promise<void> {
  const agent = store.getAgent();

  if (!agent) throw new Error('Sign in to give an app its key');

  const url = `${store.getServerUrl()}/app-agent`;
  const headers = await signRequest(url, agent, {});

  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      drive: options.drive,
      app: options.app,
      secret: options.secret,
    }),
  });

  if (!response.ok) {
    throw new Error(
      errorMessageFromResponse(await response.text(), response.status),
    );
  }
}

/**
 * The agent integration-proxy delegations and frame capabilities name for an
 * app (ontola/atomic-plugins#54).
 *
 * An Installation records its own keyless app id (`integrationAppAgent`,
 * #1700 answer 1), which is the same on every node; each node's agent is only
 * a runtime of it. That id wins. Asking the node (`GET /app-agent`) would
 * name this node's runtime agent instead, so a delegation would reach one
 * node and not the others. `createApp` apps, and Installations from before
 * app ids, have no such property: for them the node that holds the app's
 * key reports it.
 */
export async function appAgentOf(
  store: Store,
  options: { drive: string; app: string },
): Promise<string> {
  const agent = store.getAgent();

  if (!agent) throw new Error('Sign in to use integration connections.');

  const recorded = (await store.getResource(options.app)).get(
    server.properties.integrationAppAgent,
  );

  if (typeof recorded === 'string' && recorded) return recorded;

  const url = new URL('/app-agent', store.getServerUrl());
  url.searchParams.set('drive', options.drive);
  url.searchParams.set('app', options.app);
  const headers = await signRequest(url.href, agent, {});
  const response = await fetch(url.href, { headers });

  if (!response.ok) {
    throw new Error(
      errorMessageFromResponse(await response.text(), response.status),
    );
  }

  const info = (await response.json()) as { agent?: unknown } | null;

  if (typeof info?.agent !== 'string' || !info.agent) {
    throw new Error(
      'This app has no identity of its own yet, so it cannot be given an integration connection.',
    );
  }

  return info.agent;
}
