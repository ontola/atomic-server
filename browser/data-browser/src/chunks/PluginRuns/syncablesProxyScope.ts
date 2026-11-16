// @wc-ignore-file
export interface SyncablesProxyScope {
  proxyOrigin: string;
  platform: string;
  kind: string;
  connectionId?: string;
  repoId?: string;
}

/** The iframe names a read, never an HTTP URL or method. The host supplies
 * the connection, stable repository ID, and every provider query parameter. */
export function syncablesProxyUrl(
  scope: SyncablesProxyScope,
  read: unknown,
  page: unknown = 1,
): URL {
  if (scope.platform !== 'github-issues' || !scope.connectionId)
    throw new Error('This view has no GitHub connection');
  if (
    typeof page !== 'number' ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 20
  )
    throw new Error('Invalid pagination page');

  let endpoint: string;

  if (
    read === 'profile' &&
    ['platform', 'organizations'].includes(scope.kind) &&
    page === 1
  ) {
    endpoint = 'user';
  } else if (read === 'owners' && scope.kind === 'organizations') {
    endpoint = 'user/orgs';
  } else if (
    read === 'repositories' &&
    ['organizations', 'repositories'].includes(scope.kind)
  ) {
    endpoint = 'user/repos';
  } else if (
    read === 'issues' &&
    scope.kind === 'mirror' &&
    scope.repoId &&
    /^[1-9][0-9]*$/.test(scope.repoId)
  ) {
    endpoint = 'repositories/' + scope.repoId + '/issues';
  } else {
    throw new Error('This view cannot read that GitHub endpoint');
  }

  const connection = encodeURIComponent(scope.connectionId);
  const url = new URL(
    `/proxy/${connection}/${scope.platform}/${endpoint}`,
    scope.proxyOrigin,
  );

  if (read !== 'profile') {
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
  }

  if (read === 'issues') url.searchParams.set('state', 'all');

  return url;
}
