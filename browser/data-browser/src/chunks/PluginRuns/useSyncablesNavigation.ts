import { useEffect, useState } from 'react';
import {
  core,
  findSchema,
  unknownSubject,
  useStore,
  useValue,
  type Resource,
} from '@tomic/react';
import {
  isSyncablesNavigationTable,
  isSyncablesPlatformRoot,
} from './syncablesNavigation';
import { syncableHierarchySchema } from './syncableHierarchy';

/** Resolve saved navigation metadata only for historical directory candidates. */
export function useSyncablesNavigation(resource: Resource) {
  const store = useStore();
  const drive = store.getDrive();
  const [localId] = useValue(resource, core.properties.localId);
  const candidate =
    isSyncablesNavigationTable(localId) && !isSyncablesPlatformRoot(localId);
  const [schema, setSchema] = useState<{
    drive: string;
    key?: string;
  }>();

  useEffect(() => {
    if (!candidate || !drive) return;
    let active = true;
    void findSchema(store, drive, syncableHierarchySchema())
      .then(terms => {
        if (active)
          setSchema({ drive, key: terms.properties?.['syncable-source-key'] });
      })
      .catch(() => {
        // Unavailable metadata must not hide a legacy principal or directory.
        if (active) setSchema({ drive });
      });

    return () => {
      active = false;
    };
  }, [store, drive, candidate]);

  const [sourceKey] = useValue(
    resource,
    schema && schema.drive === drive
      ? (schema.key ?? unknownSubject)
      : unknownSubject,
  );
  const loading = candidate && !!drive && schema?.drive !== drive;

  return {
    loading,
    isDirectory: !loading && isSyncablesNavigationTable(localId, sourceKey),
  };
}
