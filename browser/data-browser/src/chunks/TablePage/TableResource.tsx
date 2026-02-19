import {
  unknownSubject,
  useCanWrite,
  useStore,
  type DataBrowser,
  type Property,
  type Resource,
} from '@tomic/react';
import { useHandleClearCells } from '@chunks/TablePage/helpers/useHandleClearCells';
import { useHandleColumnResize } from '@chunks/TablePage/helpers/useHandleColumnResize';
import { useHandleCopyCommand } from '@chunks/TablePage/helpers/useHandleCopyCommand';
import { useHandlePaste } from '@chunks/TablePage/helpers/useHandlePaste';
import {
  useTableHistory,
  createResourceDeletedHistoryItem,
} from '@chunks/TablePage/helpers/useTableHistory';
import {
  TablePageContext,
  type TablePageContextType,
} from '@chunks/TablePage/tablePageContext';
import { TableNewRow, TableRow } from '@chunks/TablePage/TableRow';
import { useTableColumns } from '@chunks/TablePage/useTableColumns';
import { useTableData } from '@chunks/TablePage/useTableData';
import { useId, useState, useCallback, useMemo } from 'react';
import { FancyTable } from '@chunks/TableEditor/TableEditor';
import { NewColumnButton } from './NewColumnButton';
import { TableHeading } from './TableHeading';
import { ExpandedRowDialog } from './ExpandedRowDialog';

interface TableResourceProps {
  resource: Resource<DataBrowser.Table>;
}

const columnToKey = (column: Property) => column.subject;

export const TableResource: React.FC<TableResourceProps> = ({ resource }) => {
  const store = useStore();
  const titleId = useId();
  const canWrite = useCanWrite(resource);

  const { tableClass, sorting, setSortBy, collection, invalidateCollection } =
    useTableData(resource);

  const { columns, reorderColumns } = useTableColumns(tableClass);

  const { undoLastItem, addItemsToHistoryStack } =
    useTableHistory(invalidateCollection);

  const handlePaste = useHandlePaste(
    resource,
    collection,
    tableClass,
    invalidateCollection,
    addItemsToHistoryStack,
  );

  const [showExpandedRowDialog, setShowExpandedRowDialog] = useState(false);
  const [expandedRowSubject, setExpandedRowSubject] = useState<string>();

  const handleRowExpand = useCallback(
    async (index: number) => {
      const row = await collection.getMemberWithIndex(index);
      setExpandedRowSubject(row);
      setShowExpandedRowDialog(true);
    },
    [collection],
  );

  const tablePageContext: TablePageContextType = useMemo(
    () => ({
      tableClassSubject: tableClass.subject,
      sorting,
      setSortBy,
      addItemsToHistoryStack,
    }),
    [tableClass, setSortBy, sorting, addItemsToHistoryStack],
  );

  const handleDeleteRow = useCallback(
    async (index: number) => {
      const row = await collection.getMemberWithIndex(index);

      if (!row) {
        return;
      }

      const rowResource = store.getResourceLoading(row);
      addItemsToHistoryStack(createResourceDeletedHistoryItem(rowResource));

      await rowResource.destroy();

      invalidateCollection();
    },
    [collection, store, invalidateCollection, addItemsToHistoryStack],
  );

  const handleClearCells = useHandleClearCells(
    collection,
    addItemsToHistoryStack,
  );

  const handleCopyCommand = useHandleCopyCommand(collection);

  const [columnSizes, handleColumnResize] = useHandleColumnResize(resource);

  const Row = useCallback(
    ({ index }: { index: number }) => {
      if (index < collection.totalMembers) {
        return (
          <TableRow collection={collection} index={index} columns={columns} />
        );
      }

      return (
        <TableNewRow
          parent={resource}
          columns={columns}
          index={index}
          invalidateTable={invalidateCollection}
        />
      );
    },

    // Resource can update a lot but its internals are stable so removing it from the array saves a lot of rerenders and shouldn't cause issues.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collection, columns, invalidateCollection, resource.subject],
  );

  return (
    <TablePageContext value={tablePageContext}>
      <FancyTable
        readOnly={!canWrite}
        columns={columns}
        columnSizes={columnSizes}
        itemCount={collection.totalMembers + 1}
        columnToKey={columnToKey}
        labelledBy={titleId}
        onClearRow={handleDeleteRow}
        onCellResize={handleColumnResize}
        onClearCells={handleClearCells}
        onCopyCommand={handleCopyCommand}
        onPasteCommand={handlePaste}
        onUndoCommand={undoLastItem}
        onColumnReorder={reorderColumns}
        onRowExpand={handleRowExpand}
        HeadingComponent={TableHeading}
        NewColumnButtonComponent={NewColumnButton}
      >
        {Row}
      </FancyTable>
      <ExpandedRowDialog
        subject={expandedRowSubject ?? unknownSubject}
        open={showExpandedRowDialog}
        bindOpen={setShowExpandedRowDialog}
      />
    </TablePageContext>
  );
};
