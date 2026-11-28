import { createContext, type ComponentType, type ReactNode } from 'react';
import type { Collection, PropVal, Resource } from '@tomic/react';
import type { ViewKind } from './tableViewKinds.js';
import type { TableColumn } from './useTableColumns.js';

export interface TableTabs {
  views: string[];
  hidden: ReadonlySet<string>;
  activeView?: string;
}

/** Reordering displayed tabs must keep any views hidden by the host. */
export function retainHiddenViews(
  next: string[],
  previous: string[],
  hidden: ReadonlySet<string>,
): string[] {
  return [...next, ...previous.filter(subject => hidden.has(subject))];
}

export interface TableExtension {
  selectViews?: (options: {
    views: string[];
    requested?: string;
    explicit?: string;
    getView: (subject: string) => Resource;
  }) => TableTabs & { displayedView?: string };
  viewKind?: (kind: ViewKind) => ViewKind;
  rowScope?: (kind: ViewKind) => {
    property: string;
    filters: PropVal[];
    ready: boolean;
  };
  error?: string;
  columns?: TableColumn[];
  builtinKinds?: ViewKind[];
  refreshViews?: () => void;
  renderToolbar?: (options: {
    kind: ViewKind;
    tableView: boolean;
    empty: boolean;
  }) => ReactNode;
  renderView?: (options: {
    kind: ViewKind;
    collection: Collection;
    ready: boolean;
  }) => ReactNode;
}

/** The host can add table behavior without coupling the shared package to an app. */
export const TableExtensionContext = createContext<
  | ComponentType<{
      table: Resource;
      embedded: boolean;
      children: (extension: TableExtension) => ReactNode;
    }>
  | undefined
>(undefined);
