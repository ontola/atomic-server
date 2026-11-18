import {
  FancyTable as Table,
  TableHostProvider,
  type FancyTableProps,
} from '@tomic/table';
import { useHasControlLock } from '@tomic/ui/hooks/useControlLock';
import { Spinner } from '@tomic/resource-ui/components/Spinner';

/** Keep application focus/loading services outside the reusable table package. */
export function FancyTable<T>(props: FancyTableProps<T>) {
  const hasControlLock = useHasControlLock();

  return (
    <TableHostProvider
      value={{
        hasControlLock,
        LoadingIndicator: Spinner,
        rowMenuLabel: 'Row menu',
        openResourceLabel: 'Open resource',
      }}
    >
      <Table {...props} />
    </TableHostProvider>
  );
}
