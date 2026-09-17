// @wc-ignore-file
import {
  install,
  type ProxyConnection,
} from '../../../../../integrations/notion/atomic';
import type { Store } from '@tomic/lib';
import { localSchemaStore } from './installationResources';
import { fetchIntegrationSource } from '@helpers/integrationSource';

export async function installNotion(
  store: Store,
  drive: string,
  dataSource: string,
  token: string | Omit<ProxyConnection, 'schemaStore'>,
) {
  const source = await fetchIntegrationSource(store.getServerUrl(), 'notion');

  return install(
    store,
    drive,
    dataSource,
    source,
    typeof token === 'string'
      ? token
      : { ...token, schemaStore: localSchemaStore(store) },
  );
}
