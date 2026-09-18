// @wc-ignore-file
import source from '../../../../../integrations/notion/plugin.js?raw';
import {
  install,
  type ProxyConnection,
} from '../../../../../integrations/notion/atomic';
import type { Store } from '@tomic/lib';
import { localSchemaStore } from './installationResources';

export function installNotion(
  store: Store,
  drive: string,
  dataSource: string,
  token: string | Omit<ProxyConnection, 'schemaStore'>,
) {
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
