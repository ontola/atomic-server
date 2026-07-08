import {
  Datatype,
  JSONValue,
  Resource,
  Server,
  Store,
  commits,
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
  /**
   * Initial rows to insert, each an object of column name → cell value, plus
   * `name` for the row title. `select` cells accept the tag option name (or
   * its subject); a single value is wrapped into the required array.
   */
  rows?: Array<Record<string, JSONValue>>;
}

export interface BuildTableResult {
  tableSubject: string;
  classSubject: string;
  /** Column name → created property subject. */
  columns: Record<string, string>;
  /** For `select` columns: column name → (tag option name → tag subject). */
  tags: Record<string, Record<string, string>>;
  /** Subjects of the rows created from `spec.rows`, in the same order. */
  rowSubjects: string[];
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

/**
 * Creates (but does not save) a table's row class — named after what a single
 * row IS ("Issue", "Employee"), not a generic "row", which reads wrong on
 * every instance. The single class-genesis used by every table-creation flow
 * (templates, the New Table dialog, the AI's create_table tool).
 */
export async function createRowClass(
  store: Store,
  opts: { parent: string; tableName: string; rowName?: string },
): Promise<Resource> {
  const rowName = opts.rowName?.trim() || 'Row';

  return store.newResource({
    parent: opts.parent,
    isA: core.classes.class,
    propVals: {
      [core.properties.shortname]: stringToSlug(rowName),
      [core.properties.name]: rowName,
      [core.properties.description]:
        `Represents a row in the ${opts.tableName} table`,
      [core.properties.recommends]: [core.properties.name],
    },
  });
}

async function createColumn(
  store: Store,
  tableClass: Resource,
  column: TableColumnSpec,
): Promise<{ subject: string; tags?: Record<string, string> }> {
  if (column.type === 'select') {
    return createSelectPropertyOnClass(store, tableClass, {
      name: column.name,
      tags: (column.options ?? []).map(name => ({ name })),
    });
  }

  const subject = await createPropertyOnClass(store, tableClass, {
    name: column.name,
    datatype: DATATYPE_BY_TYPE[column.type],
    classtype: column.type === 'file' ? server.classes.file : undefined,
    description: column.description,
  });

  return { subject };
}

/**
 * Translates one row spec (column name → cell value) into propVals keyed by
 * property subject. `name` (any casing) maps to the core name property, select
 * cells map tag option names to their subjects and are wrapped into the
 * ResourceArray the datatype requires.
 */
function rowToPropVals(
  row: Record<string, JSONValue>,
  columns: Record<string, string>,
  tags: Record<string, Record<string, string>>,
): Record<string, JSONValue> {
  const propVals: Record<string, JSONValue> = {};

  for (const [column, value] of Object.entries(row)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (column.toLowerCase() === 'name') {
      propVals[core.properties.name] = value;
      continue;
    }

    const property = columns[column];

    if (!property) {
      throw new Error(
        `Unknown column "${column}". Available columns: name, ${Object.keys(
          columns,
        ).join(', ')}`,
      );
    }

    const tagsByName = tags[column];

    if (tagsByName) {
      const options = Array.isArray(value) ? value : [value];
      propVals[property] = options.map(
        option => tagsByName[String(option)] ?? String(option),
      );
    } else {
      propVals[property] = value;
    }
  }

  propVals[commits.properties.createdAt] = Date.now();

  return propVals;
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

  const rowClass = await createRowClass(store, {
    parent: ontologyParent,
    tableName: spec.name,
    rowName: spec.rowName,
  });
  await opts.addToOntology(rowClass);

  const columns: Record<string, string> = {};
  const tags: Record<string, Record<string, string>> = {};

  for (const column of spec.columns) {
    const created = await createColumn(store, rowClass, column);
    columns[column.name] = created.subject;

    if (created.tags) {
      tags[column.name] = created.tags;
    }
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

  const rowSubjects: string[] = [];

  for (const row of spec.rows ?? []) {
    const rowResource = await store.newResource({
      parent: table.subject,
      isA: rowClass.subject,
      propVals: rowToPropVals(row, columns, tags),
    });
    await rowResource.save();
    rowSubjects.push(rowResource.subject);
  }

  return {
    tableSubject: table.subject,
    classSubject: rowClass.subject,
    columns,
    tags,
    rowSubjects,
  };
}
