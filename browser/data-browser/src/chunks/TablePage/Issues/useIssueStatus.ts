import {
  Datatype,
  Property,
  Resource,
  core,
  useArray,
  useResource,
  useResources,
} from '@tomic/react';
import { useMemo } from 'react';
import { useKanbanGroupBy } from '../Kanban/useKanbanGroupBy';
import {
  isClosedStatusTag,
  selectStatusModel,
  type IssueStatusModel,
} from './issueStatus';

/**
 * Resolves what the issue list reads open/closed from.
 *
 * A `view-group-by` that names a boolean column is taken as is: a read-only
 * import (Todoist's projected `done`) has nothing better to offer, and
 * adopting or creating a Status select next to it would be inventing state
 * the provider does not have. Otherwise the same resolution as the board:
 * the configured select property, the first select on the class, or a new
 * Status one for writers.
 */
export function useIssueStatus(
  tableClass: Resource,
  allColumns: Property[],
  viewGroupBy: string | undefined,
  setViewGroupBy: (property: string) => void,
  canWrite: boolean,
): {
  model: IssueStatusModel | undefined;
  status: 'resolving' | 'creating' | 'ready';
} {
  const booleanProp = useMemo(
    () =>
      allColumns.find(
        c => c.subject === viewGroupBy && c.datatype === Datatype.BOOLEAN,
      ),
    [allColumns, viewGroupBy],
  );

  const { groupBy, status } = useKanbanGroupBy(
    tableClass,
    allColumns,
    viewGroupBy,
    setViewGroupBy,
    // Never create a Status select for a table whose view already says
    // "closed is this checkbox".
    canWrite && !booleanProp,
  );

  const statusResource = useResource(booleanProp ? undefined : groupBy);
  const [tagSubjects] = useArray(statusResource, core.properties.allowsOnly);
  const tagResources = useResources(tagSubjects);

  const model = useMemo<IssueStatusModel | undefined>(() => {
    if (booleanProp) return { kind: 'boolean', property: booleanProp.subject };
    if (!groupBy) return undefined;

    return selectStatusModel(
      groupBy,
      tagSubjects.map(subject => {
        // A tag's title is its shortname (`done`), or a name when it has one.
        const title = tagResources.get(subject)?.title ?? '';

        return { subject, title, closed: isClosedStatusTag(subject, title) };
      }),
    );
  }, [booleanProp, groupBy, tagSubjects, tagResources]);

  return { model, status: booleanProp ? 'ready' : status };
}
