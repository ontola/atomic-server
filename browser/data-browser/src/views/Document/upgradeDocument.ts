import {
  type DataBrowser,
  type Resource,
  type Store,
} from '@tomic/react';

/**
 * V1→V2 document upgrade is no longer supported after the Yjs→Loro migration.
 * V1 documents should be upgraded to V2 using an older version of the app,
 * then migrated to Loro-backed V3 documents.
 */
export async function upgradeDocument(
  _resource: Resource<DataBrowser.Document>,
  _store: Store,
) {
  throw new Error(
    'V1→V2 document upgrade is no longer supported. Please use the Loro-native document format.',
  );
}
