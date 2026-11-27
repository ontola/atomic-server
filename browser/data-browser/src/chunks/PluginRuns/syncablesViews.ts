import { core, dataBrowser, type SchemaStore } from '@tomic/lib';
import {
  appViewOf,
  normalizeViewKind,
} from '@tomic/table-page/TablePage/tableViewKinds';

const viewList = dataBrowser.properties.tableViews;
const defaultView = dataBrowser.properties.tableDefaultView;

function viewSubjects(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((subject): subject is string => typeof subject === 'string')
    : [];
}

/**
 * The built-in Syncables UI is a table view, not a provider-specific app.
 *
 * Preserve a normal Table tab so imported data remains usable without the
 * Syncables controls. This is an intentionally small host-side operation:
 * only trusted installation/provisioning code may add the built-in kind.
 */
export async function ensureSyncablesTableViews(
  store: SchemaStore,
  tableSubject: string,
): Promise<void> {
  const table = await store.getResource(tableSubject);
  const existing = viewSubjects(table.get(viewList));
  const kinds = await Promise.all(
    existing.map(async subject => {
      const view = await store.getResource(subject);
      const classes = view.get(core.properties.isA);
      if (
        !Array.isArray(classes) ||
        !classes.includes(dataBrowser.classes.view)
      )
        return undefined;
      const value = view.get(dataBrowser.properties.viewKind);
      const kind = typeof value === 'string' ? value : undefined;

      return appViewOf(kind) ? undefined : normalizeViewKind(kind);
    }),
  );

  const missing: string[] = [];

  const make = async (name: string, kind: 'table' | 'syncables') => {
    const view = await store.newResource({
      parent: tableSubject,
      isA: [dataBrowser.classes.view],
      propVals: {
        [core.properties.name]: name,
        [dataBrowser.properties.viewKind]: kind,
      },
    });
    await view.save();
    missing.push(view.subject);

    return view.subject;
  };

  if (!kinds.includes('table')) await make('Table', 'table');
  const sync = kinds.includes('syncables')
    ? undefined
    : await make('Sync', 'syncables');
  if (missing.length === 0) return;

  const current = viewSubjects(table.get(viewList));

  if (current.length > 0 && table.pushListItem) {
    for (const subject of missing) table.pushListItem(viewList, subject);
  } else {
    await table.set(viewList, [...current, ...missing]);
  }

  if (
    sync &&
    existing.length === 0 &&
    current.length === 0 &&
    !table.get(defaultView)
  )
    await table.set(defaultView, sync);
  await table.save();
}
