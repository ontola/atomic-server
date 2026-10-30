import {
  errorMessageFromResponse,
  signRequest,
  type Store,
} from '@tomic/react';

export { handOverAppKey } from './appKeyHandover';

/**
 * The agent an app acts as (`atomic:agent:…` or the older `did:ad:agent:…`),
 * as the node that holds its key reports it. Integration-proxy connections
 * are delegated to this agent (ontola/atomic-plugins#54).
 *
 * Only apps made with `createApp` have one today. An installed catalog plugin
 * gets its own identity in a later step (#54 decision 2); until then it cannot
 * be given a proxy connection, and this says so rather than guessing.
 */
export async function appAgentOf(
  store: Store,
  options: { drive: string; app: string },
): Promise<string> {
  const agent = store.getAgent();

  if (!agent) throw new Error('Sign in to use integration connections.');

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
