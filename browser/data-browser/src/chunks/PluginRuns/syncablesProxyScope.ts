/**
 * Pure authorization check for the host-side relay of a built-in Syncables
 * iframe's signed proxy request. The frame itself cannot make network calls.
 *
 * We do not give this trusted renderer carte blanche to read every endpoint
 * a GitHub OAuth token permits. Each view gets its one explicit source.
 */
export interface SyncablesProxyScope {
  proxyOrigin: string;
  platform: string;
  kind: string;
  connectionId?: string;
  ownerLogin?: string;
  repoName?: string;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new Error('Invalid proxy path encoding');
  }
}

export function assertSyncablesProxyRead(
  scope: SyncablesProxyScope,
  request: { url?: unknown; method?: unknown },
): void {
  if (request.method !== 'GET') {
    throw new Error('Syncables only permits read-only proxy GET requests');
  }
  if (typeof request.url !== 'string')
    throw new Error('Missing signed proxy URL');
  const target = new URL(request.url);
  if (target.origin !== scope.proxyOrigin || target.username || target.password) {
    throw new Error('Proxy origin is outside this Syncables source');
  }

  const path = target.pathname.split('/').filter(Boolean).map(decode);
  if (
    path[0] !== 'proxy' ||
    !path[1] ||
    path[2] !== scope.platform ||
    (scope.connectionId && path[1] !== scope.connectionId)
  ) {
    throw new Error('Proxy platform or connection is outside this view source');
  }

  const endpoint = path.slice(3);
  if (scope.kind === 'organizations' || scope.kind === 'repositories') {
    if (endpoint.length !== 2 || endpoint[0] !== 'user' || endpoint[1] !== 'repos')
      throw new Error('Collection discovery may only read /user/repos');
  } else if (scope.kind === 'mirror') {
    if (
      endpoint.length !== 4 ||
      endpoint[0] !== 'repos' ||
      endpoint[1] !== scope.ownerLogin ||
      endpoint[2] !== scope.repoName ||
      endpoint[3] !== 'issues'
    ) {
      throw new Error('Mirror may only read issues from its selected repository');
    }
  } else {
    throw new Error('This view has no provider read permissions');
  }

  for (const [key, value] of target.searchParams) {
    if (key !== 'page' && key !== 'per_page' && key !== 'state')
      throw new Error('Unexpected provider query parameter');
    if (key === 'page' && (!/^[1-9][0-9]*$/.test(value) || Number(value) > 20))
      throw new Error('Invalid pagination page');
    if (key === 'per_page' && value !== '100')
      throw new Error('Invalid pagination page size');
    if (key === 'state' && (scope.kind !== 'mirror' || value !== 'all'))
      throw new Error('Unexpected issue state filter');
  }
}
