import {
  Datatype,
  JSONValue,
  Resource,
  Server,
  Store,
  core,
  dataBrowser,
  server,
} from '@tomic/react';
import { ViewKind } from './tableViewKinds';
import { stringToSlug } from '@helpers/stringToSlug';
import {
  createPropertyOnClass,
  createSelectPropertyOnClass,
} from './Kanban/createSelectProperty';

/**
 * The compact, high-level column vocabulary a caller (a template, or the AI
 * assistant) uses to describe a table — one entry per column, no ontology
 * plumbing. Maps onto the same datatypes the New Column dialog offers.
 */
export type TableColumnType =
  | 'text'
  | 'markdown'
  | 'number'
  | 'date'
  | 'datetime'
  | 'checkbox'
  | 'relation'
  | 'file'
  | 'select';

export interface TableColumnSpec {
  name: string;
  type: TableColumnType;
  /** For `select` columns: the tag options, e.g. ['Todo', 'Doing', 'Done']. */
  options?: string[];
  description?: string;
}

export interface TableViewSpec {
  name: string;
  kind: ViewKind;
  /** For `kanban` views: the name of the `select` column to group cards by. */
  groupByColumn?: string;
  default?: boolean;
}

export interface TableSpec {
  name: string;
  /** What a single row is called ("Issue", "Employee"); names the row class.
   *  Falls back to "Row". */
  rowName?: string;
  columns: TableColumnSpec[];
  views?: TableViewSpec[];
}

export interface BuildTableResult {
  tableSubject: string;
  classSubject: string;
  /** Column name → created property subject. */
  columns: Record<string, string>;
}

const DATATYPE_BY_TYPE: Record<Exclude<TableColumnType, 'select'>, Datatype> = {
  text: Datatype.STRING,
  markdown: Datatype.MARKDOWN,
  number: Datatype.INTEGER,
  date: Datatype.DATE,
  datetime: Datatype.TIMESTAMP,
  checkbox: Datatype.BOOLEAN,
  relation: Datatype.ATOMIC_URL,
  file: Datatype.ATOMIC_URL,
};

/** Prefer the drive's default ontology as the parent, else the drive itself. */
export async function resolveOntologyParent(
  store: Store,
  driveSubject: string,
): Promise<string> {
  const drive = await store.getResource<Server.Drive>(driveSubject);
  const ontologyParent = drive.props.defaultOntology;

  return ontologyParent &&
    !ontologyParent.startsWith('internal:') &&
    !ontologyParent.includes('unknown-subject')
    ? ontologyParent
    : driveSubject;
}

async function createColumn(
  store: Store,
  tableClass: Resource,
  column: TableColumnSpec,
): Promise<string> {
  if (column.type === 'select') {
    return createSelectPropertyOnClass(store, tableClass, {
      name: column.name,
      tags: (column.options ?? []).map(name => ({ name })),
    });
  }

  return createPropertyOnClass(store, tableClass, {
    name: column.name,
    datatype: DATATYPE_BY_TYPE[column.type],
    classtype: column.type === 'file' ? server.classes.file : undefined,
    description: column.description,
  });
}

async function createView(
  store: Store,
  table: Resource,
  view: TableViewSpec,
  columnSubjectByName: Record<string, string>,
): Promise<void> {
  const propVals: Record<string, JSONValue> = {
    [core.properties.name]: view.name,
    [dataBrowser.properties.viewKind]: view.kind,
  };

  const groupBy = view.groupByColumn
    ? columnSubjectByName[view.groupByColumn]
    : undefined;

  if (groupBy) {
    propVals[dataBrowser.properties.viewGroupBy] = groupBy;
  }

  const viewResource = await store.newResource({
    parent: table.subject,
    isA: dataBrowser.classes.view,
    propVals,
  });
  await viewResource.save();

  await table.push(
    dataBrowser.properties.tableViews,
    [viewResource.subject],
    true,
  );

  if (view.default) {
    await table.set(
      dataBrowser.properties.tableDefaultView,
      viewResource.subject,
    );
  }

  await table.save();
}

/**
 * Builds a complete table — row class, columns, table resource, and any saved
 * views — from one declarative spec. This is the single primitive behind both
 * the in-app table templates and the assistant's `create_table` tool: callers
 * describe *what* they want, not the ~4-resource-per-column commit dance.
 *
 * Does not navigate; returns the created subjects so the caller decides what to
 * do next (open it, link it, keep building).
 */
export async function buildTableFromSpec(
  store: Store,
  spec: TableSpec,
  opts: {
    parent: string;
    driveSubject: string;
    addToOntology: (resource: Resource) => Promise<void>;
  },
): Promise<BuildTableResult> {
  const ontologyParent = await resolveOntologyParent(store, opts.driveSubject);

  // Rows are instances of a class named after what a single row IS ("Issue",
  // "Employee") — not a generic "row", which reads wrong on every instance.
  const rowName = spec.rowName?.trim() || 'Row';

  const rowClass = await store.newResource({
    parent: ontologyParent,
    isA: core.classes.class,
    propVals: {
      [core.properties.shortname]: stringToSlug(rowName),
      [core.properties.name]: rowName,
      [core.properties.description]:
        `Represents a row in the ${spec.name} table`,
      [core.properties.recommends]: [core.properties.name],
    },
  });
  await opts.addToOntology(rowClass);

  const columns: Record<string, string> = {};

  for (const column of spec.columns) {
    columns[column.name] = await createColumn(store, rowClass, column);
  }

  const table = await store.newResource({
    parent: opts.parent,
    isA: dataBrowser.classes.table,
    propVals: {
      [core.properties.name]: spec.name,
      [core.properties.classtype]: rowClass.subject,
    },
  });
  await table.save();

  for (const view of spec.views ?? []) {
    await createView(store, table, view, columns);
  }

  return {
    tableSubject: table.subject,
    classSubject: rowClass.subject,
    columns,
  };
}
