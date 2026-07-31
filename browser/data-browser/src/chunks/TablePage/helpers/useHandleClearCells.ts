import { Collection, Datatype, useStore } from '@tomic/react';
import { useCallback } from 'react';
import { CellIndex } from '@chunks/TableEditor';
import {
  AddItemToHistoryStack,
  HistoryItemBatch,
  createValueChangedHistoryItem,
} from './useTableHistory';
import { transformToPropertiesPerSubject } from './transformPropertiesPerSubject';
import type { TableColumn } from '../useTableColumns';

export function useHandleClearCells(
  collection: Collection,
  addItemsToHistoryStack: AddItemToHistoryStack,
) {
  const store = useStore();

  return useCallback(
    async (cells: CellIndex<TableColumn>[]) => {
      const resourcePropMap = await transformToPropertiesPerSubject(
        cells,
        collection,
      );

      const historyItemBatch: HistoryItemBatch = [];

      const removePropvals = async ([subject, cols]: [
        string,
        TableColumn[],
      ]) => {
        const res = await store.getResource(subject);

        // Sequential on purpose: clearing several split cells of the SAME
        // LocalizedText property is a read-modify-write on one map — parallel
        // writes would race and resurrect cleared languages.
        for (const col of cols) {
          // Virtual columns (a duration, a row action) hold no stored value.
          if (!col.property) {
            continue;
          }

          const property = col.property;

          historyItemBatch.push(
            createValueChangedHistoryItem(res, property.subject),
          );

          if (
            col.languageTag !== undefined &&
            property.datatype === Datatype.LOCALIZEDTEXT
          ) {
            // Clear only this column's language; other languages stay.
            const existing = res.get(property.subject);
            const map =
              existing &&
              typeof existing === 'object' &&
              !Array.isArray(existing)
                ? { ...(existing as Record<string, string>) }
                : {};
            delete map[col.languageTag];
            await res.set(
              property.subject,
              Object.keys(map).length > 0 ? map : undefined,
              false,
            );
          } else {
            await res.set(property.subject, undefined, false);
          }
        }

        await res.save();
      };

      await Promise.all(
        Array.from(Object.entries(resourcePropMap)).map(removePropvals),
      );

      addItemsToHistoryStack(historyItemBatch);
    },
    [store, collection],
  );
}
