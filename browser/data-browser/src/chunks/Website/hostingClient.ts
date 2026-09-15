// @wc-ignore-file
import { signRequest, errorMessageFromResponse, type Store } from '@tomic/lib';

export interface WebsitePackage {
  version: 1;
  files: Record<string, string>;
}
export interface HostingStatus {
  url: string;
  deployment?: string;
  state: null | {
    project: string;
    drive: string;
    revision: number;
    active: string | null;
    deployments: string[];
    history: { deployment: string | null; actor: string; at: number }[];
  };
}
/** Sign only the configured Atomic API origin. Never give a website the agent or its keys. */
export async function hostingRequest<T>(
  store: Store,
  project: string,
  path = '',
  body?: unknown,
): Promise<T> {
  const agent = store.getAgent();
  const drive = store.getDrive();
  if (!agent || !drive) throw new Error('Sign in to your drive to publish.');
  const url = new URL(`/website-hosting${path}`, store.getServerUrl());
  url.searchParams.set('project', project);
  url.searchParams.set('drive', drive);
  const headers = await signRequest(url.toString(), agent, {});
  const result = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    credentials: 'omit',
    redirect: 'error',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!result.ok)
    throw new Error(
      errorMessageFromResponse(await result.text(), result.status),
    );

  return result.json() as Promise<T>;
}
