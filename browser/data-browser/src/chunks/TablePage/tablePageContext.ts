import { unknownSubject } from '@tomic/react';
import { createContext } from 'react';
import { TableSorting } from './tableSorting';
import { AddItemToHistoryStack } from './helpers/useTableHistory';

export interface TablePageContextType {
  tableSubject: string;
  tableClassSubject: string;
  sorting: TableSorting;
  setSortBy: React.Dispatch<string>;
  addItemsToHistoryStack: AddItemToHistoryStack;
}

export const TablePageContext = createContext<TablePageContextType>({
  tableSubject: unknownSubject,
  tableClassSubject: unknownSubject,
  sorting: {
    prop: '',
    sortDesc: true,
  },
  setSortBy: () => undefined,
  addItemsToHistoryStack: () => undefined,
});
