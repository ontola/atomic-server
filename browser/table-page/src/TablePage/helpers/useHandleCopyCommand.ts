import type { IndexedTableRows } from '@tomic/table';
import { Property, useStore } from '@tomic/react';
import { useCallback } from 'react';
import {
  CellIndex,
  CopyValue,
} from '@tomic/resource-ui/chunks/TableEditor/index';
import { getValuesFromSubject } from './clipboard.js';
import { transformToPropertiesPerSubject } from './transformPropertiesPerSubject.js';

export function useHandleCopyCommand(collection: IndexedTableRows) {
  const store = useStore();

  return useCallback(
    async (cells: CellIndex<Property>[]): Promise<CopyValue[][]> => {
      const propertiesPerSubject = await transformToPropertiesPerSubject(
        cells,
        collection,
      );

      const unresolvedValues = Array.from(
        Object.entries(propertiesPerSubject),
      ).map(([subject, props]) => getValuesFromSubject(subject, props, store));

      return Promise.all(unresolvedValues);
    },

    [collection, store],
  );
}
