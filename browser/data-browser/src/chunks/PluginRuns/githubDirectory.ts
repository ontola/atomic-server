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
): Promise<Resource[]> {
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

/** Presentation values are a saved snapshot, never a provider request. */
export function githubDirectoryValues(
  resource: Pick<Resource, 'get'>,
  properties: Record<string, string> | undefined,
) {
  const read = (name: string) =>
    properties?.[name] ? resource.get(properties[name]) : undefined;

  const integer = (name: string) => {
    const value = read(name);

    return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : undefined;
  };

  const boolean = (name: string) => {
    const value = read(name);

    return typeof value === 'boolean' ? value : undefined;
  };

  const config = read('syncable-source-config');
  const source: Record<string, unknown> =
    config && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {};

  return {
    ownerKind: read('syncable-owner-kind'),
    ownerLogin:
      typeof source.ownerLogin === 'string' ? source.ownerLogin : undefined,
    ownerId: typeof source.ownerId === 'string' ? source.ownerId : undefined,
    repoName: typeof source.repoName === 'string' ? source.repoName : undefined,
    repositories: integer('syncable-repository-count'),
    private: boolean('syncable-repository-private'),
    hasIssues: boolean('syncable-repository-has-issues'),
    openIssues: integer('syncable-repository-open-issues'),
  };
}

async function ownerRepositories(
  store: Store,
  drive: string,
  owner: string,
  repositoryClass: string,
) {
  const children = await directoryChildren(store, drive, owner);
  const tables = children.filter(
    child =>
      hasClass(child, dataBrowser.classes.table) &&
      child.get(core.properties.classtype) === repositoryClass,
  );

  return tables.length === 1 ? tables[0] : undefined;
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
      const repositoryTable = await ownerRepositories(
        store,
        drive,
        subject,
        repositoryClass,
      );
      if (repositoryTable) return { subject: repositoryTable.subject };
    }
  } else {
    const terms = await findSchema(store, drive, syncableHierarchySchema());
    const kindProperty = terms.properties?.['syncable-node-kind'];
    const configProperty = terms.properties?.['syncable-source-config'];
    const config = configProperty ? parent.get(configProperty) : undefined;
    const connection =
      config && typeof config === 'object' && !Array.isArray(config)
        ? (config as Record<string, unknown>).connectionId
        : undefined;
    const children = await directoryChildren(store, drive, subject);
    const mirrors = children.filter(child => {
      const kind = kindProperty ? child.get(kindProperty) : undefined;
      const source = configProperty ? child.get(configProperty) : undefined;

      return (
        hasClass(child, dataBrowser.classes.table) &&
        (kind === 'mirror' || kind === 'public-mirror') &&
        (typeof connection !== 'string' ||
          (source &&
            typeof source === 'object' &&
            !Array.isArray(source) &&
            (source as Record<string, unknown>).connectionId === connection))
      );
    });
    if (mirrors.length === 1) return { subject: mirrors[0].subject };
  }

  return { subject };
}
