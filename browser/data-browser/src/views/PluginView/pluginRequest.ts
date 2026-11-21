import { signRequest, type Store } from '@tomic/react';

/** Private plugin assets and the installation list use the current agent. */
export async function pluginRequest(
  store: Store,
  url: string,
  signal?: AbortSignal,
): Promise<Response> {
  const agent = store.getAgent();
  const headers = agent ? await signRequest(url, agent, {}) : {};
  const response = await fetch(url, {
    headers,
    credentials: 'same-origin',
    signal,
  });

  if (!response.ok) {
    throw new Error(
      /* @wc-ignore */ `Plugin request failed (HTTP ${response.status})`,
    );
  }

  return response;
}
