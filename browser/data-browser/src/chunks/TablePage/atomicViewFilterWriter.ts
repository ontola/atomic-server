import { core, type Resource } from '@tomic/react';
import {
  assertTableViewOwner,
  createTableViewDraftSession,
  createTableViewWriteQueue,
  type TableViewSave,
  type TableViewSource,
} from '@tomic/table';
import {
  atomicViewFilterSource,
  readAtomicTableViewConfiguration,
  writeAtomicTableViewConfiguration,
  type AtomicViewFilterDraft,
} from './atomicViewConfiguration';

/** Ordered automatic persistence with immutable retry snapshots. Once a save
 * completes, edits made during it are drained even if the page has navigated
 * away. Nothing retries a failed backend write without explicit queue Retry. */
export function enqueueAtomicViewFilters({
  session,
  writes,
  scope,
  source,
  table,
  ensureView,
}: {
  session: ReturnType<
    typeof createTableViewDraftSession<AtomicViewFilterDraft>
  >;
  writes: ReturnType<typeof createTableViewWriteQueue>;
  scope: string;
  source: TableViewSource<AtomicViewFilterDraft>;
  table: Resource;
  ensureView: () => Promise<Resource | undefined>;
}) {
  const draft = session.getSnapshot().drafts.get(scope);
  if (!draft || session.read(scope, source).saving) return;
  const draftId = draft.id;
  let save: TableViewSave<AtomicViewFilterDraft> | undefined;
  let currentScope = scope;
  let currentSource = source;
  let view: Resource | undefined;
  void writes.enqueue(async () => {
    while (true) {
      if (save) {
        if (!session.resume(save)) return;
      } else {
        const entry = [...session.getSnapshot().drafts].find(
          ([, value]) => value.id === draftId,
        );
        if (!entry) return;
        currentScope = entry[0];
        save = session.begin(currentScope, currentSource);
        if (!save) return;
      }

      try {
        view ??= await ensureView();
        if (!view) throw Error('Saved view is unavailable in this table.');
        assertTableViewOwner(
          { table: table.subject },
          { table: view.get(core.properties.parent) as string },
        );
        await writeAtomicTableViewConfiguration(view, {
          filters: save.value.filters,
          sortBy: save.value.sorting.prop,
          sortDesc: save.value.sorting.sortDesc,
        });
        await view.save();
        currentSource = atomicViewFilterSource(
          readAtomicTableViewConfiguration(view).config,
        );
        currentScope = JSON.stringify([table.subject, view.subject]);
        session.finish(save, currentSource, currentScope);
        save = undefined;
        const remaining = session.getSnapshot().drafts.get(currentScope);
        if (!remaining) return;

        if (
          JSON.stringify(remaining.value) ===
          JSON.stringify(currentSource.value)
        ) {
          session.discard(currentScope);

          return;
        }
      } catch (error) {
        if (save) session.fail(save, error);
        throw error;
      }
    }
  });
}
