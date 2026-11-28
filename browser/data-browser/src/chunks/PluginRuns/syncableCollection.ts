import type { RelationshipSelector } from 'syncables/browser';
import { openFlatSyncableRow } from './syncableFlatNavigation';
import {
  core,
  dataBrowser,
  findSchema,
  isAtomicIdentifier,
  subjectsReferToSameResource,
  type Resource,
  type Store,
} from '@tomic/lib';
import {
  isSyncableResourceInDrive,
  loadSyncableResource,
} from './syncablePlatform';
import { syncableHierarchySchema } from './syncableHierarchy';

export interface SyncableCollectionColumn {
  property: string;
  label: string;
  format?: 'value' | 'count' | 'enum';
  labels?: Record<string, string>;
}

export interface SyncableCollectionDescriptor {
  version: 1;
  rowClass: string;
  title: string;
  columns: SyncableCollectionColumn[];
  openTargetProperty?: string;
  relationships?: {
    resource: string;
    title: string;
    via: RelationshipSelector;
  }[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;

function subject(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  if (isAtomicIdentifier(value)) return true;

  try {
    const url = new URL(value);

    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** A bounded, declarative view of saved properties, with no executable fields. */
export function parseSyncableCollectionView(
  value: unknown,
  rowClass: unknown,
): SyncableCollectionDescriptor | undefined {
  if (
    !record(value) ||
    value.version !== 1 ||
    !subject(value.rowClass) ||
    typeof rowClass !== 'string' ||
    !subjectsReferToSameResource(value.rowClass, rowClass) ||
    !text(value.title) ||
    !Array.isArray(value.columns) ||
    value.columns.length < 1 ||
    value.columns.length > 40 ||
    (value.openTargetProperty !== undefined &&
      !subject(value.openTargetProperty))
  )
    return undefined;
  const columns: SyncableCollectionColumn[] = [];
  const properties = new Set<string>();

  for (const column of value.columns) {
    if (
      !record(column) ||
      !subject(column.property) ||
      properties.has(column.property) ||
      !text(column.label) ||
      (column.format !== undefined &&
        !['value', 'count', 'enum'].includes(String(column.format))) ||
      (column.labels !== undefined &&
        (!record(column.labels) ||
          Object.keys(column.labels).length > 100 ||
          !Object.values(column.labels).every(text)))
    )
      return undefined;
    properties.add(column.property);
    columns.push({
      property: column.property,
      label: column.label,
      ...(column.format
        ? { format: column.format as SyncableCollectionColumn['format'] }
        : {}),
      ...(column.labels
        ? { labels: { ...(column.labels as Record<string, string>) } }
        : {}),
    });
  }

  const relationships: SyncableCollectionDescriptor['relationships'] = [];

  if (value.relationships !== undefined) {
    if (!Array.isArray(value.relationships) || value.relationships.length > 100)
      return undefined;

    for (const relationship of value.relationships) {
      if (
        !record(relationship) ||
        !text(relationship.resource) ||
        !text(relationship.title) ||
        !record(relationship.via) ||
        !text(relationship.via.collection) ||
        !['identity', 'responseLink'].includes(String(relationship.via.kind)) ||
        (relationship.via.reference !== undefined &&
          !text(relationship.via.reference)) ||
        (relationship.via.link !== undefined && !text(relationship.via.link))
      )
        return undefined;
      relationships.push(
        structuredClone(relationship) as unknown as NonNullable<
          SyncableCollectionDescriptor['relationships']
        >[number],
      );
    }
  }

  return {
    version: 1,
    rowClass: value.rowClass,
    title: value.title,
    columns,
    ...(value.relationships !== undefined ? { relationships } : {}),
    ...(value.openTargetProperty
      ? { openTargetProperty: value.openTargetProperty as string }
      : {}),
  };
}

export function syncableCollectionValue(
  value: unknown,
  column: SyncableCollectionColumn,
): string {
  if (column.format === 'count')
    return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? String(value)
      : '—';

  if (column.format === 'enum') {
    const key = String(value);

    return column.labels && Object.hasOwn(column.labels, key)
      ? column.labels[key]
      : '—';
  }

  return typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
    ? String(value)
    : '—';
}

function hasClass(
  resource: { get: (property: string) => unknown },
  klass: string,
): boolean {
  const classes = resource.get(core.properties.isA);

  return (
    Array.isArray(classes) &&
    classes.some(
      value =>
        typeof value === 'string' && subjectsReferToSameResource(value, klass),
    )
  );
}

/** Re-read authority on use; a cached screen never authorizes navigation. */
export async function resolveSyncableCollectionView(
  store: Store,
  drive: string,
  table: string,
): Promise<SyncableCollectionDescriptor> {
  const resource = await store.getResource(table);
  if (
    resource.error ||
    !hasClass(resource, dataBrowser.classes.table) ||
    !(await isSyncableResourceInDrive(store, drive, table))
  )
    throw new Error('This collection table is outside the current drive');
  const terms = await findSchema(store, drive, syncableHierarchySchema());
  const property = terms.properties?.['syncable-collection-view'];
  const descriptor = parseSyncableCollectionView(
    property ? resource.get(property) : undefined,
    resource.get(core.properties.classtype),
  );
  if (!descriptor)
    throw new Error('This table has no valid stored collection view');

  return descriptor;
}

export function isSyncableCollectionRow(
  row: Pick<Resource, 'get' | 'error'>,
  table: string,
  descriptor: SyncableCollectionDescriptor,
) {
  return (
    !row.error &&
    typeof row.get(core.properties.parent) === 'string' &&
    subjectsReferToSameResource(
      row.get(core.properties.parent) as string,
      table,
    ) &&
    hasClass(row, descriptor.rowClass)
  );
}

/** Open a saved direct child table, or the row itself when no valid link exists. */
export async function openSyncableCollectionRow(
  store: Store,
  drive: string,
  table: string,
  rowSubject: string,
  activeRule?: string,
): Promise<{ subject: string; view?: string; syncFilter?: string }> {
  const descriptor = await resolveSyncableCollectionView(store, drive, table);
  const row = await store.getResource(rowSubject);
  const flat = await openFlatSyncableRow(
    store,
    drive,
    await store.getResource(table),
    row,
    activeRule,
  );
  if (flat) return flat;
  if (
    !isSyncableCollectionRow(row, table, descriptor) ||
    !(await isSyncableResourceInDrive(store, drive, rowSubject))
  )
    throw new Error('This row does not belong to the collection table');
  const target = descriptor.openTargetProperty
    ? row.get(descriptor.openTargetProperty)
    : undefined;

  if (subject(target) && !store.isForeignOriginSubject(target)) {
    const child = await loadSyncableResource(store, target);
    if (
      child &&
      hasClass(child, dataBrowser.classes.table) &&
      typeof child.get(core.properties.parent) === 'string' &&
      subjectsReferToSameResource(
        child.get(core.properties.parent) as string,
        rowSubject,
      ) &&
      (await isSyncableResourceInDrive(store, drive, target))
    )
      return { subject: child.subject };
  }

  return { subject: rowSubject };
}
