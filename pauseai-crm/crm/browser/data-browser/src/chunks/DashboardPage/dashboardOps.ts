import {
  core,
  dataBrowser,
  type AggregateFunction,
  type JSONValue,
  type Resource,
  type Store,
} from '@tomic/react';
import { readTableColumns, resolveView } from '../TablePage/tableOps';
import { parseDerivedColumnSpecs } from '../TablePage/derivedColumns';
import {
  measureKeepingTarget,
  staleOnTableChange,
  parseBlockAggregate,
  parseBlockChartSpec,
  parseLayout,
  type BlockPlacement,
} from './dashboardBlocks';

/**
 * A dashboard's blocks read back the way they were written: names, not subjects,
 * so an assistant can change one without a second lookup.
 */
export interface DescribedBlock {
  subject: string;
  kind: string;
  title: string;
  table?: string;
  view?: string;
  measure?: { function: string; column?: string };
  chartBy?: { column?: string; bucket?: string };
  text?: string;
  button?: JSONValue;
  width?: number;
}

export interface DescribedDashboard {
  subject: string;
  name: string;
  blocks: DescribedBlock[];
}

/** The name of a property or a view, for reading configuration back. */
async function nameOf(
  store: Store,
  subject: string | undefined,
): Promise<string | undefined> {
  if (!subject) {
    return undefined;
  }

  const resource = await store.getResource(subject);

  return resource.error ? subject : resource.title || subject;
}

export async function describeDashboard(
  store: Store,
  dashboard: Resource,
): Promise<DescribedDashboard> {
  const subjects =
    (dashboard.get(dataBrowser.properties.dashboardBlocks) as
      | string[]
      | undefined) ?? [];
  const layout = parseLayout(
    dashboard.get(dataBrowser.properties.dashboardLayout),
  );
  const widthBySubject = new Map(layout.map(p => [p.subject, p.w]));

  const blocks: DescribedBlock[] = [];

  for (const subject of subjects) {
    const block = await store.getResource(subject);

    if (block.error) {
      continue;
    }

    const source = block.get(dataBrowser.properties.blockSource) as
      | string
      | undefined;
    const view = block.get(dataBrowser.properties.blockView) as
      | string
      | undefined;
    const aggregate = parseBlockAggregate(
      block.get(dataBrowser.properties.blockAggregate),
    );
    const chart = parseBlockChartSpec(
      block.get(dataBrowser.properties.blockChartSpec),
    );
    const button = block.get(dataBrowser.properties.blockQuickAdd);

    // A computed column is named by its label on the view that declares it; a
    // stored one by its property name.
    let measuredColumn: string | undefined;

    if (aggregate?.derived && view) {
      const viewResource = await store.getResource(view);
      measuredColumn = parseDerivedColumnSpecs(
        viewResource.get(dataBrowser.properties.viewDerivedColumns),
      ).find(column => column.id === aggregate.derived)?.label;
    } else if (aggregate?.property) {
      measuredColumn = await nameOf(store, aggregate.property);
    }

    blocks.push({
      subject,
      kind:
        (block.get(dataBrowser.properties.blockKind) as string | undefined) ??
        'text',
      title: block.title,
      ...(source ? { table: source } : {}),
      ...(view ? { view: await nameOf(store, view) } : {}),
      ...(aggregate
        ? {
            measure: {
              function: aggregate.function,
              ...(measuredColumn ? { column: measuredColumn } : {}),
            },
          }
        : {}),
      ...(chart?.field
        ? {
            chartBy: {
              column: await nameOf(store, chart.field),
              bucket: chart.granularity ?? 'exact',
            },
          }
        : {}),
      ...(button !== undefined ? { button: button as JSONValue } : {}),
      ...(block.get(core.properties.description)
        ? {
            text: block.get(core.properties.description) as string,
          }
        : {}),
      ...(widthBySubject.has(subject)
        ? { width: widthBySubject.get(subject) }
        : {}),
    });
  }

  return {
    subject: dashboard.subject,
    name: dashboard.title,
    blocks,
  };
}

/** Finds a block of a dashboard by subject or by title. */
export async function resolveBlock(
  store: Store,
  dashboard: Resource,
  reference: string,
): Promise<Resource> {
  const subjects =
    (dashboard.get(dataBrowser.properties.dashboardBlocks) as
      | string[]
      | undefined) ?? [];

  if (subjects.includes(reference)) {
    return store.getResource(reference);
  }

  const titles: string[] = [];

  for (const subject of subjects) {
    const block = await store.getResource(subject);

    if (block.error) {
      continue;
    }

    if (block.title.toLowerCase() === reference.toLowerCase()) {
      return block;
    }

    titles.push(block.title);
  }

  throw new Error(
    `Unknown block "${reference}". This dashboard has: ${titles.join(', ')}`,
  );
}

export interface BlockConfigPatch {
  title?: string;
  table?: string;
  view?: string;
  measure?: { function: string; column?: string };
  chartBy?: { column: string; bucket?: 'exact' | 'day' | 'month' };
  text?: string;
  width?: number;
}

/**
 * Changes one block in place, touching only the fields it was given — the same
 * contract `configure_view` has, and for the same reason: setting a width must not
 * silently drop what the block measures.
 *
 * One deliberate exception: pointing the block at a *different* table also clears
 * the view, measure and chart column that named the old one. See
 * {@link staleOnTableChange}.
 */
export async function configureBlock(
  store: Store,
  dashboard: Resource,
  block: Resource,
  patch: BlockConfigPatch,
): Promise<void> {
  if (patch.title !== undefined) {
    await block.set(core.properties.name, patch.title, false);
  }

  if (patch.text !== undefined) {
    await block.set(core.properties.description, patch.text, false);
  }

  const previousSource = block.get(dataBrowser.properties.blockSource) as
    | string
    | undefined;

  if (patch.table !== undefined) {
    await block.set(dataBrowser.properties.blockSource, patch.table, false);
  }

  const source = block.get(dataBrowser.properties.blockSource) as
    | string
    | undefined;
  const table = source ? await store.getResource(source) : undefined;

  // Repointing at a different table invalidates everything that named a view or a
  // column of the old one. Dropped rather than carried: a measure over a property
  // the new class lacks answers nothing instead of erroring, so the block would go
  // quietly wrong. Anything this same patch replaces is left for the code below.
  if (patch.table !== undefined && patch.table !== previousSource) {
    const stale = staleOnTableChange({
      view: patch.view !== undefined,
      measure: patch.measure !== undefined,
      chart: patch.chartBy !== undefined,
    });

    for (const setting of stale) {
      if (setting === 'view') {
        block.remove(dataBrowser.properties.blockView);
      } else if (setting === 'measure') {
        block.remove(dataBrowser.properties.blockAggregate);
      } else {
        block.remove(dataBrowser.properties.blockChartSpec);
      }
    }
  }

  if (patch.view !== undefined && table) {
    const view = await resolveView(store, table, patch.view);
    await block.set(dataBrowser.properties.blockView, view.subject, false);
  }

  if ((patch.measure || patch.chartBy) && table) {
    const classSubject = table.get(core.properties.classtype) as
      | string
      | undefined;
    const map = classSubject
      ? await readTableColumns(store, await store.getResource(classSubject))
      : undefined;

    const resolve = (name: string): string | undefined =>
      map?.byName[name.toLowerCase()] ??
      map?.columns.find(
        column =>
          column.name.toLowerCase() === name.toLowerCase() ||
          column.subject === name,
      )?.subject;

    if (patch.measure) {
      const { function: fn, column } = patch.measure;

      if (fn === 'count' || !column) {
        // No column named: keep whatever this block already measures, so
        // "average instead of sum" needs only the function. Throws when there is
        // nothing to keep, rather than writing a spec every reader rejects.
        await block.set(
          dataBrowser.properties.blockAggregate,
          measureKeepingTarget(
            parseBlockAggregate(
              block.get(dataBrowser.properties.blockAggregate),
            ),
            fn as AggregateFunction,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ) as any,
        );
      } else {
        const property = resolve(column);
        const viewSubject = block.get(dataBrowser.properties.blockView) as
          | string
          | undefined;
        const derived = property
          ? undefined
          : parseDerivedColumnSpecs(
              viewSubject
                ? (await store.getResource(viewSubject)).get(
                    dataBrowser.properties.viewDerivedColumns,
                  )
                : undefined,
            ).find(spec => spec.label.toLowerCase() === column.toLowerCase());

        if (!property && !derived) {
          throw new Error(
            `No column called "${column}" on that table or computed by its view.`,
          );
        }

        await block.set(dataBrowser.properties.blockAggregate, {
          function: fn,
          ...(property ? { property } : { derived: derived?.id }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
      }
    }

    if (patch.chartBy) {
      const field = resolve(patch.chartBy.column);

      if (!field) {
        throw new Error(
          `No column called "${patch.chartBy.column}" to group by.`,
        );
      }

      await block.set(dataBrowser.properties.blockChartSpec, {
        mark: 'bar',
        field,
        granularity: patch.chartBy.bucket ?? 'exact',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }
  }

  await block.save();

  if (patch.width !== undefined) {
    const layout = parseLayout(
      dashboard.get(dataBrowser.properties.dashboardLayout),
    );
    const next: BlockPlacement[] = layout.filter(
      p => p.subject !== block.subject,
    );
    const existing = layout.find(p => p.subject === block.subject);

    next.push({
      subject: block.subject,
      w: Math.max(1, Math.min(12, patch.width)),
      h: existing?.h ?? 1,
    });

    await dashboard.set(
      dataBrowser.properties.dashboardLayout,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      next as any,
    );
    await dashboard.save();
  }
}
