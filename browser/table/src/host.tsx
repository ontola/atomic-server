import {
  createContext,
  useContext,
  type ComponentType,
  type PropsWithChildren,
} from 'react';
import { Spinner } from './components/Spinner.js';

export interface TableHost {
  /** Prevent table shortcuts while the host owns focus (e.g. an open dialog). */
  hasControlLock: boolean;
  LoadingIndicator: ComponentType<{ size?: string }>;
}
const defaults: TableHost = {
  hasControlLock: false,
  LoadingIndicator: Spinner,
};
const TableHostContext = createContext(defaults);

export function TableHostProvider({
  value,
  children,
}: PropsWithChildren<{ value: Partial<TableHost> }>) {
  return (
    <TableHostContext.Provider value={{ ...defaults, ...value }}>
      {children}
    </TableHostContext.Provider>
  );
}
export const useTableHost = () => useContext(TableHostContext);
