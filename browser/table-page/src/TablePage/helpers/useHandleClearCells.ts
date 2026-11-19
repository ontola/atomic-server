import {
  executeTableRowMutation,
  clearTableFields,
  type IndexedTableRows,
} from '@tomic/table';
import { Datatype, useStore, type Resource } from '@tomic/react';
import { useCallback } from 'react';
import type { CellIndex } from '@tomic/resource-ui/chunks/TableEditor/index';
import {
  type AddItemToHistoryStack,
  type HistoryItemBatch,
} from './useTableHistory.js';
import { transformToPropertiesPerSubject } from './transformPropertiesPerSubject.js';
import type { TableColumn } from '../useTableColumns.js';
import { atomicClearMutationBackend } from '../atomicClearMutation.js';

export function useHandleClearCells(
  table: Resource,
  tableClass: Resource,
  collection: IndexedTableRows,
  addItemsToHistoryStack: AddItemToHistoryStack,
) {
  const store = useStore();

  return useCallback(
    async (cells: CellIndex<TableColumn>[]) => {
      const groups = await transformToPropertiesPerSubject(cells, collection);
      const history: HistoryItemBatch = [];
      const backend = atomicClearMutationBackend(store, tableClass, history);
      await Promise.all(
        Object.entries(groups).map(async ([subject, columns]) => {
          const fields = columns.flatMap(column =>
            column.property
              ? [
                  {
                    id: column.property.subject,
                    language:
                      column.property.datatype === Datatype.LOCALIZEDTEXT
                        ? column.languageTag
                        : undefined,
                  },
                ]
              : [],
          );
          if (!fields.length) return;
          await executeTableRowMutation(
            {
              kind: 'update',
              target: {
                subject,
                scope: {
                  collection: table.subject,
                  rowClass: tableClass.subject,
                },
              },
              schemaRevision: backend.schema.revision,
              changes: current => clearTableFields(current, fields),
            },
            backend,
          );
        }),
      );
      addItemsToHistoryStack(history);
    },
    [store, table, tableClass, collection, addItemsToHistoryStack],
  );
}
