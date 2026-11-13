/**
 * Public platform discovery from the configured integration proxy.
 *
 * Keep this separate from pluginCatalog.ts: proxy platforms are declarative
 * API descriptions, NOT executable catalog app modules.
 *
 * The existing proxy contract is GET /catalog -> string[]. A future structured
 * metadata endpoint can add display names and safe icons without changing it.
 */
import { useEffect, useState } from 'react';
import { useIntegrationProxy } from '@helpers/integrationProxy';

const PLATFORM_ID = /^[a-z0-9-]{1,80}$/;

export function parseProxyPlatforms(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid integration proxy catalog: expected an array');
  }

  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== 'string' || !PLATFORM_ID.test(item)) {
      throw new Error('Invalid integration proxy catalog platform ID');
    }
    seen.add(item);
  }

  return [...seen];
}

export async function fetchProxyPlatforms(
  origin: string,
  options: { signal?: AbortSignal; transport?: typeof fetch } = {},
): Promise<string[]> {
  const response = await (options.transport ?? fetch)(
    new URL('/catalog', origin).href,
    {
      signal: options.signal,
      credentials: 'omit',
      redirect: 'error',
    },
  );

  if (!response.ok) {
    throw new Error(`Could not load integration proxy catalog (HTTP ${response.status})`);
  }

  return parseProxyPlatforms(await response.json());
}

export type ProxyCatalogState =
  | { status: 'loading'; origin: string }
  | { status: 'ready'; origin: string; platforms: string[] }
  | { status: 'error'; origin: string; message: string };

/**
 * React-side discovery, always tied to the current proxy setting.
 * An unavailable proxy is an explicit error, never an empty catalog.
 */
export function useProxyCatalog(): ProxyCatalogState {
  const origin = useIntegrationProxy();
  const [state, setState] = useState<ProxyCatalogState>({
    status: 'loading',
    origin,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', origin });

    void fetchProxyPlatforms(origin, { signal: controller.signal })
      .then(platforms => {
        if (!controller.signal.aborted) {
          setState({ status: 'ready', origin, platforms });
        }
      })
      .catch(reason => {
        if (!controller.signal.aborted) {
          setState({ status: 'error', origin, message: String(reason) });
        }
      });

    return () => controller.abort();
  }, [origin]);

  return state.origin === origin ? state : { status: 'loading', origin };
}
