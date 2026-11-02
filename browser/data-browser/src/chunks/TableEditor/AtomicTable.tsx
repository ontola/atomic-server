import {
  FancyTable as Table,
  TableHostProvider,
  type FancyTableProps,
} from '@tomic/table';
import { useHasControlLock } from '../../hooks/useControlLock';
import { Spinner } from '../../components/Spinner';

/** Keep application focus/loading services outside the reusable table package. */
export function FancyTable<T>(props: FancyTableProps<T>) {
  const hasControlLock = useHasControlLock();

  return (
    <TableHostProvider value={{ hasControlLock, LoadingIndicator: Spinner }}>
      <Table {...props} />
    </TableHostProvider>
  );
}
