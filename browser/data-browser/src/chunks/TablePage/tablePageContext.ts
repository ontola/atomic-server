import { unknownSubject } from '@tomic/react';
import { createContext } from 'react';
import { TableSorting } from './tableSorting';
import { AddItemToHistoryStack } from './helpers/useTableHistory';
import { TableFilter, FilterOperator } from './tableFiltering';

export interface TablePageContextType {
  tableSubject: string;
  tableClassSubject: string;
  sorting: TableSorting;
  setSortBy: React.Dispatch<string>;
  filters: TableFilter[];
  addFilter: (property: string) => void;
  setFilterValue: (property: string, value: string) => void;
  setFilterOperator: (property: string, operator: FilterOperator) => void;
  removeFilter: (property: string) => void;
  hideColumn: (property: string) => void;
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
  filters: [],
  addFilter: () => undefined,
  setFilterValue: () => undefined,
  setFilterOperator: () => undefined,
  removeFilter: () => undefined,
  hideColumn: () => undefined,
  addItemsToHistoryStack: () => undefined,
});
