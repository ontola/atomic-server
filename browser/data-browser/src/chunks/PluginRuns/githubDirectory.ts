import {
  CollectionBuilder,
  core,
  dataBrowser,
  findSchema,
  subjectsReferToSameResource,
  type Resource,
  type Store,
} from '@tomic/lib';
import { isSyncableResourceInDrive } from './syncablePlatform';
import { syncableHierarchySchema } from './syncableHierarchy';
import { withoutTableViews } from './syncablesNavigation';

/** GitHub presentation metadata stays outside the class's stored columns. */
export async function githubDirectoryType(
  store: Store,
  drive: string,
  table: string,
): Promise<'organizations' | 'repositories'> {
  if (!(await isSyncableResourceInDrive(store, drive, table)))
    throw new Error('This GitHub table is outside the current drive');
  const resource = await store.getResource(table);
  if (resource.error) throw resource.error;
  const terms = await findSchema(store, drive, syncableHierarchySchema());
  const rowClass = resource.get(core.properties.classtype);
  const ownerClass = terms.classes?.['syncable-owner'];
  const repositoryClass = terms.classes?.['syncable-repository'];
  if (ownerClass && rowClass === ownerClass) return 'organizations';
  if (repositoryClass && rowClass === repositoryClass) return 'repositories';

  throw new Error('This row type has no GitHub directory view');
}

async function directoryChildren(
  store: Store,
  drive: string,
  parent: string,
  signal?: AbortSignal,
): Promise<Resource[]> {
  signal?.throwIfAborted();
  const collection = new CollectionBuilder(store)
    .setDrive(drive)
    .setProperty(core.properties.parent)
    .setValue(parent)
    .setPageSize(100)
    .build();
  const members = await collection.getAllMembers();
  const resource = await store.getResource(parent);
  const views = resource.get(dataBrowser.properties.tableViews);

  const subjects = withoutTableViews(
    members,
    Array.isArray(views)
      ? views.filter((value): value is string => typeof value === 'string')
      : [],
  );
  const children: Resource[] = [];

  for (const subject of subjects) {
    signal?.throwIfAborted();
    const child = await store.getResource(subject);
    if (
      child.error ||
      !subjectsReferToSameResource(child.get(core.properties.parent), parent) ||
      !(await isSyncableResourceInDrive(store, drive, subject))
    )
      continue;
    children.push(child);
  }

  return children;
}

const hasClass = (resource: Resource, classSubject: string): boolean => {
  const classes = resource.get(core.properties.isA);

  return Array.isArray(classes) && classes.includes(classSubject);
};

async function ownerRepositories(
  store: Store,
  drive: string,
  owner: string,
  repositoryClass: string,
  signal?: AbortSignal,
) {
  const children = await directoryChildren(store, drive, owner, signal);
  const repositories = children.filter(child =>
    hasClass(child, repositoryClass),
  );
  const tables = children.filter(
    child =>
      hasClass(child, dataBrowser.classes.table) &&
      child.get(core.properties.classtype) === repositoryClass,
  );

  return {
    repositories,
    table: tables.length === 1 ? tables[0] : undefined,
  };
}

export async function githubDirectoryRows(
  store: Store,
  drive: string,
  table: string,
  signal?: AbortSignal,
) {
  const type = await githubDirectoryType(store, drive, table);
  const terms = await findSchema(store, drive, syncableHierarchySchema());
  const rowClass =
    terms.classes?.[
      type === 'organizations' ? 'syncable-owner' : 'syncable-repository'
    ];
  if (!rowClass) throw new Error('The GitHub row schema is unavailable');
  const repositoryClass = terms.classes?.['syncable-repository'];
  const ownerKind = terms.properties?.['syncable-owner-kind'];
  const rows = [];
  const children = await directoryChildren(store, drive, table, signal);

  for (const row of children) {
    signal?.throwIfAborted();
    if (!hasClass(row, rowClass)) continue;
    const kind = ownerKind ? row.get(ownerKind) : undefined;
    let count: number;

    if (type === 'organizations' && repositoryClass) {
      const listing = await ownerRepositories(
        store,
        drive,
        row.subject,
        repositoryClass,
        signal,
      );
      const nested = listing.table
        ? await directoryChildren(store, drive, listing.table.subject, signal)
        : [];
      count =
        listing.repositories.length +
        nested.filter(child => hasClass(child, repositoryClass)).length;
    } else {
      count = (await directoryChildren(store, drive, row.subject, signal))
        .length;
    }

    const name = row.get(core.properties.name);
    rows.push({
      subject: row.subject,
      name: typeof name === 'string' ? name : row.title || row.subject,
      kind: typeof kind === 'string' ? kind : undefined,
      count,
    });
  }

  signal?.throwIfAborted();

  return { rows, complete: true };
}

export async function openGithubDirectoryRow(
  store: Store,
  drive: string,
  table: string,
  subject: unknown,
) {
  const type = await githubDirectoryType(store, drive, table);
  if (typeof subject !== 'string') throw new Error('Choose a GitHub row');
  const parent = await store.getResource(table);
  const row = await store.getResource(subject);
  if (row.error) throw row.error;
  const classes = row.get(core.properties.isA);
  const rowClass = parent.get(core.properties.classtype);
  if (
    !subjectsReferToSameResource(row.get(core.properties.parent), table) ||
    typeof rowClass !== 'string' ||
    !Array.isArray(classes) ||
    !classes.includes(rowClass) ||
    !(await isSyncableResourceInDrive(store, drive, subject))
  )
    throw new Error('This row does not belong to the GitHub table');

  if (type === 'organizations') {
    const terms = await findSchema(store, drive, syncableHierarchySchema());
    const repositoryClass = terms.classes?.['syncable-repository'];

    if (repositoryClass) {
      const listing = await ownerRepositories(
        store,
        drive,
        subject,
        repositoryClass,
      );
      if (listing.table) return { subject: listing.table.subject };
    }
  }

  return { subject };
}
