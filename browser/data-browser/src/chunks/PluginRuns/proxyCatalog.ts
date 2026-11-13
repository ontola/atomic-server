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

/** Public platform metadata, never an installable JS module. */
export interface ProxyPlatform {
  id: string;
  name: string;
  description?: string;
  document?: string;
}

/** Validate the versioned service metadata contract without trusting the catalog. */
export function parseProxyAppIndex(raw: unknown): ProxyPlatform[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid proxy app index');
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || !Array.isArray(value.platforms))
    throw new Error('Unsupported proxy app index version');

  const seen = new Set<string>();
  return value.platforms.map((item): ProxyPlatform => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Invalid proxy app index entry');
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !PLATFORM_ID.test(row.id))
      throw new Error('Invalid proxy platform ID');
    if (seen.has(row.id)) throw new Error('Duplicate proxy platform ID');
    seen.add(row.id);
    if (typeof row.name !== 'string' || !row.name.trim())
      throw new Error('Invalid proxy platform name');
    if (row.description !== undefined && typeof row.description !== 'string')
      throw new Error('Invalid proxy platform description');
    if (row.document !== undefined && row.document !== `/catalog/${row.id}.yaml`)
      throw new Error('Invalid proxy platform document path');

    return {
      id: row.id,
      name: row.name,
      ...(typeof row.description === 'string'
        ? { description: row.description }
        : {}),
      ...(typeof row.document === 'string' ? { document: row.document } : {}),
    };
  });
}

/**
 * New proxies expose structured metadata; existing proxies only expose
 * the original string[] GET /catalog. A genuine 404 means an old proxy,
 * while other errors are surfaced rather than interpreted as zero apps.
 */
export async function fetchProxyAppIndex(
  origin: string,
  options: { signal?: AbortSignal; transport?: typeof fetch } = {},
): Promise<ProxyPlatform[]> {
  const transport = options.transport ?? fetch;
  const response = await transport(new URL('/catalog/apps', origin).href, {
    signal: options.signal,
    credentials: 'omit',
    redirect: 'error',
  });
  if (response.status === 404) {
    const platforms = await fetchProxyPlatforms(origin, options);
    return platforms.map(id => ({ id, name: id.replaceAll('-', ' ') }));
  }
  if (!response.ok) {
    throw new Error(`Could not load proxy app index (HTTP ${response.status})`);
  }

  return parseProxyAppIndex(await response.json());
}

export type ProxyCatalogState =
  | { status: 'loading'; origin: string }
  | {
      status: 'ready';
      origin: string;
      platforms: string[];
      entries: ProxyPlatform[];
    }
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

    void fetchProxyAppIndex(origin, { signal: controller.signal })
      .then(entries => {
        if (!controller.signal.aborted) {
          setState({
            status: 'ready',
            origin,
            entries,
            platforms: entries.map(entry => entry.id),
          });
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
