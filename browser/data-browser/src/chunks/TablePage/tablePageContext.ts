import {
  unknownSubject,
  type AggregateFunction,
  type AggregateOutcome,
  type Property,
} from '@tomic/react';
import { createContext } from 'react';
import { TableSorting } from './tableSorting';
import { AddItemToHistoryStack } from './helpers/useTableHistory';
import { TableFilter, FilterOperator } from './tableFiltering';
import type { DerivedColumnSpec } from './derivedColumns';
import type { GroupGranularity, TableAggregate } from './tableAggregates';

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
  /**
   * Adds a property to the active view's visible columns. Needed after creating
   * one: `view-columns` treats anything it doesn't list as hidden, so a brand
   * new property would otherwise land on the class and never show up.
   */
  showColumn: (property: string) => void;
  /** LocalizedText properties currently split into one column per language. */
  splitLanguageSubjects: string[];
  /** Toggle split-by-language for a LocalizedText property. */
  toggleSplitLanguages: (property: string) => void;
  /** Every property of the row class — what a computed column's arguments pick from. */
  classProperties: Property[];
  /** The statistics this view shows, as configured. */
  aggregates: TableAggregate[];
  /** What the store computed for them, over every matching row. */
  aggregateOutcomes: AggregateOutcome[];
  /** Total rows the view matches — what the footer says on the left. */
  rowCount: number;
  /**
   * Sets (or clears, with `undefined`) the statistic shown under a column, in
   * the given totals row (the first one by default).
   */
  setColumnAggregate: (
    property: string,
    fn: AggregateFunction | undefined,
    row?: number,
  ) => void;
  /** Drops a whole totals row, moving the ones below it up. */
  removeAggregateRow: (row: number) => void;
  /** Whether the viewer may change the table's configuration. */
  canWriteTable: boolean;
  /** The property the totals are broken down by, if any. */
  breakdownColumn: string | undefined;
  /** How a date/timestamp breakdown column is bucketed. */
  breakdownGranularity: GroupGranularity;
  /** Sets the breakdown (an empty column clears it). */
  setBreakdown: (config: {
    groupByColumn: string;
    granularity: GroupGranularity;
  }) => void;
  /** Add a computed column to the active view. */
  addDerivedColumn: (spec: DerivedColumnSpec) => void;
  /** Replace a computed column (matched on its id) in the active view. */
  updateDerivedColumn: (spec: DerivedColumnSpec) => void;
  /** Drop a computed column from the active view. */
  removeDerivedColumn: (id: string) => void;
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
  showColumn: () => undefined,
  splitLanguageSubjects: [],
  toggleSplitLanguages: () => undefined,
  classProperties: [],
  aggregates: [],
  aggregateOutcomes: [],
  rowCount: 0,
  setColumnAggregate: () => undefined,
  removeAggregateRow: () => undefined,
  canWriteTable: false,
  breakdownColumn: undefined,
  breakdownGranularity: 'day',
  setBreakdown: () => undefined,
  addDerivedColumn: () => undefined,
  updateDerivedColumn: () => undefined,
  removeDerivedColumn: () => undefined,
  addItemsToHistoryStack: () => undefined,
});
