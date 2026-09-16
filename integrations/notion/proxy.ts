// @wc-ignore-file
import { uuid, parse, manifest } from './model';
import type {
  ExternalIntent,
  ExternalReceipt,
} from '../../browser/lib/src/plugin-connection';

export type ProxyRequest = (
  path: string,
  init?: { method?: string; body?: string },
) => Promise<ExternalReceipt>;

/** Provider paths only; proxy owns bearer authorization and the declared API version. */
export function proxyOperation(
  dataSource: string,
  request: ProxyRequest,
  effect: 'read' | 'write',
) {
  const declarations = manifest(dataSource).operations;
  return async (intent: ExternalIntent) => {
    const operation = declarations.find(
      o =>
        o.id === intent.operation &&
        o.effect === effect &&
        o.method === intent.method,
    );
    const url = new URL(intent.url);
    if (!operation || url.username || url.password || url.hash)
      throw new Error('Notion operation is not declared');
    const template = new URL(operation.url);
    const segments = url.pathname.split('/');
    const expected = template.pathname.split('/');
    if (
      url.origin !== template.origin ||
      segments.length !== expected.length ||
      expected.some((part, i) =>
        part === '%7Buuid%7D' || part === '{uuid}'
          ? (() => {
              try {
                return uuid(segments[i]) !== segments[i];
              } catch {
                return true;
              }
            })()
          : part !== segments[i],
      )
    )
      throw new Error('Notion operation escaped its declared endpoint');
    return request(url.pathname + url.search, {
      method: intent.method,
      body: intent.body,
    });
  };
}

export async function discoverDatabases(
  request: ProxyRequest,
  query = '',
  cursor?: string,
) {
  if (query.length > 256 || (cursor?.length ?? 0) > 1024)
    throw new Error('Search is too long');
  const data = parse(
    await request('/v1/search', {
      method: 'POST',
      body: JSON.stringify({
        filter: { value: 'data_source', property: 'object' },
        page_size: 50,
        query,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    }),
  );
  if (
    !Array.isArray(data.results) ||
    typeof data.has_more !== 'boolean' ||
    (data.has_more &&
      (typeof data.next_cursor !== 'string' ||
        !data.next_cursor ||
        data.next_cursor === cursor))
  )
    throw new Error('Invalid Notion search pagination');
  return {
    results: data.results
      .filter((r: any) => r.object === 'data_source')
      .map((r: any) => ({
        id: uuid(r.id),
        name: (r.title ?? [])
          .map((t: any) => t.plain_text ?? t.text?.content ?? '')
          .join(''),
        icon: r.icon?.emoji ?? '📓',
      })) as { id: string; name: string; icon: string }[],
    cursor: data.has_more ? (data.next_cursor as string) : undefined,
  };
}
