import {
  commits,
  core,
  dataBrowser,
  GENESIS,
  server,
  subjectsReferToSameResource,
  type Resource,
} from '@tomic/lib';
import type { ViewKind } from '@chunks/TablePage/tableViewKinds';

/** Existing collection links keep their View's settings and saved rule scope. */
export function syncableEntityViewKind(
  kind: ViewKind,
  entity: boolean,
): ViewKind {
  return entity && kind === 'syncable-collection' ? 'table' : kind;
}

const defaultNames = new Set(['Collection', 'Browse', 'Syncable Collection']);
const baseProperties = new Set<string>([
  core.properties.name,
  core.properties.isA,
  core.properties.parent,
  commits.properties.createdAt,
  server.properties.createdBy,
  commits.properties.lastCommit,
  GENESIS,
  'https://atomicdata.dev/properties/drive',
  dataBrowser.properties.viewKind,
]);

/** The installer gives generated Views their creator as their only writer. */
function isGeneratedOwnerWrite(view: Resource, value: unknown): boolean {
  const creator = view.getCreatedBy();

  return (
    typeof creator === 'string' &&
    creator.length > 0 &&
    Array.isArray(value) &&
    value.length === 1 &&
    typeof value[0] === 'string' &&
    subjectsReferToSameResource(value[0], creator)
  );
}

/** Hide only the unconfigured duplicate, never a renamed or configured View. */
function isRedundantCollection(view: Resource): boolean {
  return (
    !view.loading &&
    !view.error &&
    view.get(dataBrowser.properties.viewKind) === 'syncable-collection' &&
    defaultNames.has(String(view.get(core.properties.name))) &&
    view
      .getEntries()
      .every(
        ([property, value]) =>
          baseProperties.has(property) ||
          (property === core.properties.write &&
            isGeneratedOwnerWrite(view, value)),
      )
  );
}

/** Presentation only: saved View resources and the actual active View survive. */
export function syncableCollectionTabs({
  entity,
  views,
  activeView,
  rules,
  getView,
}: {
  entity: boolean;
  views: string[];
  activeView: string | undefined;
  rules: ReadonlySet<string>;
  getView: (subject: string) => Resource;
}) {
  const ordinary = views.find(subject => {
    const view = getView(subject);

    return (
      !rules.has(subject) &&
      !view.loading &&
      !view.error &&
      view.get(dataBrowser.properties.viewKind) === 'table'
    );
  });
  const hidden = new Set(
    views.filter(
      subject =>
        rules.has(subject) ||
        (entity && !!ordinary && isRedundantCollection(getView(subject))),
    ),
  );
  const visible = views.filter(subject => !hidden.has(subject));
  const collection = visible.find(
    subject =>
      getView(subject).get(dataBrowser.properties.viewKind) ===
      'syncable-collection',
  );

  return {
    views: visible,
    hidden,
    activeView:
      activeView && hidden.has(activeView)
        ? entity
          ? (ordinary ?? collection)
          : collection
        : activeView,
  };
}

/** Reordering the visible tabs does not detach hidden scopes or old links. */
export function retainHiddenSyncableViews(
  next: string[],
  previous: string[],
  hidden: ReadonlySet<string>,
): string[] {
  return [...next, ...previous.filter(subject => hidden.has(subject))];
}
