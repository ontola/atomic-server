import { useEffect, useState } from 'react';
import {
  core,
  dataBrowser,
  findSchema,
  subjectsReferToSameResource,
  useResource,
  useStore,
} from '@tomic/react';
import { VIEW_KINDS, type ViewKind } from '@chunks/TablePage/tableViewKinds';
import {
  parseSyncableCollectionView,
  resolveSyncableCollectionView,
} from './syncableCollection';
import { syncableHierarchySchema } from './syncableHierarchy';

export function selectableViewKinds(
  applicable: boolean,
  entity = false,
): ViewKind[] {
  return VIEW_KINDS.filter(
    kind =>
      kind !== 'syncables' &&
      (kind !== 'syncable-collection' || (applicable && !entity)),
  );
}

/** Applicability comes from this table's saved descriptor, not a provider name. */
export function useSyncableCollectionView(
  drive: string | undefined,
  table: string,
  rowClass: string,
  enabled = true,
) {
  const store = useStore();
  const resource = useResource(table);
  const parent = resource.get(core.properties.parent);
  const resourceClass = resource.get(core.properties.classtype);
  const [revision, setRevision] = useState(0);
  const [resolved, setResolved] = useState<{ key: string; property: string }>();
  const key = JSON.stringify([
    drive,
    table,
    rowClass,
    parent,
    resourceClass,
    resource.get(core.properties.isA),
    resource.get('https://atomicdata.dev/properties/drive'),
    revision,
  ]);
  const refresh = () => setRevision(value => value + 1);

  useEffect(() => {
    if (!drive || !enabled) return;
    let active = true;
    void Promise.all([
      resolveSyncableCollectionView(store, drive, table),
      findSchema(store, drive, syncableHierarchySchema()),
    ])
      .then(([descriptor, terms]) => {
        const property = terms.properties?.['syncable-collection-view'];
        if (active)
          setResolved(
            subjectsReferToSameResource(descriptor.rowClass, rowClass) &&
              property
              ? { key, property }
              : undefined,
          );
      })
      .catch(() => {
        if (active) setResolved(undefined);
      });

    return () => {
      active = false;
    };
  }, [store, drive, table, rowClass, key, enabled]);

  return {
    applicable:
      enabled &&
      resolved?.key === key &&
      resource
        .getSubjects(core.properties.isA)
        .includes(dataBrowser.classes.table) &&
      !!parseSyncableCollectionView(resource.get(resolved.property), rowClass),
    refresh,
  };
}
