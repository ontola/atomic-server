import {
  Datatype,
  Resource,
  useStore,
  Collection,
  commits,
} from '@tomic/react';
import { useCallback } from 'react';
import { CellPasteData } from '@chunks/TableEditor';
import { appendStringToType } from '../dataTypeMaps';
import type { TableColumn } from '../useTableColumns';
import { useSettings } from '../../../helpers/AppSettings';
import {
  HistoryItemBatch,
  createResourceCreatedHistoryItem,
  createValueChangedHistoryItem,
} from './useTableHistory';

export function useHandlePaste(
  table: Resource,
  collection: Collection,
  tableClass: Resource,
  invalidateCollection: () => void,
  addHistoryItemBatchToStack: (historyItemBatch: HistoryItemBatch) => void,
) {
  const store = useStore();
  const { contentLanguage } = useSettings();

  return useCallback(
    async (pasteData: CellPasteData<TableColumn>[]) => {
      const historyItemBatch: HistoryItemBatch = [];

      const resourceMemos = new Map<number, Resource>();
      let shouldInvalidate = false;

      for (const cell of pasteData) {
        let row = resourceMemos.get(cell.index[0]);

        if (!row) {
          let rowSubject: string | undefined;

          try {
            rowSubject = await collection.getMemberWithIndex(cell.index[0]);
          } catch (e) {
            // ignore
          }

          if (rowSubject) {
            row = await store.getResource(rowSubject);
          } else {
            // Row does not exist yet, create it
            shouldInvalidate = true;

            row = await store.newResource({
              isA: tableClass.subject,
              parent: table.subject,
              propVals: {
                [commits.properties.createdAt]: Date.now(),
              },
            });

            historyItemBatch.push(createResourceCreatedHistoryItem(row));
          }
        }

        const { property, languageTag } = cell.index[1];

        historyItemBatch.push(
          createValueChangedHistoryItem(row, property.subject),
        );

        let value;

        if (property.datatype === Datatype.LOCALIZEDTEXT) {
          // Paste replaces one language and keeps the rest of the map — the
          // split column's language, or the app's content language.
          const existing = row.get(property.subject);
          const map =
            existing && typeof existing === 'object' && !Array.isArray(existing)
              ? (existing as Record<string, string>)
              : {};
          value = { ...map, [languageTag ?? contentLanguage]: cell.data };
        } else {
          value = appendStringToType(undefined, cell.data, property.datatype);
        }

        await row.set(property.subject, value);
        await row.save();
        resourceMemos.set(cell.index[0], row);
      }

      addHistoryItemBatchToStack(historyItemBatch);

      if (shouldInvalidate) {
        invalidateCollection();
      }
    },
    [collection, invalidateCollection, store, contentLanguage],
  );
}
