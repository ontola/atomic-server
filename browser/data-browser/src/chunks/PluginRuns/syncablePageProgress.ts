import {
  describeCollections,
  parseLinkHeader,
  resolveEffectiveScheme,
  type OpenApiDocument,
  type ReadSelection,
  type TransportRequest,
  type TransportResponse,
} from 'syncables/browser';

const positiveInteger = (value: unknown) => {
  const number =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

  return typeof number === 'number' &&
    Number.isSafeInteger(number) &&
    number > 0
    ? number
    : undefined;
};

/** Totals only apply to a single walk, never to an aggregate of partitions. */
export function syncablePageTotal(
  document: OpenApiDocument,
  selection: ReadSelection,
  request: TransportRequest,
  response: TransportResponse,
): number | undefined {
  if (selection.source.kind !== 'bound' || response.status >= 300) return;

  try {
    const name = selection.source.bound.collection;
    const collection = describeCollections(document).find(
      candidate => candidate.name === name,
    );
    if (!collection) return;
    const operation =
      document.paths[collection.url]?.[
        collection.method === 'POST' ? 'post' : 'get'
      ];
    const scheme =
      operation && resolveEffectiveScheme(document, operation)?.scheme;
    const fields = scheme?.response;
    const header = Object.entries(fields?.headers ?? {}).find(
      ([, field]) => field.role === 'totalPages',
    )?.[0];
    const headerTotal =
      header && positiveInteger(response.headers[header.toLowerCase()]);
    if (headerTotal) return headerTotal;

    const bodyField = Object.entries(fields?.bodyFields ?? {}).find(
      ([, field]) => field.role === 'totalPages',
    )?.[0];

    if (bodyField) {
      let value: unknown = JSON.parse(response.body);
      for (const part of bodyField.split('.'))
        value =
          value && typeof value === 'object' && Object.hasOwn(value, part)
            ? (value as Record<string, unknown>)[part]
            : undefined;
      const bodyTotal = positiveInteger(value);
      if (bodyTotal) return bodyTotal;
    }

    const last = parseLinkHeader(response.headers.link, 'last');
    if (!last) return;
    const lastUrl = new URL(last, request.url);
    if (
      lastUrl.origin !== request.url.origin ||
      lastUrl.pathname !== request.url.pathname
    )
      return;
    const pageField = Object.entries(
      scheme?.request?.queryParameters ?? {},
    ).find(([, field]) => field.role === 'page');
    const page = positiveInteger(
      lastUrl.searchParams.get(pageField?.[0] ?? 'page'),
    );
    if (page !== undefined) return page + (pageField?.[1].start === 0 ? 1 : 0);
  } catch {
    // Optional provider metadata never affects a read or its permissions.
  }
}
