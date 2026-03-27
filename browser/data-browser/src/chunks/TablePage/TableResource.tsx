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
import { useId, useState, useCallback, useMemo, useRef } from 'react';
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

  const nextIdRef = useRef(0);
  const generateRowId = useCallback(() => {
    nextIdRef.current += 1;

    return `new-row-${nextIdRef.current}`;
  }, []);

  const [newRowIds, setNewRowIds] = useState<string[]>(() => [generateRowId()]);
  const prevTotalMembersRef = useRef(collection.totalMembers);

  // Synchronously adjust newRowIds when totalMembers changes.
  // Using useEffect would cause a one-render delay where keys are inconsistent,
  // leading to react-window recycling components with the wrong state.
  const totalMembersDiff = collection.totalMembers - prevTotalMembersRef.current;

  if (totalMembersDiff > 0) {
    prevTotalMembersRef.current = collection.totalMembers;
    const remaining = newRowIds.slice(totalMembersDiff);
    setNewRowIds(remaining.length > 0 ? remaining : [generateRowId()]);
  } else if (totalMembersDiff < 0) {
    prevTotalMembersRef.current = collection.totalMembers;
  }

  const addNewRow = useCallback(() => {
    setNewRowIds(prev => [...prev, generateRowId()]);
  }, [generateRowId]);

  const itemKey = useCallback(
    (index: number) => {
      if (index < collection.totalMembers) {
        return `member-${index}`;
      }

      const newRowIndex = index - collection.totalMembers;

      return newRowIds[newRowIndex] ?? `new-row-fallback-${index}`;
    },
    [collection.totalMembers, newRowIds],
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
      tableSubject: resource.subject,
      tableClassSubject: tableClass.subject,
      sorting,
      setSortBy,
      addItemsToHistoryStack,
    }),
    [
      resource.subject,
      tableClass.subject,
      sorting,
      setSortBy,
      addItemsToHistoryStack,
    ],
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
          addNewRow={addNewRow}
        />
      );
    },

    // Resource can update a lot but its internals are stable so removing it from the array saves a lot of rerenders and shouldn't cause issues.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collection, columns, invalidateCollection, resource.subject, addNewRow],
  );

  return (
    <TablePageContext value={tablePageContext}>
      <FancyTable
        readOnly={!canWrite}
        columns={columns}
        columnSizes={columnSizes}
        itemCount={collection.totalMembers + newRowIds.length}
        itemKey={itemKey}
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
