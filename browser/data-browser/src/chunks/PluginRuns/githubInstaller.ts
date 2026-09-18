// @wc-ignore-file
import { install } from '../../../../../integrations/github-issues/atomic';
import type { Store } from '@tomic/lib';
import { fetchIntegrationSource } from '@helpers/integrationSource';

export async function installGitHub(
  store: Store,
  drive: string,
  repository: string,
  token: string,
  destination?: string,
) {
  const source = await fetchIntegrationSource(
    store.getServerUrl(),
    'github-issues',
  );

  return install(store, drive, repository, source, token, destination);
}
