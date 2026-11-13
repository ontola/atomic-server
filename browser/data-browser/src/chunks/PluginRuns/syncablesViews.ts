import { core, dataBrowser, type SchemaStore } from '@tomic/lib';

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
  const existing = table.get(dataBrowser.properties.tableViews);
  if (Array.isArray(existing) && existing.length > 0) {
    // A view created previously (or selected by the user) is never replaced.
    return;
  }

  const make = async (name: string, kind: string) => {
    const view = await store.newResource({
      parent: tableSubject,
      isA: [dataBrowser.classes.view],
      propVals: {
        [core.properties.name]: name,
        [dataBrowser.properties.viewKind]: kind,
      },
    });
    await view.save();
    return view.subject;
  };

  const standard = await make('Table', 'table');
  const sync = await make('Sync', 'syncables');
  await table.set(dataBrowser.properties.tableViews, [standard, sync]);
  await table.set(dataBrowser.properties.tableDefaultView, sync);
  await table.save();
}
