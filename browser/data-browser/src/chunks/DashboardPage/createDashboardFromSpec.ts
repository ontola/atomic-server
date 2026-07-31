import { core, dataBrowser, type Resource, type Store } from '@tomic/react';
import {
  readTableColumns,
  resolveView,
  type TableColumnMap,
} from '../TablePage/tableOps';
import { parseDerivedColumnSpecs } from '../TablePage/derivedColumns';
import {
  defaultSizeFor,
  isBlockKind,
  type BlockKind,
  type BlockPlacement,
} from './dashboardBlocks';

/**
 * One block, in the vocabulary an assistant writes: columns and views named
 * rather than subject-referenced, since it has just read them back as names from
 * `describe_table`.
 */
export interface DashboardBlockSpec {
  kind: BlockKind;
  /** The block's heading. */
  title: string;
  /** The table it describes, by subject. Required for every kind but `text`. */
  table?: string;
  /** A view of that table, by name or subject. Its filters scope the block. */
  view?: string;
  /** What to measure: `count`, or a function plus a column name. */
  measure?: {
    function: 'count' | 'sum' | 'avg' | 'min' | 'max';
    /** A stored column's name, or a computed column's label on the view. */
    column?: string;
  };
  /** For charts: which column becomes the buckets, and how coarse they are. */
  chartBy?: {
    column: string;
    bucket?: 'exact' | 'day' | 'month';
  };
  /** For text blocks: the markdown body. */
  text?: string;
  /** Width in twelfths. Defaults to something sensible for the kind. */
  width?: number;
}

export interface DashboardSpec {
  name: string;
  blocks: DashboardBlockSpec[];
}

export interface CreatedDashboard {
  dashboardSubject: string;
  /** Block title → subject, so a follow-up call can address one. */
  blocks: Record<string, string>;
  /** What was asked for but could not be honoured, per block. */
  warnings: string[];
}

/** Case-insensitive column lookup, the way every other table tool resolves one. */
function columnSubject(map: TableColumnMap, name: string): string | undefined {
  return (
    map.byName[name.toLowerCase()] ??
    map.columns.find(
      column =>
        column.name.toLowerCase() === name.toLowerCase() ||
        column.subject === name,
    )?.subject
  );
}

/**
 * Builds a whole dashboard — the resource, its blocks and their layout — in one
 * call, the way `create_table` builds a table.
 *
 * Names are resolved here rather than by the caller, and a block that names
 * something that doesn't exist is created *unconfigured* with a warning instead
 * of failing the call: a dashboard of six blocks where one column name was wrong
 * should arrive with five working blocks and a note, not as an error.
 */
export async function buildDashboardFromSpec(
  store: Store,
  spec: DashboardSpec,
  opts: { parent: string },
): Promise<CreatedDashboard> {
  const dashboard = await store.newResource({
    parent: opts.parent,
    isA: dataBrowser.classes.dashboard,
    propVals: { [core.properties.name]: spec.name },
  });
  await dashboard.save();

  const blocks: Record<string, string> = {};
  const warnings: string[] = [];
  const subjects: string[] = [];
  const layout: BlockPlacement[] = [];

  // Column maps are per table and a dashboard usually has several blocks over
  // the same one; reading the class once per table keeps this one round of work.
  const columnMaps = new Map<string, TableColumnMap>();

  const columnsOf = async (table: Resource): Promise<TableColumnMap> => {
    const cached = columnMaps.get(table.subject);

    if (cached) {
      return cached;
    }

    const classSubject = table.get(core.properties.classtype) as
      | string
      | undefined;

    if (!classSubject) {
      throw new Error(`${table.subject} is not a table (no row class).`);
    }

    const map = await readTableColumns(
      store,
      await store.getResource(classSubject),
    );
    columnMaps.set(table.subject, map);

    return map;
  };

  let x = 0;
  let y = 0;

  for (const blockSpec of spec.blocks) {
    const kind: BlockKind = isBlockKind(blockSpec.kind)
      ? blockSpec.kind
      : 'text';
    const propVals: Record<string, unknown> = {
      [core.properties.name]: blockSpec.title,
      [dataBrowser.properties.blockKind]: kind,
    };

    if (kind === 'text') {
      if (blockSpec.text) {
        propVals[core.properties.description] = blockSpec.text;
      }
    } else if (!blockSpec.table) {
      warnings.push(`"${blockSpec.title}": needs a table, so it is empty.`);
    } else {
      const table = await store.getResource(blockSpec.table);

      if (table.error) {
        warnings.push(
          `"${blockSpec.title}": could not read table ${blockSpec.table}, so it is empty.`,
        );
      } else {
        propVals[dataBrowser.properties.blockSource] = table.subject;

        const map = await columnsOf(table);
        let view: Resource | undefined;

        if (blockSpec.view) {
          try {
            view = await resolveView(store, table, blockSpec.view);
            propVals[dataBrowser.properties.blockView] = view.subject;
          } catch (error) {
            warnings.push(
              `"${blockSpec.title}": ${(error as Error).message} Showing every row instead.`,
            );
          }
        }

        if (blockSpec.measure && (kind === 'stat' || kind === 'chart')) {
          const aggregate = resolveMeasure(blockSpec, map, view, warnings);

          if (aggregate) {
            propVals[dataBrowser.properties.blockAggregate] = aggregate;
          }
        }

        if (kind === 'chart' && blockSpec.chartBy) {
          const field = columnSubject(map, blockSpec.chartBy.column);

          if (field) {
            propVals[dataBrowser.properties.blockChartSpec] = {
              mark: 'bar',
              field,
              granularity: blockSpec.chartBy.bucket ?? 'exact',
            };
          } else {
            warnings.push(
              `"${blockSpec.title}": no column called "${blockSpec.chartBy.column}" to group by.`,
            );
          }
        }
      }
    }

    const created = await store.newResource({
      parent: dashboard.subject,
      isA: dataBrowser.classes.block,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      propVals: propVals as any,
    });
    await created.save();

    blocks[blockSpec.title] = created.subject;
    subjects.push(created.subject);

    // Laid out left to right, wrapping at twelve columns. A dashboard an
    // assistant wrote therefore arrives arranged rather than in one tall stack.
    const w = Math.max(
      1,
      Math.min(12, blockSpec.width ?? defaultSizeFor(kind).w),
    );
    const h = defaultSizeFor(kind).h;

    if (x + w > 12) {
      x = 0;
      y += 1;
    }

    layout.push({ subject: created.subject, x, y, w, h });
    x += w;

    if (x >= 12) {
      x = 0;
      y += 1;
    }
  }

  await dashboard.set(dataBrowser.properties.dashboardBlocks, subjects, false);
  await dashboard.set(
    dataBrowser.properties.dashboardLayout,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    layout as any,
    false,
  );
  await dashboard.save();

  return { dashboardSubject: dashboard.subject, blocks, warnings };
}

/**
 * "sum of Amount" → an aggregate spec. A computed column is matched by its label
 * on the block's view, because that is the only place it is declared.
 */
function resolveMeasure(
  blockSpec: DashboardBlockSpec,
  map: TableColumnMap,
  view: Resource | undefined,
  warnings: string[],
): Record<string, string> | undefined {
  const measure = blockSpec.measure;

  if (!measure) {
    return undefined;
  }

  if (measure.function === 'count') {
    return { function: 'count' };
  }

  if (!measure.column) {
    warnings.push(
      `"${blockSpec.title}": ${measure.function} needs a column to measure.`,
    );

    return undefined;
  }

  const property = columnSubject(map, measure.column);

  if (property) {
    return { function: measure.function, property };
  }

  const derived = parseDerivedColumnSpecs(
    view?.get(dataBrowser.properties.viewDerivedColumns),
  ).find(
    column => column.label.toLowerCase() === measure.column?.toLowerCase(),
  );

  if (derived) {
    return { function: measure.function, derived: derived.id };
  }

  warnings.push(
    `"${blockSpec.title}": no column called "${measure.column}"${
      view ? ` on the table or computed by "${view.title}"` : ''
    }.`,
  );

  return undefined;
}
